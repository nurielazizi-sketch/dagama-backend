/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { sendVerificationEmail } from './email';
import { getChannelAdapter } from './channel';

// ─────────────────────────────────────────────────────────────────────────────
// Web chat HTTP surface (Sprint 2 phase 4).
//
// Flow (locked Day-1 architecture):
//   1. Visitor clicks the floating chat bubble on a marketing page.
//   2. Modal: "Drop your email to start" — email gate activates the free tier.
//   3. POST /api/chat/start { email, role } → creates user (PENDING password)
//      + issues onboarding_token + sends verification email + creates
//      web_chat_sessions row + creates `passes` row (kind=free_24h, pending)
//      → returns { session_token }.
//   4. Frontend stores session_token in localStorage.
//   5. POST /api/chat/message — sends user input. First message kicks the
//      24h clock (passes.started_at = NOW(), expires_at = NOW() + 24h).
//   6. Bot brain processes inbound; outbound rows land in web_chat_messages.
//   7. GET /api/chat/poll?since=<id> long-polls for new outbound rows.
//
// Auth model: session_token is a long opaque string stored on
// web_chat_sessions.session_token (UNIQUE). It serves the same role as a JWT
// for chat-only operations — chat works WITHOUT a password (whole point of
// the email gate). The user only needs a JWT (full account) to access the
// dashboard, set up cross-channel switching, etc.
// ─────────────────────────────────────────────────────────────────────────────

const PASS_FREE_24H_HOURS = 24;
const PENDING_PASSWORD_PREFIX = 'PENDING:';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function generateToken(): string {
  // 32 bytes hex = 64-char string. Long enough for collision resistance,
  // short enough to fit in a URL or localStorage key cleanly.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ── POST /api/chat/start ────────────────────────────────────────────────────
// Body: { email, role: 'boothbot' | 'sourcebot' }
// Returns: { session_token, expires_in_hours: 24 }

export async function handleChatStart(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { email?: string; role?: string };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const email = (body.email ?? '').trim().toLowerCase();
  const role  = body.role === 'sourcebot' ? 'sourcebot' : 'boothbot';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Valid email is required' }, 400);
  }

  // Find or create user (same logic as /api/auth/register).
  const existing = await env.DB
    .prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; password_hash: string | null }>();

  let userId: string;
  let needsVerificationEmail = false;
  if (existing) {
    userId = existing.id;
    if (!existing.password_hash || existing.password_hash.startsWith(PENDING_PASSWORD_PREFIX)) {
      needsVerificationEmail = true;            // still pre-activation, re-send the email
    }
  } else {
    const placeholderName = email.split('@')[0] || 'User';
    const placeholderHash = `${PENDING_PASSWORD_PREFIX}${crypto.randomUUID()}`;
    const inserted = await env.DB
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id')
      .bind(email, placeholderName, placeholderHash)
      .first<{ id: string }>();
    if (!inserted?.id) return jsonResponse({ error: 'Failed to create user' }, 500);
    userId = inserted.id;
    needsVerificationEmail = true;
  }

  // Issue onboarding_token + send verification email — fire-and-forget so
  // the chat opens immediately even if email service is slow. Email contains
  // the cross-channel deep-links (WA + TG + activate-password) for users who
  // want to switch off the web channel later.
  if (needsVerificationEmail) {
    const onboardingToken = crypto.randomUUID().replace(/-/g, '');
    const ONBOARDING_TOKEN_TTL_S = 60 * 60 * 24 * 14;
    const expiresAt = Math.floor(Date.now() / 1000) + ONBOARDING_TOKEN_TTL_S;
    await env.DB
      .prepare(`INSERT INTO onboarding_tokens (token, user_id, bot_role, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(onboardingToken, userId, role, expiresAt)
      .run();

    sendVerificationEmail({ to: email, token: onboardingToken, role: role as 'boothbot' | 'sourcebot' }, env)
      .catch(e => console.error('[chat/start] verification email failed (non-fatal)', e));
  }

  // Create the web chat session.
  const sessionToken = generateToken();
  const session = await env.DB
    .prepare(`
      INSERT INTO web_chat_sessions (user_id, bot_role, session_token)
      VALUES (?, ?, ?)
      RETURNING id
    `)
    .bind(userId, role, sessionToken)
    .first<{ id: string }>();
  if (!session?.id) return jsonResponse({ error: 'Failed to create chat session' }, 500);

  // Create the free 24h pass — pending until first message.
  await env.DB
    .prepare(`
      INSERT INTO passes (user_id, kind, bot_role, status)
      VALUES (?, 'free_24h', ?, 'pending')
    `)
    .bind(userId, role)
    .run();

  // Send a system "welcome" message into the session so the user sees activity
  // immediately when the widget opens. This is the first thing the polling
  // frontend will pull on /api/chat/poll.
  const adapter = getChannelAdapter({ channel: 'web', recipient: session.id }, env);
  const productName = role === 'boothbot' ? 'BoothBot' : 'SourceBot';
  await adapter.sendText(
    `Welcome to ${productName}! Your 24-hour free trial starts when you send your first message. Send "hi" to get going.`
  );

  return jsonResponse({
    session_token:    sessionToken,
    bot_role:         role,
    expires_in_hours: PASS_FREE_24H_HOURS,
  }, 200);
}

// ── POST /api/chat/message ──────────────────────────────────────────────────
// Body: { session_token, text?, dedupe_key? }
// (Image/voice will land later — text-only for v1 widget MVP.)

export async function handleChatMessage(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { session_token?: string; text?: string; dedupe_key?: string };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const sessionToken = (body.session_token ?? '').trim();
  const text         = (body.text ?? '').trim();
  if (!sessionToken) return jsonResponse({ error: 'session_token is required' }, 400);
  if (!text)         return jsonResponse({ error: 'text is required' }, 400);

  // Resolve session.
  const session = await env.DB
    .prepare(`
      SELECT s.id, s.user_id, s.bot_role, s.active_pass_id
        FROM web_chat_sessions s
       WHERE s.session_token = ? AND s.ended_at IS NULL
       LIMIT 1
    `)
    .bind(sessionToken)
    .first<{ id: string; user_id: string; bot_role: string; active_pass_id: string | null }>();
  if (!session) return jsonResponse({ error: 'Invalid or ended session' }, 401);

  // Find the user's active free_24h pass; if pending, kick the clock.
  // Hard-cut policy on expiry (locked decision): expired pass = no further
  // bot processing, just a reply telling them to upgrade.
  const passOk = await activatePassIfNeeded(session.user_id, session.bot_role, env);
  if (!passOk.allowed) {
    // Write the inbound row regardless (audit trail), then write a system
    // outbound nudging upgrade.
    await insertInbound(session.id, text, body.dedupe_key, env);
    const adapter = getChannelAdapter({ channel: 'web', recipient: session.id }, env);
    await adapter.sendText(
      `Your 24-hour free trial ended. Grab a 96-hour show pass to keep going — ExpenseBot stays included.`
    );
    return jsonResponse({ ok: true, status: 'trial_expired' }, 200);
  }

  // Write the inbound row.
  const inbound = await insertInbound(session.id, text, body.dedupe_key, env);
  if (!inbound.ok)              return jsonResponse({ error: 'Failed to record message' }, 500);
  if (inbound.duplicate)        return jsonResponse({ ok: true, status: 'duplicate_ignored' }, 200);

  // Bot brain dispatch happens in Sprint 2 phase 6 (refactor onto adapter).
  // For v1 MVP we send a placeholder ack so the widget round-trip works
  // end-to-end. After phase 6, this is replaced by routeToBoothBot/SourceBot.
  const adapter = getChannelAdapter({ channel: 'web', recipient: session.id }, env);
  await adapter.sendText(
    `Got it: "${text.slice(0, 200)}". (Brain dispatch lands in the next sprint — your trial clock is running.)`
  );

  return jsonResponse({ ok: true, status: 'received' }, 200);
}

// ── GET /api/chat/poll?session_token=X&since=<message_id> ────────────────────
// Returns: { messages: [{id, kind, text, buttons?, media_url?, created_at}], next_since }

export async function handleChatPoll(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(request.url);
  const sessionToken = (url.searchParams.get('session_token') ?? '').trim();
  const since        = (url.searchParams.get('since')         ?? '').trim();   // last seen message id (TEXT)
  if (!sessionToken) return jsonResponse({ error: 'session_token is required' }, 400);

  const session = await env.DB
    .prepare(`SELECT id FROM web_chat_sessions WHERE session_token = ? AND ended_at IS NULL LIMIT 1`)
    .bind(sessionToken)
    .first<{ id: string }>();
  if (!session) return jsonResponse({ error: 'Invalid or ended session' }, 401);

  // Pull outbound messages newer than `since`. We use created_at + id as the
  // ordering pair to stay correct under high concurrency. For v1, ordering by
  // created_at is sufficient since outbound writes are sequential per session.
  const sinceClause = since
    ? `AND created_at > (SELECT created_at FROM web_chat_messages WHERE id = ?)`
    : '';
  const sql = `
    SELECT id, kind, text, media_r2_key, buttons_json, created_at
      FROM web_chat_messages
     WHERE session_id = ?
       AND direction = 'outbound'
       ${sinceClause}
     ORDER BY created_at ASC
     LIMIT 50
  `;
  const stmt = since
    ? env.DB.prepare(sql).bind(session.id, since)
    : env.DB.prepare(sql).bind(session.id);
  const rows = await stmt.all<{
    id: string; kind: string; text: string | null;
    media_r2_key: string | null; buttons_json: string | null; created_at: string;
  }>();

  const messages = rows.results.map(r => {
    let textOut: string | null = r.text;
    let mediaUrl: string | null = null;
    let caption: string | null = null;
    // Image rows store {url, caption} JSON in text.
    if (r.kind === 'image' && r.text) {
      try {
        const parsed = JSON.parse(r.text) as { url?: string; caption?: string };
        mediaUrl = parsed.url ?? null;
        caption  = parsed.caption ?? null;
        textOut  = null;
      } catch { /* leave as raw text */ }
    }
    return {
      id:         r.id,
      kind:       r.kind,
      text:       textOut,
      media_url:  mediaUrl,
      caption,
      buttons:    r.buttons_json ? JSON.parse(r.buttons_json) : null,
      created_at: r.created_at,
    };
  });

  const nextSince = messages.length > 0 ? messages[messages.length - 1].id : since;
  return jsonResponse({ messages, next_since: nextSince }, 200);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function insertInbound(
  sessionId:  string,
  text:       string,
  dedupeKey:  string | undefined,
  env:        Env,
): Promise<{ ok: true; duplicate?: boolean } | { ok: false }> {
  try {
    await env.DB
      .prepare(`
        INSERT INTO web_chat_messages (session_id, direction, kind, text, client_dedupe_key, produced_by)
        VALUES (?, 'inbound', 'text', ?, ?, 'web_chat_endpoint')
      `)
      .bind(sessionId, text, dedupeKey ?? null)
      .run();
    await env.DB
      .prepare(`UPDATE web_chat_sessions SET last_inbound_at = datetime('now') WHERE id = ?`)
      .bind(sessionId)
      .run();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && dedupeKey) return { ok: true, duplicate: true };
    console.error('[web_chat] inbound insert failed', { sessionId, error: msg });
    return { ok: false };
  }
}

/**
 * Find the user's most-recent free_24h pass (or any active paid pass).
 * If pending → activate (start the 24h clock now).
 * If active and not expired → allowed.
 * If expired → not allowed; flag for 8am email scheduling.
 */
async function activatePassIfNeeded(
  userId:   string,
  botRole:  string,
  env:      Env,
): Promise<{ allowed: boolean }> {
  // Find an active or pending free_24h pass for this user/bot.
  const pass = await env.DB
    .prepare(`
      SELECT id, status, started_at, expires_at
        FROM passes
       WHERE user_id = ? AND bot_role = ? AND kind = 'free_24h'
         AND status IN ('pending', 'active')
       ORDER BY created_at DESC
       LIMIT 1
    `)
    .bind(userId, botRole)
    .first<{ id: string; status: string; started_at: string | null; expires_at: string | null }>();

  if (!pass) {
    // No pending or active free pass. Check for any paid pass (subscriptions).
    // For v1 web chat MVP we just deny — paid-pass integration in phase 5.
    return { allowed: false };
  }

  if (pass.status === 'pending') {
    // First message — kick the clock.
    await env.DB
      .prepare(`
        UPDATE passes
           SET status = 'active',
               started_at = datetime('now'),
               expires_at = datetime('now', '+${PASS_FREE_24H_HOURS} hours'),
               activated_at = datetime('now'),
               updated_at = datetime('now')
         WHERE id = ?
      `)
      .bind(pass.id)
      .run();
    return { allowed: true };
  }

  // status === 'active' — check expiry.
  if (pass.expires_at && pass.expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19)) {
    // Expired. Mark it.
    await env.DB
      .prepare(`UPDATE passes SET status = 'expired', expired_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .bind(pass.id)
      .run();
    return { allowed: false };
  }

  return { allowed: true };
}

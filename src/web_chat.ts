/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { sendVerificationEmail } from './email';
import { getChannelAdapter } from './channel';
import {
  welcomeMessage,
  textReceivedAck,
  imageReceivedAck,
  voiceReceivedAck,
  trialExpiredMessage,
  dispatchBotMessage,
  type BotRole,
} from './bot_copy';

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

  // Send the canonical welcome message — same wording + same menu as the
  // Telegram bot's /start handler, sourced from bot_copy.ts. The user sees
  // an actionable menu (Capture, My leads, Sheet) instead of a flat blurb,
  // matching the experience on TG/WA.
  const adapter = getChannelAdapter({ channel: 'web', recipient: session.id }, env);
  await dispatchBotMessage(adapter, welcomeMessage(role as BotRole));
  // Note: web users don't have firstName / gmailStatus / sheetUrl yet at this
  // gate (they just dropped an email). TG/WA pass those when they have them.

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
    // Write the inbound row regardless (audit trail), then dispatch the
    // canonical trial-expired message (same wording on TG / WA / web).
    await insertInbound(session.id, text, body.dedupe_key, env);
    const adapter = getChannelAdapter({ channel: 'web', recipient: session.id }, env);
    await dispatchBotMessage(adapter, trialExpiredMessage(session.bot_role as BotRole));
    return jsonResponse({ ok: true, status: 'trial_expired' }, 200);
  }

  // Write the inbound row.
  const inbound = await insertInbound(session.id, text, body.dedupe_key, env);
  if (!inbound.ok)              return jsonResponse({ error: 'Failed to record message' }, 500);
  if (inbound.duplicate)        return jsonResponse({ ok: true, status: 'duplicate_ignored' }, 200);

  // Bot brain dispatch happens in Sprint 2 phase 6 (refactor onto adapter).
  // For v1 MVP we send the canonical "got it" ack from bot_copy.ts so the
  // wording matches TG / WA exactly. Once phase 6 ships this is replaced by
  // routeToBoothBot/SourceBot which run the real LLM extraction.
  const adapter = getChannelAdapter({ channel: 'web', recipient: session.id }, env);
  await dispatchBotMessage(adapter, textReceivedAck(session.bot_role as BotRole));

  return jsonResponse({ ok: true, status: 'received' }, 200);
}


// ── POST /api/chat/upload ────────────────────────────────────────────────────
// multipart/form-data:
//   session_token (text)
//   kind          ('image' | 'voice')
//   file          (binary)
//   dedupe_key?   (text)
//   caption?      (text — only meaningful for image)
//
// Stores the blob in R2 at `web-chat/<session_id>/<rand>.<ext>`, inserts an
// inbound row with kind=image|voice + media_r2_key, sends a role-aware ack
// outbound so the user gets immediate feedback.

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;   // 6 MB — matches app_config card_image_max_kb
const MAX_VOICE_BYTES = 12 * 1024 * 1024;  // ~3 min at opus 64kbps

export async function handleChatUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let form: FormData;
  try { form = await request.formData(); }
  catch { return jsonResponse({ error: 'Invalid form data' }, 400); }

  const sessionToken = String(form.get('session_token') ?? '').trim();
  const kindRaw      = String(form.get('kind') ?? '').trim();
  const dedupeKey    = String(form.get('dedupe_key') ?? '').trim() || null;
  const caption      = String(form.get('caption') ?? '').trim() || null;
  const file         = form.get('file');

  if (!sessionToken)                 return jsonResponse({ error: 'session_token is required' }, 400);
  if (kindRaw !== 'image' && kindRaw !== 'voice')
                                     return jsonResponse({ error: 'kind must be image or voice' }, 400);
  // FormData entries that came from a binary part are Blob-like (have .size +
  // .arrayBuffer + .type). Workers runtime exposes them as Blob/File but the
  // TS lib doesn't always include `File` — a duck-typed Blob check is enough.
  if (!file || typeof file === 'string' || !('arrayBuffer' in (file as object))) {
    return jsonResponse({ error: 'file is required' }, 400);
  }
  const blob = file as Blob & { type?: string; name?: string };

  const kind: 'image' | 'voice' = kindRaw;
  const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VOICE_BYTES;
  if (blob.size > maxBytes)          return jsonResponse({ error: `File too large (max ${maxBytes / 1024 / 1024}MB)` }, 413);
  if (blob.size === 0)               return jsonResponse({ error: 'Empty file' }, 400);

  const session = await env.DB
    .prepare(`
      SELECT s.id, s.user_id, s.bot_role
        FROM web_chat_sessions s
       WHERE s.session_token = ? AND s.ended_at IS NULL
       LIMIT 1
    `)
    .bind(sessionToken)
    .first<{ id: string; user_id: string; bot_role: string }>();
  if (!session) return jsonResponse({ error: 'Invalid or ended session' }, 401);

  // Same hard-cut policy as /api/chat/message.
  const passOk = await activatePassIfNeeded(session.user_id, session.bot_role, env);
  if (!passOk.allowed) {
    const adapter = getChannelAdapter({ channel: 'web', recipient: session.id }, env);
    await dispatchBotMessage(adapter, trialExpiredMessage(session.bot_role as BotRole));
    return jsonResponse({ ok: true, status: 'trial_expired' }, 200);
  }

  // Choose extension from MIME (best-effort — falls back to bin).
  const mime = blob.type ?? '';
  const ext = pickExtension(mime, kind);
  const rand = generateToken().slice(0, 16);
  const r2Key = `web-chat/${session.id}/${Date.now()}-${rand}.${ext}`;
  try {
    await env.R2_BUCKET.put(r2Key, await blob.arrayBuffer(), {
      httpMetadata: { contentType: mime || (kind === 'image' ? 'application/octet-stream' : 'audio/webm') },
    });
  } catch (e) {
    console.error('[chat/upload] R2 put failed', e);
    return jsonResponse({ error: 'Storage failed' }, 500);
  }

  // Insert inbound row. text holds caption (for image) or NULL (for voice).
  try {
    await env.DB
      .prepare(`
        INSERT INTO web_chat_messages
          (session_id, direction, kind, text, media_r2_key, client_dedupe_key, produced_by)
        VALUES (?, 'inbound', ?, ?, ?, ?, 'web_chat_endpoint')
      `)
      .bind(session.id, kind, caption, r2Key, dedupeKey)
      .run();
    await env.DB
      .prepare(`UPDATE web_chat_sessions SET last_inbound_at = datetime('now') WHERE id = ?`)
      .bind(session.id)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && dedupeKey) {
      return jsonResponse({ ok: true, status: 'duplicate_ignored' }, 200);
    }
    console.error('[chat/upload] inbound insert failed', { sessionId: session.id, error: msg });
    return jsonResponse({ error: 'Failed to record message' }, 500);
  }

  // Canonical media ack from bot_copy.ts — same wording + same menu on TG/WA/web.
  const adapter = getChannelAdapter({ channel: 'web', recipient: session.id }, env);
  const ack = kind === 'image'
    ? imageReceivedAck(session.bot_role as BotRole)
    : voiceReceivedAck(session.bot_role as BotRole);
  await dispatchBotMessage(adapter, ack);

  return jsonResponse({ ok: true, status: 'received', kind, r2_key: r2Key }, 200);
}

// ── GET /api/chat/media?session_token=X&key=web-chat/<sid>/<file> ────────────
// Streams an R2 object back. Auth-gates by:
//   1. session_token matches a live web_chat_session,
//   2. requested key starts with `web-chat/<that_session_id>/`.
// This stops a leaked key from being read with someone else's token, and also
// stops a session token from grabbing a key under another session's prefix.

export async function handleChatMedia(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(request.url);
  const sessionToken = (url.searchParams.get('session_token') ?? '').trim();
  const key          = (url.searchParams.get('key')           ?? '').trim();
  if (!sessionToken) return jsonResponse({ error: 'session_token is required' }, 400);
  if (!key)          return jsonResponse({ error: 'key is required' }, 400);

  const session = await env.DB
    .prepare(`SELECT id FROM web_chat_sessions WHERE session_token = ? AND ended_at IS NULL LIMIT 1`)
    .bind(sessionToken)
    .first<{ id: string }>();
  if (!session) return jsonResponse({ error: 'Invalid or ended session' }, 401);

  if (!key.startsWith(`web-chat/${session.id}/`)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Cache-Control', 'private, max-age=300');
  return new Response(obj.body, { status: 200, headers });
}

function pickExtension(mime: string, kind: 'image' | 'voice'): string {
  if (kind === 'image') {
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('png'))  return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('heic') || mime.includes('heif')) return 'heic';
    return 'jpg';
  }
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('wav'))  return 'wav';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  return 'webm';
}


// ── GET /api/chat/poll?session_token=X&since=<message_id> ────────────────────
// Returns: { messages: [{id, kind, text, buttons?, media_url?, created_at}], next_since }

export async function handleChatPoll(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(request.url);
  const sessionToken = (url.searchParams.get('session_token') ?? '').trim();
  const since        = (url.searchParams.get('since')         ?? '').trim();   // last seen message id (TEXT)
  const apiOrigin    = `${url.protocol}//${url.host}`;
  if (!sessionToken) return jsonResponse({ error: 'session_token is required' }, 400);

  const session = await env.DB
    .prepare(`SELECT id FROM web_chat_sessions WHERE session_token = ? AND ended_at IS NULL LIMIT 1`)
    .bind(sessionToken)
    .first<{ id: string }>();
  if (!session) return jsonResponse({ error: 'Invalid or ended session' }, 401);

  // Pull both inbound + outbound messages newer than `since`. Inbound rows
  // matter because the user's own uploads (images, voice notes) only land
  // server-side after /api/chat/upload; the widget renders them optimistically
  // with a blob URL but loses that on reload, so we have to ship them via
  // poll. The widget reconciles pending optimistic entries by client_dedupe_key.
  const sinceClause = since
    ? `AND created_at > (SELECT created_at FROM web_chat_messages WHERE id = ?)`
    : '';
  const sql = `
    SELECT id, direction, kind, text, media_r2_key, buttons_json, client_dedupe_key, created_at
      FROM web_chat_messages
     WHERE session_id = ?
       ${sinceClause}
     ORDER BY created_at ASC
     LIMIT 50
  `;
  const stmt = since
    ? env.DB.prepare(sql).bind(session.id, since)
    : env.DB.prepare(sql).bind(session.id);
  const rows = await stmt.all<{
    id: string; direction: string; kind: string; text: string | null;
    media_r2_key: string | null; buttons_json: string | null;
    client_dedupe_key: string | null; created_at: string;
  }>();

  const messages = rows.results.map(r => {
    let textOut:  string | null = r.text;
    let mediaUrl: string | null = null;
    let caption:  string | null = null;
    // Bot-side image rows can carry the URL in two ways:
    //   (a) {url, caption} JSON stored in `text` — used when bot links to an
    //       externally hosted asset (e.g. the buyer card preview).
    //   (b) `media_r2_key` populated — bot wrote the asset to R2 directly.
    //       Convert to a tokenized /api/chat/media URL the widget can fetch.
    if (r.kind === 'image' || r.kind === 'voice') {
      if (r.text) {
        try {
          const parsed = JSON.parse(r.text) as { url?: string; caption?: string };
          if (parsed.url) {
            mediaUrl = parsed.url;
            caption  = parsed.caption ?? null;
            textOut  = null;
          }
        } catch { /* leave as raw text */ }
      }
      if (!mediaUrl && r.media_r2_key) {
        const tok = encodeURIComponent(sessionToken);
        const key = encodeURIComponent(r.media_r2_key);
        // Absolute URL — the widget reads this from a different origin.
        mediaUrl  = `${apiOrigin}/api/chat/media?session_token=${tok}&key=${key}`;
        caption   = r.text;
        textOut   = null;
      }
    }
    return {
      id:                r.id,
      direction:         r.direction,
      kind:              r.kind,
      text:              textOut,
      media_url:         mediaUrl,
      caption,
      buttons:           r.buttons_json ? JSON.parse(r.buttons_json) : null,
      client_dedupe_key: r.client_dedupe_key,
      created_at:        r.created_at,
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

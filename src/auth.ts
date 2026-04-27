/// <reference types="@cloudflare/workers-types" />

import { hashPassword, verifyPassword, signJwt, verifyJwt } from './crypto';
import { ask, buildSummaryPrompt } from './gemini';
import { sendVerificationEmail } from './email';
import { verifyTurnstile } from './turnstile';
import type { Env } from './types';

interface User {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  created_at: string;
}

const JWT_TTL_SECONDS         = 60 * 60 * 24 * 7;     // 7 days
const ONBOARDING_TOKEN_TTL_S  = 60 * 60 * 24 * 14;    // 14 days — generous; token is one-shot anyway
// Sentinel prefix for users who registered email-only and haven't activated.
// Login rejects any password_hash starting with this prefix; activation
// overwrites it with a real bcrypt hash.
const PENDING_PASSWORD_PREFIX = 'PENDING:';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── /api/auth/register ──────────────────────────────────────────────────────
// Email-only signup (Day-1 architecture).
// 1. Insert (or find) a users row with a PENDING: sentinel password_hash.
// 2. Issue an onboarding_tokens row (one token, redeemable on whichever
//    channel the user clicks first — WA, TG, or web /activate).
// 3. Send the verification email via Resend with the 3 functional deep-links.
// 4. Return 200 with { sent: true }.
//
// Re-submission flow: if the email already has a PENDING user, reuse it and
// issue a fresh token (old tokens stay valid until expiry — first-redeemed wins).
// If the email already has a fully-activated user (real password_hash), don't
// create a new pending token; tell the client to go to /login.

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { email?: string; role?: string; cf_turnstile_response?: string };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const email = (body.email ?? '').trim().toLowerCase();
  const role  = body.role === 'sourcebot' ? 'sourcebot' : 'boothbot';   // default to BoothBot
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Valid email is required' }, 400);
  }

  // Turnstile check before any DB write or Resend call. When secrets unset
  // (dev), verifyTurnstile returns success with skipped:true. In production
  // this is the gate that stops bots from using us as a Resend spam relay.
  const ip = request.headers.get('CF-Connecting-IP');
  const captcha = await verifyTurnstile(body.cf_turnstile_response, ip, env);
  if (!captcha.success) {
    return jsonResponse({ error: 'captcha verification failed', detail: captcha.error }, 400);
  }

  // Find or create the user. PENDING: prefix marks the row as pre-activation.
  const existing = await env.DB
    .prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; password_hash: string | null }>();

  let userId: string;
  if (existing) {
    if (existing.password_hash && !existing.password_hash.startsWith(PENDING_PASSWORD_PREFIX)) {
      // Already a real account — direct them to login (don't leak that the
      // email is registered; same response either way for a privacy-conscious
      // surface, but keep the actionable message).
      return jsonResponse({ alreadyRegistered: true, sent: false }, 200);
    }
    userId = existing.id;
  } else {
    const placeholderName = email.split('@')[0] || 'User';
    const placeholderHash = `${PENDING_PASSWORD_PREFIX}${crypto.randomUUID()}`;
    const inserted = await env.DB
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id')
      .bind(email, placeholderName, placeholderHash)
      .first<{ id: string }>();
    if (!inserted?.id) return jsonResponse({ error: 'Failed to create user' }, 500);
    userId = inserted.id;
  }

  // Issue a fresh onboarding token. Same token serves all 3 channels;
  // first redemption (TG /start, WA wa.me text, or web /activate) wins.
  const token = `${crypto.randomUUID().replace(/-/g, '')}`;
  const expiresAt = Math.floor(Date.now() / 1000) + ONBOARDING_TOKEN_TTL_S;
  await env.DB
    .prepare(
      `INSERT INTO onboarding_tokens (token, user_id, bot_role, expires_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(token, userId, role, expiresAt)
    .run();

  // Fire the verification email. sendVerificationEmail logs (doesn't throw)
  // when RESEND_API_KEY is unset — keeps dev usable without infra.
  const send = await sendVerificationEmail({ to: email, token, role: role as 'boothbot' | 'sourcebot' }, env);
  if (!send.ok) {
    console.error('[auth/register] verification email send failed', { email, error: send.error });
    // Still return success to the client — token exists in DB, user can be
    // resent the email manually. Alternative: surface the error and roll back
    // token. For v1, prefer the optimistic UX.
  }

  return jsonResponse({ sent: true, alreadyRegistered: false }, 200);
}

// ── /api/auth/activate ──────────────────────────────────────────────────────
// Web-channel redemption of the onboarding token. POST { token, name, password }.
// Looks up the token, verifies it's unused + unexpired, sets the user's name +
// real password_hash, marks the token consumed, returns a JWT.

export async function handleActivate(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { token?: string; name?: string; password?: string };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const token    = (body.token    ?? '').trim();
  const name     = (body.name     ?? '').trim();
  const password = body.password  ?? '';
  if (!token)            return jsonResponse({ error: 'token is required' }, 400);
  if (!name)             return jsonResponse({ error: 'name is required' }, 400);
  if (password.length < 8) return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);

  const row = await env.DB
    .prepare(
      `SELECT t.user_id, t.expires_at, t.used_at, u.email
         FROM onboarding_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token = ?
        LIMIT 1`
    )
    .bind(token)
    .first<{ user_id: string; expires_at: number; used_at: number | null; email: string }>();

  if (!row)                                        return jsonResponse({ error: 'Invalid or expired link' }, 400);
  if (row.used_at)                                 return jsonResponse({ error: 'This link was already used' }, 400);
  if (row.expires_at < Math.floor(Date.now() / 1000)) return jsonResponse({ error: 'Invalid or expired link' }, 400);

  // Activation is atomic: mark used + set password + name in one transaction
  // so a duplicate request can't double-activate. SQLite single-statement
  // updates are atomic; we use a guard on used_at IS NULL to enforce.
  const password_hash = await hashPassword(password);
  const claimed = await env.DB
    .prepare(`UPDATE onboarding_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL`)
    .bind(Math.floor(Date.now() / 1000), token)
    .run();
  if (!claimed.success || claimed.meta.changes === 0) {
    return jsonResponse({ error: 'This link was already used' }, 400);
  }

  await env.DB
    .prepare(`UPDATE users SET name = ?, password_hash = ? WHERE id = ?`)
    .bind(name, password_hash, row.user_id)
    .run();

  const jwt = await signJwt(
    { sub: row.user_id, email: row.email, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
    env.WEBHOOK_SECRET
  );
  return jsonResponse({ token: jwt, user: { id: row.user_id, email: row.email, name } }, 200);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { email?: string; password?: string };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { email, password } = body;
  if (!email || !password) return jsonResponse({ error: 'email and password are required' }, 400);

  const user = await env.DB
    .prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<User>();

  if (!user) return jsonResponse({ error: 'Invalid credentials' }, 401);
  if (!user.password_hash || user.password_hash.startsWith(PENDING_PASSWORD_PREFIX)) {
    // Email-only signup but never activated. Don't let them log in — direct
    // them back to the activation flow.
    return jsonResponse({ error: 'Please open the verification link in your email to finish setup', code: 'pending_activation' }, 403);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return jsonResponse({ error: 'Invalid credentials' }, 401);

  const token = await signJwt(
    { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
    env.WEBHOOK_SECRET
  );
  return jsonResponse({ token, user: { id: user.id, email: user.email, name: user.name ?? user.email.split('@')[0] } });
}

export async function handleInsights(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  if (!env.GEMINI_API_KEY || env.GEMINI_API_KEY.startsWith('your_')) {
    return jsonResponse({ error: 'Gemini API key not configured' }, 503);
  }

  const bot = await env.DB.prepare(
    `SELECT chat_id FROM bot_users WHERE user_id = ?`
  ).bind(auth.userId).first<{ chat_id: number }>();

  if (!bot) return jsonResponse({ error: 'No Telegram bot connected' }, 404);

  const rows = await env.DB.prepare(
    `SELECT name, company, email, notes, show_name, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(bot.chat_id).all<{ name: string; company: string | null; email: string | null; notes: string | null; show_name: string; created_at: string }>();

  if (!rows.results.length) return jsonResponse({ error: 'No leads to analyze' }, 404);

  const showName = rows.results[0].show_name;
  const showLeads = rows.results.filter(l => l.show_name === showName);

  try {
    const analysis = await ask(buildSummaryPrompt(showName, showLeads), env.GEMINI_API_KEY);
    return jsonResponse({ show: showName, lead_count: showLeads.length, analysis });
  } catch (e) {
    return jsonResponse({ error: 'AI analysis failed' }, 502);
  }
}

export async function handleStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const bot = await env.DB.prepare(
    `SELECT chat_id FROM bot_users WHERE user_id = ?`
  ).bind(auth.userId).first<{ chat_id: number }>();

  let leadCount = 0;
  if (bot) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM leads WHERE chat_id = ?`
    ).bind(bot.chat_id).first<{ count: number }>();
    leadCount = row?.count ?? 0;
  }

  return jsonResponse({ leads: leadCount, bot_connected: !!bot });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const user = await env.DB
    .prepare('SELECT id, email, name, created_at FROM users WHERE id = ?')
    .bind(auth.userId)
    .first<Pick<User, 'id' | 'email' | 'name' | 'created_at'>>();

  if (!user) return jsonResponse({ error: 'User not found' }, 404);
  return jsonResponse({ user });
}

export async function requireAuth(request: Request, env: Env): Promise<{ userId: string; email: string } | Response> {
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return jsonResponse({ error: 'Missing authorization header' }, 401);

  const payload = await verifyJwt(token, env.WEBHOOK_SECRET);
  if (!payload) return jsonResponse({ error: 'Invalid or expired token' }, 401);

  return { userId: payload.sub as string, email: payload.email as string };
}

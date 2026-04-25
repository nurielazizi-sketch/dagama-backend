/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { hashPassword, signJwt } from './crypto';

const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE     = 'openid email profile';

function redirectUri(env: Env): string {
  return `${env.ORIGIN}/api/auth/google/callback`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/google?next=/dashboard
//   Kicks off Google OAuth. Optional ?next= to land on a specific page after.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleGoogleAuthStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const next = url.searchParams.get('next') ?? '/dashboard';

  const params = new URLSearchParams({
    client_id:     env.GMAIL_CLIENT_ID,
    redirect_uri:  redirectUri(env),
    response_type: 'code',
    scope:         SCOPE,
    access_type:   'online',                  // login flow only — we don't need refresh tokens here
    prompt:        'select_account',
    state:         encodeURIComponent(next),  // round-tripped, used after callback
  });
  return Response.redirect(`${AUTH_URL}?${params.toString()}`, 302);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/google/callback?code=...&state=...
//   Exchanges code for an id_token, parses email/name, creates or links the
//   user, issues our JWT, returns an HTML page that stores the token in
//   localStorage and bounces to ?next.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleGoogleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  const next  = decodeURIComponent(state) || '/dashboard';

  if (!code) return errorPage('No authorization code returned by Google.');

  // Exchange code for tokens
  const tokRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      redirect_uri:  redirectUri(env),
      grant_type:    'authorization_code',
    }).toString(),
  });
  const tok = await tokRes.json() as { access_token?: string; id_token?: string; error?: string };
  if (!tok.id_token) return errorPage(`Token exchange failed: ${tok.error ?? 'no id_token'}`);

  // Parse id_token (JWT) to get email + name. id_token is signed by Google;
  // we trust it because we just got it over TLS from token.googleapis.com.
  const parts = tok.id_token.split('.');
  if (parts.length !== 3) return errorPage('Malformed id_token');
  let claims: { email?: string; email_verified?: boolean; name?: string; sub?: string };
  try {
    claims = JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return errorPage('Could not parse id_token claims');
  }
  if (!claims.email) return errorPage('Google did not return an email address');
  if (claims.email_verified === false) return errorPage('Google account email is not verified');

  const email = claims.email.toLowerCase();
  const name  = claims.name ?? email.split('@')[0];

  // Find or create user
  let userRow = await env.DB.prepare(`SELECT id, email, name FROM users WHERE email = ?`).bind(email).first<{ id: string; email: string; name: string }>();
  if (!userRow) {
    // Create with a random password — they'll always sign in via Google going forward
    const randomPassword = crypto.randomUUID() + crypto.randomUUID();
    const ph = await hashPassword(randomPassword);
    const inserted = await env.DB.prepare(
      `INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id, email, name`
    ).bind(email, name, ph).first<{ id: string; email: string; name: string }>();
    if (!inserted?.id) return errorPage('Failed to create user record');
    userRow = inserted;
  }

  // Issue our JWT (matches the shape /api/auth/login returns)
  const JWT_TTL_SECONDS = 60 * 60 * 24 * 7;
  const token = await signJwt(
    { sub: userRow.id, email: userRow.email, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
    env.WEBHOOK_SECRET,
  );

  return new Response(htmlBouncePage({
    token,
    user: { id: userRow.id, email: userRow.email, name: userRow.name },
    next,
  }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function htmlBouncePage(args: { token: string; user: { id: string; email: string; name: string }; next: string }): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Signing in…</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0F1419;color:#F5F5F5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:rgba(30,41,59,.7);border:1px solid rgba(212,175,55,.25);border-radius:16px;padding:2rem 2.5rem;text-align:center}.spinner{width:32px;height:32px;border:3px solid rgba(212,175,55,.2);border-top-color:#D4AF37;border-radius:50%;margin:0 auto 1rem;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body>
<div class="card"><div class="spinner"></div><div>Signing you in…</div></div>
<script>
(function(){
  try {
    localStorage.setItem('dagama_token', ${JSON.stringify(args.token)});
    localStorage.setItem('dagama_user',  ${JSON.stringify(JSON.stringify(args.user))});
  } catch (e) {}
  window.location.replace(${JSON.stringify(args.next)});
})();
</script>
</body></html>`;
}

function errorPage(message: string): Response {
  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0F1419;color:#F5F5F5;padding:2rem;text-align:center"><h2>Sign-in failed</h2><p>${escapeHtml(message)}</p><p><a href="/login" style="color:#D4AF37">Back to login</a></p></body></html>`;
  return new Response(html, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function b64urlDecode(s: string): string {
  // Pad and translate base64url -> base64
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return atob(b64);
}

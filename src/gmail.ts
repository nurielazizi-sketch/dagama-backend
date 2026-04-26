/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

const GMAIL_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_SCOPE     = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'email',
].join(' ');

function getRedirectUri(env: Env): string {
  return `${env.ORIGIN}/api/gmail/callback`;
}

interface GmailTokenRow {
  chat_id: number;
  gmail_address: string;
  access_token: string;
  refresh_token: string;
  token_expiry: number;
}

export interface SendEmailResult {
  messageId: string;
  subject: string;
  sentAt: string;
}

// ── OAuth consent URL ─────────────────────────────────────────────────────────

// `botRole` is round-tripped through the OAuth `state` so the callback can
// route the confirmation message back via the right bot's token. Defaults to
// 'boothbot' for backward compatibility with existing /connectgmail links.
export function buildGmailAuthUrl(chatId: number, env: Env, botRole: 'boothbot' | 'sourcebot' = 'boothbot'): string {
  const params = new URLSearchParams({
    client_id:     env.GMAIL_CLIENT_ID,
    redirect_uri:  getRedirectUri(env),
    response_type: 'code',
    scope:         GMAIL_SCOPE,
    access_type:   'offline',
    prompt:        'consent',
    state:         botRole === 'sourcebot' ? `${chatId}:sourcebot` : String(chatId),
  });
  return `${GMAIL_AUTH_URL}?${params.toString()}`;
}

// ── OAuth callback handler ────────────────────────────────────────────────────

export async function handleGmailCallback(request: Request, env: Env): Promise<Response> {
  const url   = new URL(request.url);
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error || !code || !state) {
    return new Response(OAUTH_ERROR_HTML, { headers: { 'Content-Type': 'text/html' } });
  }

  // state forms:
  //   `${chatId}`               — legacy BoothBot Telegram OAuth
  //   `${chatId}:sourcebot`     — SourceBot Telegram OAuth
  //   `buyer:${buyerId}`        — cross-channel (web / WhatsApp) OAuth keyed by buyer
  const isBuyerState = state.startsWith('buyer:');
  const buyerIdFromState = isBuyerState ? state.slice('buyer:'.length) : null;
  const [chatIdStr, botRoleRaw] = isBuyerState ? ['0', ''] : state.split(':');
  const chatId  = parseInt(chatIdStr, 10);
  const botRole: 'boothbot' | 'sourcebot' = botRoleRaw === 'sourcebot' ? 'sourcebot' : 'boothbot';
  if (!isBuyerState && isNaN(chatId)) return new Response('Bad state', { status: 400 });
  if (isBuyerState && !buyerIdFromState) return new Response('Bad state', { status: 400 });

  // Exchange code for tokens
  const tokenRes = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      redirect_uri:  getRedirectUri(env),
      grant_type:    'authorization_code',
    }),
  });

  const tokens = await tokenRes.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!tokens.access_token || !tokens.refresh_token) {
    return new Response(OAUTH_ERROR_HTML, { headers: { 'Content-Type': 'text/html' } });
  }

  // Get Gmail address
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileRes.json() as { email?: string };
  const gmailAddress = profile.email ?? 'unknown@gmail.com';

  const tokenExpiry = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600);

  if (isBuyerState && buyerIdFromState) {
    // Buyer-keyed insert: synthesise a chat_id (we use the buyer hash) so the
    // chat_id PK doesn't collide with real Telegram rows. We could nullable
    // chat_id later; for now we encode the buyer id into a deterministic
    // negative integer so it never collides with a real chat_id.
    const syntheticChatId = -Math.abs(hashStringToInt32(buyerIdFromState));
    await env.DB.prepare(`
      INSERT INTO gmail_tokens (chat_id, buyer_id, gmail_address, access_token, refresh_token, token_expiry)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        buyer_id      = excluded.buyer_id,
        gmail_address = excluded.gmail_address,
        access_token  = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_expiry  = excluded.token_expiry,
        updated_at    = datetime('now')
    `).bind(syntheticChatId, buyerIdFromState, gmailAddress, tokens.access_token, tokens.refresh_token, tokenExpiry).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO gmail_tokens (chat_id, gmail_address, access_token, refresh_token, token_expiry)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        gmail_address = excluded.gmail_address,
        access_token  = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_expiry  = excluded.token_expiry,
        updated_at    = datetime('now')
    `).bind(chatId, gmailAddress, tokens.access_token, tokens.refresh_token, tokenExpiry).run();

    // Notify user via the bot they came from (Telegram-side flow only).
    const botToken = botRole === 'sourcebot' && env.TELEGRAM_BOT_TOKEN_SOURCE
      ? env.TELEGRAM_BOT_TOKEN_SOURCE
      : env.TELEGRAM_BOT_TOKEN;
    const helpHint = botRole === 'sourcebot'
      ? 'You can now use /email <supplier> to send follow-up emails.'
      : 'You can now use /sendemail N to send follow-up emails.';
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ Gmail connected as ${gmailAddress}!\n\n${helpHint}`,
      }),
    });
  }

  return new Response(OAUTH_SUCCESS_HTML, { headers: { 'Content-Type': 'text/html' } });
}

// ── Token management ──────────────────────────────────────────────────────────

export async function getGmailToken(chatId: number, env: Env): Promise<GmailTokenRow | null> {
  return env.DB.prepare(`SELECT * FROM gmail_tokens WHERE chat_id = ?`)
    .bind(chatId)
    .first<GmailTokenRow>();
}

// Buyer-scoped Gmail lookup (cross-channel). Prefers a buyer_id-keyed row;
// falls back to the buyer's Telegram chat_id (set during Telegram-side OAuth)
// so SourceBot users who connected via Telegram first can keep sending email
// from WhatsApp / web without re-authenticating.
export async function getGmailTokenForBuyer(buyerId: string, env: Env): Promise<GmailTokenRow | null> {
  const direct = await env.DB.prepare(
    `SELECT * FROM gmail_tokens WHERE buyer_id = ? LIMIT 1`
  ).bind(buyerId).first<GmailTokenRow>();
  if (direct) return direct;

  const tg = await env.DB.prepare(
    `SELECT telegram_chat_id FROM sb_buyers_telegram WHERE buyer_id = ? LIMIT 1`
  ).bind(buyerId).first<{ telegram_chat_id: number }>();
  if (!tg?.telegram_chat_id) return null;
  return getGmailToken(tg.telegram_chat_id, env);
}

// Equivalent of getValidAccessToken but routes via buyer_id (with chat_id
// fallback). Refreshes the access_token when expired and writes back to the
// row that owned it (chat_id-keyed or buyer_id-keyed, whichever).
export async function getValidAccessTokenForBuyer(buyerId: string, env: Env): Promise<{ accessToken: string; from: string }> {
  const row = await getGmailTokenForBuyer(buyerId, env);
  if (!row) throw new Error('GMAIL_NOT_CONNECTED');

  const now = Math.floor(Date.now() / 1000);
  if (row.token_expiry > now + 60) return { accessToken: row.access_token, from: row.gmail_address };

  const res = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('GMAIL_REFRESH_FAILED');

  const newExpiry = now + (data.expires_in ?? 3600);
  // Update whichever key actually identified this row.
  await env.DB.prepare(
    `UPDATE gmail_tokens
        SET access_token = ?, token_expiry = ?, updated_at = datetime('now')
      WHERE chat_id = ?`
  ).bind(data.access_token, newExpiry, row.chat_id).run();

  return { accessToken: data.access_token, from: row.gmail_address };
}

// Send a Gmail email keyed by buyer_id (cross-channel). Mirrors sendGmailEmail
// but routes auth via buyer_id with chat_id fallback. Returns the same shape.
export async function sendGmailEmailForBuyer(
  buyerId: string,
  to: string,
  rawEmailText: string,
  env: Env,
  htmlBody?: string,
): Promise<SendEmailResult> {
  const { accessToken, from } = await getValidAccessTokenForBuyer(buyerId, env);

  const lines   = rawEmailText.trim().split('\n');
  const subject = lines[0].replace(/^subject:\s*/i, '').trim();
  const body    = lines.slice(1).join('\n').trim();

  const mimeMessage = buildMimeMessage({ from, to, subject, body, htmlBody });

  const res = await fetch(GMAIL_SEND_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw: mimeMessage }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GMAIL_SEND_FAILED: ${err}`);
  }
  const data = await res.json() as { id?: string };
  return { messageId: data.id ?? '', subject, sentAt: new Date().toISOString() };
}

// Build an OAuth URL keyed by buyer_id. The state is `buyer:{buyerId}` so the
// callback knows to write the row with buyer_id (not chat_id). Used by the web
// dashboard's "Connect Gmail" button.
export function buildGmailAuthUrlForBuyer(buyerId: string, env: Env): string {
  const params = new URLSearchParams({
    client_id:     env.GMAIL_CLIENT_ID,
    redirect_uri:  getRedirectUri(env),
    response_type: 'code',
    scope:         GMAIL_SCOPE,
    access_type:   'offline',
    prompt:        'consent',
    state:         `buyer:${buyerId}`,
  });
  return `${GMAIL_AUTH_URL}?${params.toString()}`;
}

export async function getValidAccessToken(chatId: number, env: Env): Promise<string> {
  const row = await getGmailToken(chatId, env);
  if (!row) throw new Error('GMAIL_NOT_CONNECTED');

  const now = Math.floor(Date.now() / 1000);
  if (row.token_expiry > now + 60) return row.access_token;

  // Refresh expired token
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type:    'refresh_token',
    }),
  });

  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('GMAIL_REFRESH_FAILED');

  const newExpiry = now + (data.expires_in ?? 3600);
  await env.DB.prepare(`
    UPDATE gmail_tokens SET access_token = ?, token_expiry = ?, updated_at = datetime('now')
    WHERE chat_id = ?
  `).bind(data.access_token, newExpiry, chatId).run();

  return data.access_token;
}

// ── Email sending ─────────────────────────────────────────────────────────────

export async function sendGmailEmail(
  chatId: number,
  to: string,
  rawEmailText: string,
  env: Env,
  htmlBody?: string,
): Promise<SendEmailResult> {
  const accessToken  = await getValidAccessToken(chatId, env);
  const tokenRow     = await getGmailToken(chatId, env);
  const fromAddress  = tokenRow?.gmail_address ?? '';

  // Parse subject (first line) and body (rest)
  const lines   = rawEmailText.trim().split('\n');
  const subject = lines[0].replace(/^subject:\s*/i, '').trim();
  const body    = lines.slice(1).join('\n').trim();

  const mimeMessage = buildMimeMessage({ from: fromAddress, to, subject, body, htmlBody });

  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: mimeMessage }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GMAIL_SEND_FAILED: ${err}`);
  }

  const data = await res.json() as { id?: string };
  const sentAt = new Date().toISOString();

  return { messageId: data.id ?? '', subject, sentAt };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// Deterministic 32-bit hash of a UUID string. Used to synthesise a unique
// chat_id sentinel for buyer-keyed gmail_tokens rows so the schema's chat_id
// PK doesn't need to be relaxed to NULL. Negative integers are reserved for
// these sentinels (real Telegram chat_ids are positive for users, group/super
// can be negative but never collide with this since our hash range is
// constrained and we only use it inside SourceBot's buyer-keyed rows).
function hashStringToInt32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;  // force int32
  }
  return h === 0 ? 1 : h;
}

function buildMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  body: string;       // text/plain fallback
  htmlBody?: string;  // optional text/html alternative
}): string {
  let raw: string;
  if (params.htmlBody) {
    // multipart/alternative — Gmail clients prefer the HTML part; plain-text
    // clients (and spam filters that prefer text) fall back to params.body.
    const boundary = `=_dagama_${Math.random().toString(36).slice(2, 10)}`;
    raw = [
      `From: ${params.from}`,
      `To: ${params.to}`,
      `Subject: ${params.subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      params.body,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      params.htmlBody,
      '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    raw = [
      `From: ${params.from}`,
      `To: ${params.to}`,
      `Subject: ${params.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      params.body,
    ].join('\r\n');
  }

  const bytes  = new TextEncoder().encode(raw);
  const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Static HTML pages ─────────────────────────────────────────────────────────

const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Gmail Connected</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0F1419;color:#fff;}
.card{text-align:center;padding:2rem;border:1px solid #D4AF37;border-radius:12px;max-width:360px;}
h1{color:#D4AF37;margin-bottom:.5rem;}p{color:#94A3B8;}</style></head>
<body><div class="card"><h1>✅ Gmail Connected!</h1>
<p>You can close this tab and return to Telegram.</p>
<p style="margin-top:1rem;font-size:.85rem;">Use <strong>/sendemail N</strong> in the bot to send follow-up emails.</p>
</div></body></html>`;

const OAUTH_ERROR_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Connection Failed</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0F1419;color:#fff;}
.card{text-align:center;padding:2rem;border:1px solid #ef4444;border-radius:12px;max-width:360px;}
h1{color:#ef4444;margin-bottom:.5rem;}p{color:#94A3B8;}</style></head>
<body><div class="card"><h1>❌ Connection Failed</h1>
<p>Something went wrong. Please close this tab and try <strong>/connectgmail</strong> again in Telegram.</p>
</div></body></html>`;

/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

const GMAIL_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_SCOPE     = 'https://www.googleapis.com/auth/gmail.send';

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

export function buildGmailAuthUrl(chatId: number, env: Env): string {
  const params = new URLSearchParams({
    client_id:     env.GMAIL_CLIENT_ID,
    redirect_uri:  getRedirectUri(env),
    response_type: 'code',
    scope:         GMAIL_SCOPE,
    access_type:   'offline',
    prompt:        'consent',
    state:         String(chatId),
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

  const chatId = parseInt(state, 10);
  if (isNaN(chatId)) return new Response('Bad state', { status: 400 });

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

  // Notify user in Telegram
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ Gmail connected! You can now use /sendemail N to send follow-up emails directly from ${gmailAddress}.`,
    }),
  });

  return new Response(OAUTH_SUCCESS_HTML, { headers: { 'Content-Type': 'text/html' } });
}

// ── Token management ──────────────────────────────────────────────────────────

export async function getGmailToken(chatId: number, env: Env): Promise<GmailTokenRow | null> {
  return env.DB.prepare(`SELECT * FROM gmail_tokens WHERE chat_id = ?`)
    .bind(chatId)
    .first<GmailTokenRow>();
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
  env: Env
): Promise<SendEmailResult> {
  const accessToken  = await getValidAccessToken(chatId, env);
  const tokenRow     = await getGmailToken(chatId, env);
  const fromAddress  = tokenRow?.gmail_address ?? '';

  // Parse subject (first line) and body (rest)
  const lines   = rawEmailText.trim().split('\n');
  const subject = lines[0].replace(/^subject:\s*/i, '').trim();
  const body    = lines.slice(1).join('\n').trim();

  const mimeMessage = buildMimeMessage({ from: fromAddress, to, subject, body });

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

function buildMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): string {
  const raw = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    params.body,
  ].join('\r\n');

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

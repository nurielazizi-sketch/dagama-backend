/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

const GMAIL_SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ─────────────────────────────────────────────────────────────────────────────
// Welcome email sent at registration. Includes:
//   - Bot deep links (Telegram now, WhatsApp scaffolded for later)
//   - Pre-created Sheet URL
//   - Pre-created Drive folder URL
//   - Onboarding token in deep link payload (so bot recognizes user on /start)
// ─────────────────────────────────────────────────────────────────────────────

export interface WelcomeEmailPayload {
  toEmail:        string;
  toName:         string;
  botRole:        'boothbot' | 'sourcebot';
  showName:       string;
  sheetUrl:       string;
  driveFolderUrl: string;
  onboardingToken: string;
}

export async function sendWelcomeEmail(payload: WelcomeEmailPayload, env: Env): Promise<void> {
  const { subject, html, text } = renderWelcomeEmail(payload, env);

  // Real send path — only fires if the central refresh token is configured.
  // If not, the email content is logged and we return cleanly. This lets the
  // rest of the onboarding flow be tested end-to-end without Gmail set up.
  if (env.DAGAMA_NOREPLY_REFRESH_TOKEN && env.DAGAMA_NOREPLY_FROM_EMAIL) {
    try {
      await sendViaGmail({
        to:          payload.toEmail,
        toName:      payload.toName,
        from:        env.DAGAMA_NOREPLY_FROM_EMAIL,
        fromName:    'DaGama',
        subject,
        html,
        text,
        refreshToken: env.DAGAMA_NOREPLY_REFRESH_TOKEN,
        env,
      });
      return;
    } catch (e) {
      console.error('[email] Gmail send failed, falling back to log:', e);
      // fall through to log
    }
  }

  console.log('[email][stub] Welcome email (Gmail not configured yet):', {
    to: payload.toEmail,
    subject,
    text: text.slice(0, 200) + '…',
  });
}

// ── Templates ────────────────────────────────────────────────────────────────

function renderWelcomeEmail(p: WelcomeEmailPayload, env: Env): { subject: string; html: string; text: string } {
  const botName = p.botRole === 'sourcebot' ? 'SourceBot' : 'BoothBot';
  const tagline = p.botRole === 'sourcebot'
    ? 'Capture suppliers, products, and prices at every show.'
    : 'Capture every buyer that walks past your booth.';

  const tgLink = telegramDeepLink(p.botRole, p.onboardingToken, env);
  const waLink = whatsappDeepLink(p.botRole, p.onboardingToken, env);
  const waEnabled = !!env.WHATSAPP_BOT_NUMBER;

  const subject = `🧭 Welcome to DaGama ${botName} — your sheet is ready`;

  const text =
    `Welcome to DaGama ${botName}, ${p.toName}!\n\n` +
    `${tagline}\n\n` +
    `Your show: ${p.showName}\n` +
    `Your Google Sheet: ${p.sheetUrl}\n` +
    `Your Drive folder: ${p.driveFolderUrl}\n\n` +
    `Open the bot to start capturing:\n` +
    `  Telegram: ${tgLink}\n` +
    (waEnabled ? `  WhatsApp: ${waLink}\n` : `  WhatsApp: coming soon\n`) +
    `\n— DaGama`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0F1419;background:#fff;">
  <div style="font-size:24px;font-weight:700;color:#D4AF37;margin-bottom:4px;">🧭 DaGama ${botName}</div>
  <div style="color:#64748B;font-size:14px;margin-bottom:24px;">${tagline}</div>
  <p>Hi ${escapeHtml(p.toName)},</p>
  <p>Your account is ready for <strong>${escapeHtml(p.showName)}</strong>. Two links you'll want to keep handy:</p>
  <table cellpadding="0" cellspacing="0" style="margin:16px 0;">
    <tr><td style="padding:6px 0;">📊 <a href="${p.sheetUrl}" style="color:#D4AF37;">Your Google Sheet</a></td></tr>
    <tr><td style="padding:6px 0;">📁 <a href="${p.driveFolderUrl}" style="color:#D4AF37;">Your Drive folder</a></td></tr>
  </table>
  <p style="margin-top:24px;"><strong>Open the bot to start capturing:</strong></p>
  <p>
    <a href="${tgLink}" style="display:inline-block;background:#0088cc;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-right:8px;">Open in Telegram</a>
    ${waEnabled
      ? `<a href="${waLink}" style="display:inline-block;background:#25D366;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open in WhatsApp</a>`
      : `<span style="display:inline-block;background:#94A3B8;color:#fff;padding:12px 24px;border-radius:8px;font-weight:600;">WhatsApp — coming soon</span>`}
  </p>
  <p style="color:#64748B;font-size:12px;margin-top:32px;">— DaGama · trade show intelligence</p>
</body></html>`;

  return { subject, html, text };
}

function telegramDeepLink(role: 'boothbot' | 'sourcebot', token: string, env: Env): string {
  const username = role === 'sourcebot'
    ? (env.TELEGRAM_BOT_USERNAME_SOURCE ?? 'DaGamaSourceBot')
    : (env.TELEGRAM_BOT_USERNAME_BOOTH  ?? 'DaGamaBoothBot');
  return `https://t.me/${username}?start=${token}`;
}

function whatsappDeepLink(_role: 'boothbot' | 'sourcebot', token: string, env: Env): string {
  const phone = (env.WHATSAPP_BOT_NUMBER ?? '').replace(/[^\d]/g, '');
  if (!phone) return '#';
  return `https://wa.me/${phone}?text=${encodeURIComponent(`join ${token}`)}`;
}

// ── Gmail send via OAuth refresh token ───────────────────────────────────────

interface GmailSendArgs {
  to:           string;
  toName:       string;
  from:         string;
  fromName:     string;
  subject:      string;
  html:         string;
  text:         string;
  refreshToken: string;
  env:          Env;
}

async function sendViaGmail(args: GmailSendArgs): Promise<void> {
  // Refresh access token
  const params = new URLSearchParams({
    client_id:     args.env.GMAIL_CLIENT_ID,
    client_secret: args.env.GMAIL_CLIENT_SECRET,
    refresh_token: args.refreshToken,
    grant_type:    'refresh_token',
  });
  const tokRes = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const tok = await tokRes.json() as { access_token?: string; error?: string };
  if (!tok.access_token) throw new Error(`Gmail token refresh failed: ${tok.error ?? JSON.stringify(tok)}`);

  // RFC 2822 multipart/alternative MIME
  const boundary = `----dagama_${crypto.randomUUID()}`;
  const mime =
    `From: "${args.fromName}" <${args.from}>\r\n` +
    `To: "${args.toName}" <${args.to}>\r\n` +
    `Subject: ${encodeMimeHeader(args.subject)}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n${args.text}\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n\r\n${args.html}\r\n\r\n` +
    `--${boundary}--`;

  // base64url encode
  const raw = btoa(unescape(encodeURIComponent(mime))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const sendRes = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!sendRes.ok) throw new Error(`Gmail send failed: ${sendRes.status} ${await sendRes.text()}`);
}

function encodeMimeHeader(s: string): string {
  // Encoded-word for non-ASCII subject lines (emoji etc.)
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return `=?UTF-8?B?${b64}?=`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

const GMAIL_SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// ─────────────────────────────────────────────────────────────────────────────
// Transactional email — Resend (primary) with Gmail-OAuth fallback (legacy).
//
// When RESEND_API_KEY is set, every send goes through Resend. heydagama.com is
// the verified sending domain (DKIM/SPF/DMARC); we send AS any *@heydagama.com
// address. Replies route to the Workspace inbox — one seat at hello@ with
// admin@/billing@/noreply@/support@ as aliases (memory/dagama_email_infra.md).
//
// If RESEND_API_KEY is absent, we fall through to the legacy Gmail-OAuth path
// (DAGAMA_NOREPLY_REFRESH_TOKEN). If that's also absent, we log and return —
// dev keeps working without any email infra.
// ─────────────────────────────────────────────────────────────────────────────

export interface SendEmailInput {
  from:     string;          // e.g. 'Vasco DaGaMa <hello@heydagama.com>'
  to:       string;
  subject:  string;
  html:     string;
  text?:    string;          // optional plain-text alternative
  replyTo?: string;          // defaults to support@heydagama.com when via Resend
  tag?:     string;          // analytics tag (verification | trial_expiry | …)
}

export interface SendEmailResult { ok: boolean; id?: string; error?: string; }

/** Primitive Resend send. Returns {ok:false} on failure rather than throwing. */
export async function sendEmail(input: SendEmailInput, env: Env): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY not set — skipping send', {
      to: input.to, subject: input.subject, tag: input.tag,
    });
    return { ok: true, id: 'dev-noop' };
  }

  const payload: Record<string, unknown> = {
    from:     input.from,
    to:       input.to,
    subject:  input.subject,
    html:     input.html,
    reply_to: input.replyTo ?? 'support@heydagama.com',
  };
  if (input.text) payload.text = input.text;
  if (input.tag)  payload.tags = [{ name: 'category', value: input.tag }];

  const res = await fetch(RESEND_ENDPOINT, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error('[email] Resend send failed', { status: res.status, errorText, to: input.to, tag: input.tag });
    return { ok: false, error: `resend_${res.status}` };
  }

  const data = await res.json() as { id?: string };
  return { ok: true, id: data.id };
}

// ── Verification email (Day-1 onboarding) ───────────────────────────────────
// Sent immediately after email-only signup. Three functional deep-link CTAs
// (WA / TG / web) auto-authenticate the user via the onboarding_tokens table.
// Same token redeemable on whichever channel the user clicks first; first
// redemption wins (single-active rule).

export interface VerificationEmailInput {
  to:       string;
  token:    string;
  role:     'boothbot' | 'sourcebot';
}

export async function sendVerificationEmail(input: VerificationEmailInput, env: Env): Promise<SendEmailResult> {
  const tgUrl  = telegramDeepLink(input.role, input.token, env);
  const waUrl  = whatsappDeepLink(input.role, input.token, env);
  const webOrigin = (env.ORIGIN ?? 'https://heydagama.com').replace(/\/$/, '');
  const webUrl    = `${webOrigin}/activate?token=${encodeURIComponent(input.token)}`;

  const productName  = input.role === 'boothbot' ? 'BoothBot' : 'SourceBot';
  const html    = renderVerificationHtml({ role: input.role, tgUrl, waUrl, webUrl });
  const text    = renderVerificationText({ productName, tgUrl, waUrl, webUrl });
  const subject = `✅ Your DaGama ${productName} is ready — pick a channel`;

  return sendEmail({
    from: 'Vasco DaGaMa <hello@heydagama.com>',
    to:   input.to,
    subject, html, text,
    replyTo: 'support@heydagama.com',
    tag:     'verification',
  }, env);
}

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

// Public wrapper used by the funnel scheduler + db_emails. Tries Resend first
// (heydagama.com verified sender), falls back to the legacy Gmail-OAuth path,
// finally falls through to log-only. Returns false only when nothing was sent.
export async function sendTransactionalEmail(
  args: { to: string; toName: string; subject: string; html: string; text: string },
  env: Env,
): Promise<boolean> {
  // Primary path: Resend.
  if (env.RESEND_API_KEY) {
    const r = await sendEmail({
      from:     'Vasco DaGaMa <hello@heydagama.com>',
      to:       args.to,
      subject:  args.subject,
      html:     args.html,
      text:     args.text,
      replyTo:  'support@heydagama.com',
      tag:      'transactional',
    }, env);
    if (r.ok) return true;
    console.warn('[email] Resend failed, attempting Gmail-OAuth fallback', { error: r.error });
  }

  // Legacy fallback: Gmail OAuth (still wired in case anyone has the refresh token set).
  const refreshToken = env.DAGAMA_NOREPLY_REFRESH_TOKEN;
  const fromEmail    = env.DAGAMA_NOREPLY_FROM_EMAIL;
  if (refreshToken && fromEmail) {
    try {
      await sendViaGmail({
        to:       args.to,
        toName:   args.toName,
        from:     fromEmail,
        fromName: 'DaGama',
        subject:  args.subject,
        html:     args.html,
        text:     args.text,
        refreshToken,
        env,
      });
      return true;
    } catch (e) {
      console.error('[email] Gmail-OAuth fallback failed', e);
    }
  }

  console.log(`[email] (no transactional sender configured) would send to=${args.to} subject="${args.subject}"`);
  return false;
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

// ── Verification email renderers (Day-1 onboarding) ─────────────────────────
// Inline-CSS HTML — required for email-client compatibility (Gmail strips
// <style>, Outlook ignores flex/grid). Brand tokens are hardcoded copies of
// the Digital Ledger palette: obsidian #0D0D0D background, titanium #F2F2F2
// text, mint #00FF94 / violet #8B5CF6 per role, ghost-gold #C5A059 accents.

function renderVerificationHtml(args: {
  role:   'boothbot' | 'sourcebot';
  tgUrl:  string;
  waUrl:  string;
  webUrl: string;
}): string {
  const isExhibitor  = args.role === 'boothbot';
  const productName  = isExhibitor ? 'BoothBot' : 'SourceBot';
  const productColor = isExhibitor ? '#00FF94' : '#8B5CF6';
  const audienceLine = isExhibitor
    ? 'Capture every buyer that walks past your booth.'
    : 'Capture every supplier on the show floor — products, prices, voice notes.';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Your DaGama bot is ready</title>
</head>
<body style="margin:0;padding:0;background:#0D0D0D;font-family:Inter,system-ui,sans-serif;color:#F2F2F2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0D;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#16161A;border:1px solid rgba(38,38,38,0.5);border-radius:4px;">

<tr><td style="padding:32px 32px 16px 32px;">
  <div style="font-size:11px;letter-spacing:0.32em;text-transform:uppercase;color:rgba(242,242,242,0.5);margin-bottom:8px;">Trade show intelligence</div>
  <div style="font-size:32px;font-weight:800;letter-spacing:-0.03em;color:#F2F2F2;line-height:1;">DAGAMA</div>
</td></tr>

<tr><td style="padding:8px 32px 0 32px;">
  <h1 style="margin:0;font-size:28px;font-weight:800;letter-spacing:-0.02em;line-height:1.1;color:#F2F2F2;">
    Your ${productName} is ready.
  </h1>
  <p style="margin:12px 0 0 0;font-size:15px;line-height:1.5;color:rgba(242,242,242,0.7);">
    ${audienceLine}
  </p>
</td></tr>

<tr><td style="padding:32px 32px 8px 32px;">
  <div style="font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${productColor};margin-bottom:14px;">
    Pick how you'll use it
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;"><tr><td>
    <a href="${args.waUrl}" style="display:block;padding:14px 18px;background:rgba(37,211,102,0.10);border:1px solid rgba(37,211,102,0.4);border-radius:4px;color:#F2F2F2;text-decoration:none;font-size:15px;font-weight:600;">
      <span style="display:inline-block;width:24px;text-align:center;color:#25D366;font-weight:800;">●</span>
      <span style="margin-left:8px;">Open in WhatsApp</span>
      <span style="float:right;color:rgba(242,242,242,0.5);">→</span>
    </a>
  </td></tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;"><tr><td>
    <a href="${args.tgUrl}" style="display:block;padding:14px 18px;background:rgba(0,136,204,0.10);border:1px solid rgba(0,136,204,0.4);border-radius:4px;color:#F2F2F2;text-decoration:none;font-size:15px;font-weight:600;">
      <span style="display:inline-block;width:24px;text-align:center;color:#0088CC;font-weight:800;">●</span>
      <span style="margin-left:8px;">Open in Telegram</span>
      <span style="float:right;color:rgba(242,242,242,0.5);">→</span>
    </a>
  </td></tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>
    <a href="${args.webUrl}" style="display:block;padding:14px 18px;background:rgba(242,242,242,0.04);border:1px solid rgba(242,242,242,0.2);border-radius:4px;color:#F2F2F2;text-decoration:none;font-size:15px;font-weight:600;">
      <span style="display:inline-block;width:24px;text-align:center;color:#F2F2F2;font-weight:800;">●</span>
      <span style="margin-left:8px;">Open in your browser</span>
      <span style="float:right;color:rgba(242,242,242,0.5);">→</span>
    </a>
  </td></tr></table>
</td></tr>

<tr><td style="padding:24px 32px 8px 32px;">
  <div style="padding:14px 16px;background:rgba(255,184,0,0.08);border:1px solid rgba(255,184,0,0.25);border-radius:4px;font-size:13px;line-height:1.5;color:rgba(242,242,242,0.85);">
    <strong style="color:#FFB800;">Your 24-hour free trial</strong> starts the moment you send your first message — not now. Take your time. Sign up today, activate at your next show.
  </div>
</td></tr>

<tr><td style="padding:16px 32px 8px 32px;">
  <div style="padding:14px 16px;background:rgba(197,160,89,0.08);border:1px solid rgba(197,160,89,0.3);border-radius:4px;font-size:13px;line-height:1.5;color:rgba(242,242,242,0.85);">
    <strong style="color:#C5A059;">Plus ExpenseBot, on us.</strong> Track every coffee, taxi, and booth fee at the show. Free with your trial; stays free with any paid show pass.
  </div>
</td></tr>

<tr><td style="padding:24px 32px 32px 32px;">
  <p style="margin:0;font-size:12px;line-height:1.5;color:rgba(242,242,242,0.4);">
    Each link above can only be used once. Whichever you tap first becomes your active channel — you can switch later from the dashboard.
  </p>
</td></tr>

<tr><td style="padding:0 32px 28px 32px;border-top:1px solid rgba(38,38,38,0.5);padding-top:20px;">
  <p style="margin:0;font-size:11px;line-height:1.5;color:rgba(242,242,242,0.35);">
    DaGama · The Explorer's Toolkit for global trade.<br>
    Replies go to support@heydagama.com.
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function renderVerificationText(args: { productName: string; tgUrl: string; waUrl: string; webUrl: string; }): string {
  return `Your DaGama ${args.productName} is ready.

Pick how you'll use it — tap one link below:

  WhatsApp: ${args.waUrl}
  Telegram: ${args.tgUrl}
  Browser:  ${args.webUrl}

Your 24-hour free trial starts when you send your first message — not now.
Take your time. Sign up today, activate at your next show.

Plus ExpenseBot, on us. Track every coffee, taxi, and booth fee at the show.
Free with your trial; stays free with any paid show pass.

Each link can only be used once. Whichever you tap first becomes your active channel.

— DaGama · The Explorer's Toolkit for global trade
Replies go to support@heydagama.com.
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retargeting email — sent by the daily cron at T-30 / T-14 / T-7 / T-1 days
// before the user's next-show start_date (memory: dagama_retargeting_strategy).
// Carries a per-user single-use 30%-off coupon code.
// ─────────────────────────────────────────────────────────────────────────────

export interface RetargetingEmailInput {
  to:            string;
  firstName:     string;
  showName:      string;
  showLocation:  string | null;
  showStart:     string;       // YYYY-MM-DD
  daysBefore:    number;       // 30 | 14 | 7 | 1
  couponCode:    string;
  botRole:       'boothbot' | 'sourcebot';
}

export async function sendRetargetingEmail(input: RetargetingEmailInput, env: Env): Promise<SendEmailResult> {
  const productName = input.botRole === 'sourcebot' ? 'SourceBot' : 'BoothBot';
  const accentHex   = input.botRole === 'sourcebot' ? '#8B5CF6' : '#00FF94';
  const productLabel = input.botRole === 'sourcebot' ? 'Buyer Path' : 'Exhibitor Path';
  const ctaUrl       = `${env.ORIGIN}/pricing?role=${input.botRole}&coupon=${encodeURIComponent(input.couponCode)}`;
  const showLine     = input.showLocation ? `${input.showName} · ${input.showLocation}` : input.showName;
  const urgency      = input.daysBefore === 1   ? `tomorrow`
                     : input.daysBefore === 7   ? `in 1 week`
                     : input.daysBefore === 14  ? `in 2 weeks`
                     :                            `in ${input.daysBefore} days`;
  const subject = `${input.showName} is ${urgency} — 30% off your show pass`;

  const html = renderRetargetingHtml({
    firstName:    input.firstName,
    productName,
    productLabel,
    accentHex,
    showLine,
    showStart:    input.showStart,
    urgency,
    couponCode:   input.couponCode,
    ctaUrl,
  });
  const text = renderRetargetingText({
    firstName:    input.firstName,
    productName,
    showLine,
    urgency,
    couponCode:   input.couponCode,
    ctaUrl,
  });

  return sendEmail({
    from:    'Vasco DaGaMa <hello@heydagama.com>',
    to:      input.to,
    subject, html, text,
    replyTo: 'support@heydagama.com',
    tag:     'retargeting',
  }, env);
}

function renderRetargetingHtml(args: {
  firstName: string; productName: string; productLabel: string; accentHex: string;
  showLine: string; showStart: string; urgency: string; couponCode: string; ctaUrl: string;
}): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0D0D0D;font-family:'Inter',Arial,sans-serif;color:#F2F2F2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0D;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:rgba(22,22,26,0.95);border:1px solid rgba(38,38,46,0.5);border-radius:4px;">

      <tr><td style="padding:32px 32px 8px 32px;">
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${args.accentHex};margin-bottom:14px;">${args.productLabel} · DaGama ${args.productName}</div>
        <h1 style="margin:0;font-size:28px;font-weight:800;letter-spacing:-0.02em;color:#F2F2F2;line-height:1.2;">
          ${args.showLine} is ${args.urgency}.
        </h1>
        <p style="margin:14px 0 0 0;font-size:15px;line-height:1.5;color:rgba(242,242,242,0.7);">
          Hi ${escapeHtml(args.firstName)} — ${args.showStart} is around the corner. Don't head into the floor with a phone full of unread cards. ${args.productName} captures every contact and follows up while you're still walking the booths.
        </p>
      </td></tr>

      <tr><td style="padding:24px 32px 8px 32px;">
        <div style="padding:18px 20px;background:rgba(255,184,0,0.08);border:1px solid rgba(255,184,0,0.3);border-radius:4px;">
          <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#FFB800;margin-bottom:8px;">Your coupon — single use</div>
          <div style="font-family:'JetBrains Mono','Menlo',monospace;font-size:22px;font-weight:700;color:#F2F2F2;letter-spacing:0.06em;">
            ${args.couponCode}
          </div>
          <div style="margin-top:8px;font-size:13px;color:rgba(242,242,242,0.7);">30% off any 96-hour show pass. Auto-applied if you tap the button below.</div>
        </div>
      </td></tr>

      <tr><td style="padding:24px 32px 32px 32px;">
        <a href="${args.ctaUrl}" style="display:inline-block;padding:14px 28px;background:${args.accentHex};color:#0D0D0D;text-decoration:none;font-weight:700;border-radius:4px;font-size:15px;">
          Get your show pass — 30% off
        </a>
        <p style="margin:18px 0 0 0;font-size:12px;line-height:1.5;color:rgba(242,242,242,0.4);">
          Coupon expires day after the show starts. Single-use per account. ExpenseBot stays free with any paid show pass through 2027.
        </p>
      </td></tr>

      <tr><td style="padding:0 32px 32px 32px;">
        <div style="border-top:1px solid rgba(38,38,46,0.5);padding-top:18px;font-size:11px;color:rgba(242,242,242,0.4);line-height:1.5;">
          You're receiving this because you signed up for DaGama and told us you're going to ${escapeHtml(args.showLine)}.
          Replies go to support@heydagama.com.
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function renderRetargetingText(args: {
  firstName: string; productName: string; showLine: string; urgency: string;
  couponCode: string; ctaUrl: string;
}): string {
  return `Hi ${args.firstName},

${args.showLine} is ${args.urgency}. Don't walk in cold.

DaGama ${args.productName} captures every contact + product on the floor and follows up while you're still walking the booths.

Your single-use coupon: ${args.couponCode}  (30% off any 96-hour show pass)

Get your pass: ${args.ctaUrl}

Coupon expires the day after the show starts. ExpenseBot stays free with any paid show pass through 2027.

Replies → support@heydagama.com
— DaGama
`;
}

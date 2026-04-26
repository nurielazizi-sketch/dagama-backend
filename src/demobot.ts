/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { describePersonPhoto, transcribeVoiceNote } from './db_enrich';
import { getServiceAccountToken } from './google';
import { appendProspectVoiceNote } from './db_sheets';
import { runCardScan, backgroundEnrichProspect, findChildFolderId, uploadJpegToDrive, arrayBufferToBase64, sanitize } from './demobot_core';
import { trackEvent } from './funnel';
import { hashPassword } from './crypto';

// ─────────────────────────────────────────────────────────────────────────────
// DemoBot — internal freelancer Telegram handler (@DaGamaShow).
//
// Freelancers log in via the existing email/password flow with users.role =
// 'freelancer', then open a Telegram deep link from the dashboard that carries
// an onboarding token. /start <token> binds chat_id ↔ user_id.
//
// Scan flow (the heart of the bot):
//   1. Freelancer sends a card photo (optionally as a reply containing the
//      show name; otherwise the bot uses their last-set active show).
//   2. We extract contact + country (Prompt 1+5), classify industry (Prompt 2),
//      fetch+analyze website (Prompt 4) — in parallel.
//   3. Provision Drive folder + Sheet, share to prospect.
//   4. Persist demobot_prospects row, increment per-freelancer demos rollup.
//   5. Send Email 1 inline (Gmail API via DAGAMA_NOREPLY).
//   6. Schedule E2/E3/E4 in email_queue.
//   7. Generate PDF profile (best-effort, async-ish; PDF URL written back to
//      prospect row + sheet later).
//   8. Reply to freelancer with confirmation + buttons for person-photo / voice.
// ─────────────────────────────────────────────────────────────────────────────

interface TgPhotoSize { file_id: string; file_size?: number; width: number; height: number }
interface TgVoice    { file_id: string; duration: number; mime_type?: string; file_size?: number }
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: TgVoice;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
}
interface TgCallbackQuery {
  id: string;
  from: { id: number; first_name: string; username?: string };
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id:      number;
  message?:       TgMessage;
  callback_query?: TgCallbackQuery;
}

type DemoStep =
  | 'idle'
  | 'awaiting_show_name'                 // post-registration or after 14d staleness
  | 'awaiting_person_photo'
  | 'awaiting_voice_note';

// Re-prompt freelancers for the active show after this many seconds of show-set staleness.
// Most freelancers work one show per ~3-day window; 14 days is a comfortable margin
// before the show name they typed last time is almost certainly wrong.
const SHOW_STALENESS_SEC = 14 * 24 * 3600;

interface DemoSession {
  step:                DemoStep;
  activeShowName?:     string;          // free-form — whatever the freelancer typed
  activeShowSetAt?:    number;          // unix seconds; used for 14d staleness check
  lastProspectId?:     string;          // for person photo / voice attachment
  pendingLanguage?:    string;          // language override for the next email
}

// ── Webhook entry ────────────────────────────────────────────────────────────

export async function handleDemoBotWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

  if (!env.TELEGRAM_BOT_TOKEN_DEMO) {
    console.error('[demobot] TELEGRAM_BOT_TOKEN_DEMO not set');
    return new Response('Bot not configured', { status: 503 });
  }

  let update: TgUpdate;
  try { update = await request.json() as TgUpdate; } catch { return new Response('Bad request', { status: 400 }); }

  if (typeof update.update_id === 'number') {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO demobot_tg_updates_seen (update_id, seen_at) VALUES (?, ?)`
    ).bind(update.update_id, Math.floor(Date.now() / 1000)).run();
    if ((r.meta.changes ?? 0) === 0) return new Response('OK (dedup)', { status: 200 });
  }

  if (update.message)        await handleMessage(update.message, env);
  else if (update.callback_query) await handleCallback(update.callback_query, env);
  return new Response('OK', { status: 200 });
}

export async function handleDemoBotSetupWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN_DEMO) return new Response('TELEGRAM_BOT_TOKEN_DEMO not set', { status: 503 });
  const url = `${new URL(request.url).origin}/api/demobot/webhook`;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_DEMO}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: env.WEBHOOK_SECRET, drop_pending_updates: true }),
  });
  return new Response(await r.text(), { status: r.status });
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();
  const tgUsername = msg.from?.username ?? null;

  // /start <token> — admin-issued onboarding link (legacy path, still supported)
  // /start          — self-serve registration: collect email + name
  if (text === '/start' || text.startsWith('/start ')) {
    const arg = text.slice(7).trim();
    if (arg) await cmdStartWithToken(chatId, msg.from?.first_name ?? 'there', arg, env);
    else await cmdSelfServeStart(chatId, msg.from?.first_name ?? null, tgUsername, env);
    return;
  }

  if (text === '/help' || text === '/menu') { await cmdHelp(chatId, env); return; }

  if (text === '/cancel' || text === '/done') {
    // Cancel mid-registration too
    await env.DB.prepare(`DELETE FROM demobot_pending_registrations WHERE chat_id = ?`).bind(chatId).run();
    const f = await getFreelancerForChat(chatId, env);
    if (f) await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, 'OK. Send /start whenever you\'re ready.', env);
    return;
  }

  // Mid-registration: free-text email/name input from a chat that has a pending row
  const pending = await env.DB.prepare(
    `SELECT step, email FROM demobot_pending_registrations WHERE chat_id = ?`
  ).bind(chatId).first<{ step: string; email: string | null }>();
  if (pending && text && !text.startsWith('/')) {
    if (pending.step === 'awaiting_email') {
      await handleEmailInput(chatId, text, tgUsername, env);
      return;
    }
    if (pending.step === 'awaiting_name') {
      await handleNameInput(chatId, text, pending.email ?? '', tgUsername, env);
      return;
    }
  }

  const freelancer = await getFreelancerForChat(chatId, env);
  if (!freelancer) {
    await send(chatId,
      'Hi — this is the DaGama freelancer bot. Send /start to register.',
      env);
    return;
  }

  if (text === '/show' || text.startsWith('/show ')) {
    await cmdShow(chatId, text.slice('/show'.length).trim(), freelancer, env);
    return;
  }
  if (text === '/myshow')  { await cmdMyShow(chatId, env); return; }

  // If the freelancer is in awaiting_show_name (post-registration or after 14d
  // staleness), treat any non-slash text as the show name.
  {
    const session = await getSession(chatId, env);
    if (session.step === 'awaiting_show_name' && text && !text.startsWith('/')) {
      await setActiveShow(chatId, text, env);
      return;
    }
  }
  if (text === '/stats')   { await cmdStats(chatId, freelancer, env); return; }
  if (text === '/language' || text.startsWith('/language ')) {
    await cmdLanguage(chatId, text.slice('/language'.length).trim(), env);
    return;
  }

  // Photo handling
  if (msg.photo && msg.photo.length > 0) {
    const session = await getSession(chatId, env);
    if (session.step === 'awaiting_person_photo') {
      await handlePersonPhoto(chatId, msg.photo, session, env);
      return;
    }
    // Default: treat as a card scan
    await handleCardScan(chatId, msg.photo, msg.caption ?? '', freelancer, env);
    return;
  }

  // Voice handling — attaches to last prospect
  if (msg.voice) {
    const session = await getSession(chatId, env);
    if (!session.lastProspectId) {
      await send(chatId, 'Send a card photo first, then I can attach a voice note to that prospect.', env);
      return;
    }
    await handleVoiceNote(chatId, msg.voice, session, env);
    return;
  }

  if (text.startsWith('/')) {
    await send(chatId, 'Unknown command. Try /help.', env);
    return;
  }

  // No-op for other text — freelancers usually only send media.
  await send(chatId, 'Send a business card photo to start a demo, or /help for commands.', env);
}

async function handleCallback(cb: TgCallbackQuery, env: Env): Promise<void> {
  const chatId = cb.message?.chat.id;
  if (!chatId) return;
  const data = cb.data ?? '';

  // Acknowledge the callback so the loading spinner clears.
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_DEMO}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cb.id }),
  });

  if (data === 'demo_skip_person') {
    await setSession(chatId, { ...(await getSession(chatId, env)), step: 'idle' }, env);
    await send(chatId, 'Skipped. Send the next card whenever you\'re ready.', env);
    return;
  }
  if (data === 'demo_add_person') {
    await setSession(chatId, { ...(await getSession(chatId, env)), step: 'awaiting_person_photo' }, env);
    await send(chatId, 'Send a photo of the prospect. I\'ll add it to their sheet.', env);
    return;
  }
  if (data === 'demo_add_voice') {
    await setSession(chatId, { ...(await getSession(chatId, env)), step: 'awaiting_voice_note' }, env);
    await send(chatId, 'Hold the mic in Telegram and record. I\'ll transcribe and attach.', env);
    return;
  }
  if (data.startsWith('demo_lang:')) {
    const lang = data.slice('demo_lang:'.length);
    const session = await getSession(chatId, env);
    await setSession(chatId, { ...session, pendingLanguage: lang }, env);
    await send(chatId, `Language set to ${lang} for the next email.`, env);
    return;
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

// Self-serve registration entry. If the chat is already bound to a freelancer
// we just say hi; otherwise we open a pending row and ask for their email.
async function cmdSelfServeStart(
  chatId: number,
  firstName: string | null,
  tgUsername: string | null,
  env: Env,
): Promise<void> {
  const existing = await getFreelancerForChat(chatId, env);
  if (existing) {
    const u = await env.DB.prepare(`SELECT name FROM users WHERE id = ?`).bind(existing.id).first<{ name: string }>();
    const session = await getSession(chatId, env);
    const now = Math.floor(Date.now() / 1000);
    const stale = !session.activeShowName || (session.activeShowSetAt && (now - session.activeShowSetAt) > SHOW_STALENESS_SEC);

    if (stale) {
      await setSession(chatId, { ...session, step: 'awaiting_show_name', activeShowName: undefined, activeShowSetAt: undefined }, env);
      await send(chatId,
        `Welcome back${u?.name ? `, ${u.name}` : ''}. Which trade show are you at right now? (Just type the name — e.g. "CES 2027".)`,
        env);
    } else {
      await send(chatId,
        `You're set up${u?.name ? `, ${u.name}` : ''}. Active show: *${session.activeShowName}*.\n\nSend a business card photo to start a demo, or /help for commands.`,
        env, true);
    }
    return;
  }

  await env.DB.prepare(
    `INSERT INTO demobot_pending_registrations (chat_id, telegram_username, step, created_at)
     VALUES (?, ?, 'awaiting_email', ?)
     ON CONFLICT(chat_id) DO UPDATE SET step = 'awaiting_email', email = NULL, telegram_username = excluded.telegram_username, created_at = excluded.created_at`
  ).bind(chatId, tgUsername, Math.floor(Date.now() / 1000)).run();

  await send(chatId,
    `Welcome to DaGama${firstName ? `, ${firstName}` : ''}.\n\n` +
    `Quick setup — what's your email address? (We'll use this for freelancer payouts and weekly summaries.)`,
    env);
}

async function handleEmailInput(
  chatId: number,
  text: string,
  tgUsername: string | null,
  env: Env,
): Promise<void> {
  const email = text.trim().toLowerCase();
  if (!isValidEmail(email)) {
    await send(chatId, 'Hmm, that doesn\'t look like an email. Try again — e.g. you@gmail.com', env);
    return;
  }

  await env.DB.prepare(
    `UPDATE demobot_pending_registrations SET email = ?, step = 'awaiting_name' WHERE chat_id = ?`
  ).bind(email, chatId).run();

  await send(chatId, `Got it. What's your full name? (This is what shows up on the prospect's emails.)`, env);
  // Acknowledge that tgUsername was captured at /start; nothing else to do here.
  void tgUsername;
}

async function handleNameInput(
  chatId: number,
  text: string,
  email: string,
  tgUsername: string | null,
  env: Env,
): Promise<void> {
  const name = text.trim();
  if (name.length < 2) {
    await send(chatId, 'Send your name (at least 2 chars).', env);
    return;
  }
  if (!email) {
    // Should never happen — the email was captured in step 1. Reset cleanly.
    await env.DB.prepare(`DELETE FROM demobot_pending_registrations WHERE chat_id = ?`).bind(chatId).run();
    await send(chatId, 'Something went wrong with registration. Send /start to try again.', env);
    return;
  }

  // Look up or create the user, ensure freelancer role, bind chat.
  let userId: string;
  const existing = await env.DB.prepare(`SELECT id, role FROM users WHERE email = ?`).bind(email).first<{ id: string; role: string }>();
  if (existing) {
    userId = existing.id;
    if (existing.role !== 'freelancer') {
      await env.DB.prepare(`UPDATE users SET role = 'freelancer' WHERE id = ?`).bind(userId).run();
    }
    // Update name only if it was empty (don't clobber a real name from web signup)
    await env.DB.prepare(
      `UPDATE users SET name = COALESCE(NULLIF(name, ''), ?) WHERE id = ?`
    ).bind(name, userId).run();
  } else {
    // Brand new user — create with a random password (they auth via Telegram only).
    const placeholderPw = await hashPassword(crypto.randomUUID());
    const created = await env.DB.prepare(
      `INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'freelancer') RETURNING id`
    ).bind(email, name, placeholderPw).first<{ id: string }>();
    if (!created) {
      console.error('[demobot] user create returned null');
      await send(chatId, 'Sorry — couldn\'t finish registration. Try /start again.', env);
      return;
    }
    userId = created.id;
  }

  // Bind chat (UPSERT — handles re-registration from same chat).
  await env.DB.prepare(
    `INSERT INTO demobot_freelancers_telegram (freelancer_user_id, telegram_chat_id, telegram_username, session)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(freelancer_user_id) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id, telegram_username = excluded.telegram_username`
  ).bind(userId, chatId, tgUsername, JSON.stringify({ step: 'idle' } as DemoSession)).run();

  await env.DB.prepare(`DELETE FROM demobot_pending_registrations WHERE chat_id = ?`).bind(chatId).run();

  await trackEvent(env, {
    buyerId: null,
    eventName: 'demobot_freelancer_registered',
    properties: { freelancer_user_id: userId, via: 'telegram_self_serve', new_user: !existing },
  });

  // Post-registration: jump straight into asking for the show. Treat the next
  // free-text reply as the show name (no /show prefix needed).
  await env.DB.prepare(
    `UPDATE demobot_freelancers_telegram SET session = ? WHERE telegram_chat_id = ?`
  ).bind(JSON.stringify({ step: 'awaiting_show_name' } as DemoSession), chatId).run();

  await send(chatId,
    `You're set up, ${name}.\n\n` +
    `Which trade show are you at right now? (Just type the name — e.g. "CES 2027".)`,
    env);
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;
}

async function cmdStartWithToken(chatId: number, firstName: string, token: string, env: Env): Promise<void> {
  // Re-use the existing onboarding_tokens table; a 'demobot' bot_role distinguishes
  // freelancer onboarding from boothbot/sourcebot. No schema change needed (TEXT col).
  const tok = await env.DB.prepare(
    `SELECT user_id, used_at, expires_at FROM onboarding_tokens
       WHERE token = ? AND bot_role = 'demobot'`
  ).bind(token).first<{ user_id: string; used_at: number | null; expires_at: number }>();

  if (!tok) {
    await send(chatId, 'That token isn\'t recognized. Generate a new one from the dashboard.', env);
    return;
  }
  if (tok.expires_at < Math.floor(Date.now() / 1000)) {
    await send(chatId, 'That token has expired. Generate a new one from the dashboard.', env);
    return;
  }

  // Verify the user is actually a freelancer
  const u = await env.DB.prepare(`SELECT id, role, name FROM users WHERE id = ?`)
    .bind(tok.user_id).first<{ id: string; role: string; name: string | null }>();
  if (!u || u.role !== 'freelancer') {
    await send(chatId, 'This token is not for a freelancer account.', env);
    return;
  }

  await env.DB.prepare(
    `INSERT INTO demobot_freelancers_telegram (freelancer_user_id, telegram_chat_id, telegram_username, session)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(freelancer_user_id) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id, telegram_username = excluded.telegram_username`
  ).bind(u.id, chatId, null, JSON.stringify({ step: 'awaiting_show_name' } as DemoSession)).run();

  await env.DB.prepare(`UPDATE onboarding_tokens SET used_at = ? WHERE token = ?`)
    .bind(Math.floor(Date.now() / 1000), token).run();

  await send(chatId,
    `Welcome, ${u.name ?? firstName}. You're set up.\n\n` +
    `Which trade show are you at right now? (Just type the name — e.g. "CES 2027".)`,
    env);
}

async function cmdHelp(chatId: number, env: Env): Promise<void> {
  await send(chatId,
    `*DaGama DemoBot*\n\n` +
    `Send a business card photo to demo it on the spot.\n\n` +
    `Commands:\n` +
    `• /show <name> — change the active trade show\n` +
    `• /myshow — what's the current active show\n` +
    `• /stats — your demos today\n` +
    `• /language <code> — override email language for the next scan (en, zh-CN, de, ar, …)\n` +
    `• /cancel — reset the current step\n\n` +
    `(After 2 weeks I'll ask you for a fresh show name automatically.)\n\n` +
    `After a card scan you can:\n` +
    `• Send a person photo (added to their sheet + PDF)\n` +
    `• Hold-record a voice note (transcribed + attached)`,
    env, true);
}

async function cmdShow(chatId: number, query: string, _freelancer: { id: string }, env: Env): Promise<void> {
  if (!query) { await cmdMyShow(chatId, env); return; }
  await setActiveShow(chatId, query, env);
}

async function cmdMyShow(chatId: number, env: Env): Promise<void> {
  const s = await getSession(chatId, env);
  if (s.activeShowName) {
    const days = s.activeShowSetAt ? Math.floor((Math.floor(Date.now() / 1000) - s.activeShowSetAt) / 86400) : null;
    const stale = s.activeShowSetAt && (Math.floor(Date.now() / 1000) - s.activeShowSetAt) > SHOW_STALENESS_SEC;
    await send(chatId,
      `Active show: *${s.activeShowName}*${days !== null ? ` (set ${days}d ago)` : ''}` +
      (stale ? `\n\n⏰ It\'s been over 2 weeks — type the show name you\'re at now to update.` : ''),
      env, true);
  } else {
    await send(chatId, 'No active show. Just type the show name (e.g. "CES 2027").', env);
  }
}

// Free-text show setter — no catalog lookup. Stores name + timestamp, clears
// awaiting_show_name step, and prompts for the first card.
async function setActiveShow(chatId: number, showName: string, env: Env): Promise<void> {
  const trimmed = showName.trim();
  if (trimmed.length < 2) {
    await send(chatId, 'Show name needs at least 2 characters. Try again.', env);
    return;
  }
  const session = await getSession(chatId, env);
  await setSession(chatId, {
    ...session,
    step: 'idle',
    activeShowName: trimmed,
    activeShowSetAt: Math.floor(Date.now() / 1000),
  }, env);
  await send(chatId,
    `📍 Active show: *${trimmed}*\n\nSend a business card photo to start your first demo.`,
    env, true);
}

async function cmdStats(chatId: number, freelancer: { id: string }, env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    `SELECT demos_count, conversions_count FROM demobot_freelancer_demos
      WHERE freelancer_user_id = ? AND day_local = ?`
  ).bind(freelancer.id, today).first<{ demos_count: number; conversions_count: number }>();

  const demos = r?.demos_count ?? 0;
  const conv  = r?.conversions_count ?? 0;
  const bonus = demos > 30 ? `+ $${demos - 30} demo bonus ` : '';
  await send(chatId,
    `Today: *${demos}* demos · *${conv}* conversions ${bonus}\n` +
    `Base $80/day · $1/demo over 30 · $3 per conversion within 30 days.`,
    env, true);
}

async function cmdLanguage(chatId: number, code: string, env: Env): Promise<void> {
  const allowed = ['en', 'zh-CN', 'de', 'ar', 'he', 'tr', 'ko', 'es', 'fr', 'pt'];
  const c = code.toLowerCase();
  if (!c) {
    await send(chatId, `Send /language <code>. Allowed: ${allowed.join(', ')}.`, env);
    return;
  }
  if (!allowed.includes(c)) {
    await send(chatId, `Unsupported language. Allowed: ${allowed.join(', ')}.`, env);
    return;
  }
  const session = await getSession(chatId, env);
  await setSession(chatId, { ...session, pendingLanguage: c }, env);
  await send(chatId, `Next scan will use language: *${c}*.`, env, true);
}

// ── Card scan flow ───────────────────────────────────────────────────────────

async function handleCardScan(
  chatId: number,
  photoSizes: TgPhotoSize[],
  caption: string,
  freelancer: { id: string },
  env: Env,
): Promise<void> {
  const session = await getSession(chatId, env);
  const now = Math.floor(Date.now() / 1000);
  const stale = session.activeShowSetAt && (now - session.activeShowSetAt) > SHOW_STALENESS_SEC;

  if (!session.activeShowName || stale) {
    // Park the freelancer in awaiting_show_name and ask for the show. They'll
    // re-send the card after they type the show name (one-shot resend).
    await setSession(chatId, { ...session, step: 'awaiting_show_name', activeShowName: undefined, activeShowSetAt: undefined }, env);
    await send(chatId,
      stale
        ? `⏰ It\'s been over 2 weeks since you set a show. Which show are you at now? (Just type the name — e.g. "Canton Fair Phase 1 2027".) Then resend the card.`
        : `Which trade show are you at? (Just type the name — e.g. "CES 2027".) Then resend the card.`,
      env);
    return;
  }

  await sendChatAction(chatId, 'typing', env);
  await send(chatId, '📸 Got the card. Extracting…', env);

  const photo = photoSizes[photoSizes.length - 1];
  const buf = await downloadTelegramFile(photo.file_id, env);
  if (!buf) { await send(chatId, '❌ Couldn\'t download the photo. Try again.', env); return; }

  const result = await runCardScan({
    freelancerUserId: freelancer.id,
    showId:           null,
    showName:         session.activeShowName,
    cardBytes:        buf,
    cardMimeType:     'image/jpeg',
    pendingLanguage:  session.pendingLanguage,
    env,
  });

  if (!result.ok) {
    await send(chatId, `${result.reason === 'no_email' ? '⚠️' : '❌'} ${result.message}`, env);
    return;
  }

  await setSession(chatId, { ...session, lastProspectId: result.prospectId, pendingLanguage: undefined }, env);
  const c = result.contact;

  // Reply first — the freelancer sees this as soon as the FAST path is done
  // (~10-15s). Email 1 + website analysis + PDF run after this in the
  // background phase below; the worker stays alive while they run.
  await sendButtons(chatId,
    `✅ *${escapeMd(c.name || 'Prospect')}* @ *${escapeMd(c.company || 'Unknown')}*\n` +
    `📧 ${escapeMd(c.email)}\n` +
    `📊 [Sheet](${result.bundle.sheetUrl})\n` +
    `📁 [Drive folder](${result.bundle.driveFolderUrl})\n\n` +
    `Email + PDF being generated… add a person photo or voice note while you wait?`,
    [
      [{ text: '📷 Add person photo', callback_data: 'demo_add_person' }],
      [{ text: '🎤 Add voice note',   callback_data: 'demo_add_voice'  }],
      [{ text: '➡️ Skip — next card',  callback_data: 'demo_skip_person' }],
    ],
    env, true);

  // Background enrichment — website analysis + Email 1 + follow-up scheduling
  // + PDF. Awaited so the Worker stays alive; the freelancer doesn't see this
  // latency since the reply already went out via sendButtons above.
  await backgroundEnrichProspect(result.prospectId, env);

  void caption;
}

async function handlePersonPhoto(
  chatId: number,
  photoSizes: TgPhotoSize[],
  session: DemoSession,
  env: Env,
): Promise<void> {
  if (!session.lastProspectId) { await send(chatId, 'No active prospect. Send a card first.', env); return; }

  await sendChatAction(chatId, 'typing', env);
  const photo = photoSizes[photoSizes.length - 1];
  const buf = await downloadTelegramFile(photo.file_id, env);
  if (!buf) { await send(chatId, '❌ Couldn\'t download.', env); return; }

  const desc = await describePersonPhoto(arrayBufferToBase64(buf), 'image/jpeg', env);

  // Upload to Person/ subfolder
  const p = await env.DB.prepare(
    `SELECT drive_folder_id, sheet_id, prospect_name, company FROM demobot_prospects WHERE id = ?`
  ).bind(session.lastProspectId).first<{ drive_folder_id: string | null; sheet_id: string | null; prospect_name: string | null; company: string | null }>();
  if (!p?.drive_folder_id) { await send(chatId, 'Prospect folder missing.', env); return; }

  const tok = await getServiceAccountToken(env);
  const personFolderId = await findChildFolderId(p.drive_folder_id, 'Person', tok);
  let photoUrl: string | null = null;
  if (personFolderId) {
    try {
      photoUrl = await uploadJpegToDrive(buf, sanitize(p.company ?? 'person'), personFolderId, 'image/jpeg', tok);
    } catch (e) { console.error('[demobot] person upload failed:', e); }
  }

  await env.DB.prepare(
    `UPDATE demobot_prospects SET person_photo_url = ?, person_description = ?, person_confidence = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(photoUrl, desc?.description ?? null, desc?.confidence ?? null, session.lastProspectId).run();

  // Update sheet K (photo) + L (description) — re-write the existing row 2.
  if (p.sheet_id && photoUrl) {
    try {
      const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
      const { toSheetsImageUrl } = await import('./sb_sheets');
      await fetch(`${SHEETS_API}/${p.sheet_id}/values/Contact!K2:L2?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[`=IMAGE("${toSheetsImageUrl(photoUrl)}")`, desc?.description ?? '']] }),
      });
    } catch (e) { console.error('[demobot] sheet person update failed:', e); }
  }

  await setSession(chatId, { ...session, step: 'idle' }, env);
  await send(chatId,
    desc
      ? `✅ Photo added — "${desc.description}"`
      : `✅ Photo added (description not generated; confidence too low).`,
    env);
}

async function handleVoiceNote(
  chatId: number,
  voice: TgVoice,
  session: DemoSession,
  env: Env,
): Promise<void> {
  if (!session.lastProspectId) { await send(chatId, 'No active prospect.', env); return; }

  await sendChatAction(chatId, 'typing', env);
  const buf = await downloadTelegramFile(voice.file_id, env);
  if (!buf) { await send(chatId, '❌ Couldn\'t download voice note.', env); return; }

  const transcript = await transcribeVoiceNote(arrayBufferToBase64(buf), voice.mime_type ?? 'audio/ogg', env);
  if (!transcript || transcript === '[unintelligible]') {
    await send(chatId, '⚠️ Couldn\'t transcribe — try recording somewhere quieter.', env);
    return;
  }

  const p = await env.DB.prepare(
    `SELECT sheet_id, voice_note_transcript FROM demobot_prospects WHERE id = ?`
  ).bind(session.lastProspectId).first<{ sheet_id: string | null; voice_note_transcript: string | null }>();

  const merged = p?.voice_note_transcript
    ? `${p.voice_note_transcript}\n---\n${transcript}`
    : transcript;
  await env.DB.prepare(
    `UPDATE demobot_prospects SET voice_note_transcript = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(merged, session.lastProspectId).run();

  if (p?.sheet_id) {
    await appendProspectVoiceNote(p.sheet_id, transcript, env)
      .catch(e => console.error('[demobot] voice sheet write failed:', e));
  }

  await setSession(chatId, { ...session, step: 'idle' }, env);
  await send(chatId, `✅ Transcribed and attached:\n\n_${escapeMd(transcript.slice(0, 400))}_`, env, true);
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function getFreelancerForChat(chatId: number, env: Env): Promise<{ id: string } | null> {
  const r = await env.DB.prepare(
    `SELECT freelancer_user_id FROM demobot_freelancers_telegram WHERE telegram_chat_id = ?`
  ).bind(chatId).first<{ freelancer_user_id: string }>();
  return r ? { id: r.freelancer_user_id } : null;
}

async function getSession(chatId: number, env: Env): Promise<DemoSession> {
  const r = await env.DB.prepare(
    `SELECT session FROM demobot_freelancers_telegram WHERE telegram_chat_id = ?`
  ).bind(chatId).first<{ session: string | null }>();
  try {
    return r?.session ? JSON.parse(r.session) as DemoSession : { step: 'idle' };
  } catch { return { step: 'idle' }; }
}

async function setSession(chatId: number, session: DemoSession, env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE demobot_freelancers_telegram SET session = ? WHERE telegram_chat_id = ?`
  ).bind(JSON.stringify(session), chatId).run();
}

// ── Telegram + Drive helpers ─────────────────────────────────────────────────

async function send(chatId: number, text: string, env: Env, markdown = false): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_DEMO}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: markdown ? 'Markdown' : undefined, disable_web_page_preview: true }),
  });
}

async function sendButtons(
  chatId: number,
  text: string,
  buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
  env: Env,
  markdown = false,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_DEMO}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: markdown ? 'Markdown' : undefined, disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
}

async function sendChatAction(chatId: number, action: 'typing' | 'upload_photo', env: Env): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_DEMO}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  }).catch(() => undefined);
}

async function downloadTelegramFile(fileId: string, env: Env): Promise<ArrayBuffer | null> {
  try {
    const meta = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_DEMO}/getFile?file_id=${fileId}`)
      .then(r => r.json()) as { result?: { file_path?: string } };
    const path = meta.result?.file_path;
    if (!path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN_DEMO}/${path}`);
    return res.ok ? res.arrayBuffer() : null;
  } catch (e) {
    console.error('[demobot] telegram file download failed:', e);
    return null;
  }
}

function escapeMd(s: string): string { return s.replace(/([_*`\[\]])/g, '\\$1'); }

// ─────────────────────────────────────────────────────────────────────────────
// Cron: hourly sweep — sends 6pm freelancer summaries.
// Called from index.ts scheduled() alongside the funnel + showpass crons.
// ─────────────────────────────────────────────────────────────────────────────

export async function handleDemoBotDailySummaryCron(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN_DEMO) return;
  const now = new Date();
  // Fire only between 18:00 and 18:59 UTC (best-effort; per-show TZ is a future enhancement).
  if (now.getUTCHours() !== 18) return;

  const today = now.toISOString().slice(0, 10);
  const due = await env.DB.prepare(
    `SELECT d.freelancer_user_id, d.demos_count, d.conversions_count, t.telegram_chat_id, u.name
       FROM demobot_freelancer_demos d
       JOIN demobot_freelancers_telegram t ON t.freelancer_user_id = d.freelancer_user_id
       JOIN users u ON u.id = d.freelancer_user_id
      WHERE d.day_local = ? AND d.summary_sent_at IS NULL`
  ).bind(today).all<{ freelancer_user_id: string; demos_count: number; conversions_count: number; telegram_chat_id: number; name: string | null }>();

  for (const r of due.results) {
    const bonus = r.demos_count > 30 ? r.demos_count - 30 : 0;
    const baseEarnings = 80;
    const total = baseEarnings + bonus;   // conversion bonus is paid out later
    await send(r.telegram_chat_id,
      `🌅 *Today's wrap*\n\n` +
      `Demos: *${r.demos_count}*\n` +
      `Conversions so far: *${r.conversions_count}*\n` +
      `Earnings today: *$${total}* ($80 base${bonus > 0 ? ` + $${bonus} demo bonus` : ''})\n\n` +
      `Conversion bonuses ($3/each) settle within 48h after the 30-day attribution window closes.`,
      env, true);
    await env.DB.prepare(
      `UPDATE demobot_freelancer_demos SET summary_sent_at = ? WHERE freelancer_user_id = ? AND day_local = ?`
    ).bind(Math.floor(Date.now() / 1000), r.freelancer_user_id, today).run();
  }
}

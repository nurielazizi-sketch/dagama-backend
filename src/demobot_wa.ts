/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import {
  fetchWhatsAppMedia,
  sendWhatsAppText,
  sendWhatsAppButtons,
  markWhatsAppRead,
} from './whatsapp';
import { runCardScan, backgroundEnrichProspect, findChildFolderId, uploadJpegToDrive, arrayBufferToBase64, sanitize } from './demobot_core';
import { describePersonPhoto, transcribeVoiceNote } from './db_enrich';
import { getServiceAccountToken } from './google';
import { appendProspectVoiceNote } from './db_sheets';
import { hashPassword } from './crypto';
import { trackEvent } from './funnel';

// ─────────────────────────────────────────────────────────────────────────────
// DemoBot WhatsApp handler. Mirrors the Telegram bot in src/demobot.ts
// (self-serve onboarding, scan flow, person photo, voice note) using
// WhatsApp's media + interactive-buttons API.
//
// Activated when wa_user_mappings.bot_role = 'demobot'. The router in
// whatsapp.ts flips an unassigned phone to 'demobot' when the user sends
// "demo" / "freelancer" / "join demo_<token>" — see handleUnassignedMessage
// below for the exact triggers.
//
// Session state lives JSON-encoded in wa_user_mappings.session.
// ─────────────────────────────────────────────────────────────────────────────

interface WaMessage {
  id:        string;
  from:      string;
  type:      string;
  text?:     { body: string };
  image?:    { id: string; mime_type?: string; caption?: string };
  audio?:    { id: string; mime_type?: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?:   { id: string; title: string; description?: string };
  };
}

interface WaMapping {
  id:           string;
  phone:        string;
  user_id:      string | null;
  buyer_id:     string | null;
  bot_role:     string;
  session:      string | null;
  display_name: string | null;
}

type DemoStep =
  | 'awaiting_email'
  | 'awaiting_name'
  | 'awaiting_show_name'
  | 'idle'
  | 'awaiting_person_photo'
  | 'awaiting_voice_note';

const SHOW_STALENESS_SEC = 14 * 24 * 3600;

interface DemoSession {
  step:                DemoStep;
  email?:              string;
  activeShowName?:     string;
  activeShowSetAt?:    number;          // unix seconds; used for 14d staleness check
  lastProspectId?:     string;
  pendingLanguage?:    string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — called by whatsapp.ts when bot_role === 'demobot'.
// ─────────────────────────────────────────────────────────────────────────────
export async function routeToDemoBot(msg: WaMessage, mapping: WaMapping, env: Env): Promise<void> {
  // Best-effort read receipt so the user sees "read" immediately.
  await markWhatsAppRead(msg.id, env).catch(() => undefined);

  const session = parseSession(mapping.session);

  // If the freelancer hasn't bound a user_id yet, they're mid self-serve registration.
  if (!mapping.user_id) {
    await handleRegistration(msg, mapping, session, env);
    return;
  }

  // Bound freelancer — dispatch by message type.
  if (msg.type === 'interactive' && msg.interactive) {
    await handleInteractive(msg, mapping, session, env);
    return;
  }
  if (msg.type === 'image' && msg.image) {
    if (session.step === 'awaiting_person_photo') {
      await handlePersonPhoto(msg, mapping, session, env);
    } else {
      await handleCardScan(msg, mapping, session, env);
    }
    return;
  }
  if (msg.type === 'audio' && msg.audio) {
    await handleVoiceNote(msg, mapping, session, env);
    return;
  }
  if (msg.type === 'text' && msg.text) {
    await handleText(msg.text.body.trim(), mapping, session, env);
    return;
  }

  await sendWhatsAppText(mapping.phone,
    `Send a business card photo to start a demo, or type "help" for commands.`,
    env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-serve registration — email then name. Mirrors Telegram cmdSelfServeStart.
// ─────────────────────────────────────────────────────────────────────────────
async function handleRegistration(msg: WaMessage, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  if (msg.type !== 'text' || !msg.text) {
    await sendWhatsAppText(mapping.phone,
      `Welcome to DaGama. To finish setup, what's your email address?`,
      env);
    return;
  }
  const text = msg.text.body.trim();

  if (session.step === 'awaiting_email' || !session.step || session.step === 'idle') {
    if (!isValidEmail(text)) {
      await sendWhatsAppText(mapping.phone,
        `Welcome to DaGama. What's your email address? (We'll use this for freelancer payouts and weekly summaries — e.g. you@gmail.com)`,
        env);
      await persistSession(mapping.id, { ...session, step: 'awaiting_email' }, env);
      return;
    }
    const email = text.toLowerCase();
    await persistSession(mapping.id, { ...session, step: 'awaiting_name', email }, env);
    await sendWhatsAppText(mapping.phone,
      `Got it. What's your full name? (This is what shows up on the prospect's emails.)`,
      env);
    return;
  }

  if (session.step === 'awaiting_name') {
    const name = text.trim();
    if (name.length < 2) {
      await sendWhatsAppText(mapping.phone, `Send your name (at least 2 characters).`, env);
      return;
    }
    const email = session.email;
    if (!email) {
      await persistSession(mapping.id, { step: 'awaiting_email' }, env);
      await sendWhatsAppText(mapping.phone, `Something went wrong — what's your email address?`, env);
      return;
    }

    const userId = await upsertFreelancer(email, name, env);
    if (!userId) {
      await sendWhatsAppText(mapping.phone, `Couldn't finish registration. Try again — what's your email?`, env);
      await persistSession(mapping.id, { step: 'awaiting_email' }, env);
      return;
    }

    // Bind mapping → freelancer user_id; bot_role stays 'demobot'. Park them
    // in awaiting_show_name so the next free-text message is treated as the show.
    await env.DB.prepare(
      `UPDATE wa_user_mappings SET user_id = ?, session = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(userId, JSON.stringify({ step: 'awaiting_show_name' } as DemoSession), mapping.id).run();

    await trackEvent(env, {
      buyerId: null,
      eventName: 'demobot_freelancer_registered',
      properties: { freelancer_user_id: userId, via: 'whatsapp_self_serve' },
    });

    await sendWhatsAppText(mapping.phone,
      `You're set up, ${name}.\n\nWhich trade show are you at right now? (Just type the name — e.g. "CES 2027".)`,
      env);
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text commands (post-registration). WhatsApp doesn't have slash commands —
// freelancers just type the verb.
// ─────────────────────────────────────────────────────────────────────────────
async function handleText(text: string, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  const lc = text.toLowerCase();

  if (lc === 'help' || lc === 'menu' || lc === '/help' || lc === '/menu') {
    await sendWhatsAppText(mapping.phone,
      `*DaGama DemoBot*\n\n` +
      `Send a business card photo to demo it on the spot.\n\n` +
      `Commands (just type them):\n` +
      `• show <name> — change the active trade show\n` +
      `• myshow — what's the current active show\n` +
      `• stats — your demos today\n` +
      `• language <code> — override email language for the next scan (en, zh-CN, de, ar, …)\n` +
      `• cancel — reset the current step\n\n` +
      `(After 2 weeks I'll ask you for a fresh show name automatically.)\n\n` +
      `After a card scan you can:\n` +
      `• Send a person photo (added to their sheet + PDF)\n` +
      `• Send a voice note (transcribed + attached)`,
      env);
    return;
  }
  if (lc === 'cancel' || lc === '/cancel') {
    await persistSession(mapping.id, { step: 'idle' }, env);
    await sendWhatsAppText(mapping.phone, `OK. Send a card photo when you're ready.`, env);
    return;
  }
  if (lc.startsWith('show ') || lc === 'show' || lc === 'myshow' || lc.startsWith('/show')) {
    const arg = text.replace(/^\/?(show|myshow)\s*/i, '').trim();
    await cmdShow(arg, mapping, session, env);
    return;
  }
  if (lc === 'stats' || lc === '/stats') {
    await cmdStats(mapping, env);
    return;
  }
  if (lc.startsWith('language ') || lc.startsWith('/language ')) {
    const code = text.replace(/^\/?language\s*/i, '').trim();
    await cmdLanguage(code, mapping, session, env);
    return;
  }

  // Awaiting show name (post-registration or 14d staleness): treat the text as the show.
  if (session.step === 'awaiting_show_name') {
    await setActiveShow(text, mapping, session, env);
    return;
  }

  if (session.step === 'awaiting_voice_note') {
    await sendWhatsAppText(mapping.phone, `Hold the mic in WhatsApp and record. I'll transcribe and attach.`, env);
    return;
  }

  await sendWhatsAppText(mapping.phone,
    `Send a business card photo to start a demo, or type "help" for commands.`,
    env);
}

async function cmdShow(query: string, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  if (!query) {
    if (session.activeShowName) {
      const days = session.activeShowSetAt ? Math.floor((Math.floor(Date.now() / 1000) - session.activeShowSetAt) / 86400) : null;
      const stale = session.activeShowSetAt && (Math.floor(Date.now() / 1000) - session.activeShowSetAt) > SHOW_STALENESS_SEC;
      await sendWhatsAppText(mapping.phone,
        `Active show: *${session.activeShowName}*${days !== null ? ` (set ${days}d ago)` : ''}` +
        (stale ? `\n\n⏰ It's been over 2 weeks — type the show name you're at now to update.` : ''),
        env);
    } else {
      await sendWhatsAppText(mapping.phone, `No active show. Just type the show name (e.g. "CES 2027").`, env);
    }
    return;
  }
  await setActiveShow(query, mapping, session, env);
}

async function setActiveShow(showName: string, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  const trimmed = showName.trim();
  if (trimmed.length < 2) {
    await sendWhatsAppText(mapping.phone, `Show name needs at least 2 characters. Try again.`, env);
    return;
  }
  await persistSession(mapping.id, {
    ...session,
    step: 'idle',
    activeShowName: trimmed,
    activeShowSetAt: Math.floor(Date.now() / 1000),
  }, env);
  await sendWhatsAppText(mapping.phone,
    `📍 Active show: *${trimmed}*\n\nSend a business card photo to start your first demo.`,
    env);
}

async function cmdStats(mapping: WaMapping, env: Env): Promise<void> {
  if (!mapping.user_id) return;
  const today = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    `SELECT demos_count, conversions_count FROM demobot_freelancer_demos
      WHERE freelancer_user_id = ? AND day_local = ?`
  ).bind(mapping.user_id, today).first<{ demos_count: number; conversions_count: number }>();
  const demos = r?.demos_count ?? 0;
  const conv  = r?.conversions_count ?? 0;
  const bonus = demos > 30 ? `+ $${demos - 30} demo bonus ` : '';
  await sendWhatsAppText(mapping.phone,
    `Today: *${demos}* demos · *${conv}* conversions ${bonus}\n` +
    `Base $80/day · $1/demo over 30 · $3 per conversion within 30 days.`,
    env);
}

async function cmdLanguage(code: string, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  const allowed = ['en', 'zh-CN', 'de', 'ar', 'he', 'tr', 'ko', 'es', 'fr', 'pt'];
  const c = code.toLowerCase();
  if (!c) {
    await sendWhatsAppText(mapping.phone, `Type "language <code>". Allowed: ${allowed.join(', ')}.`, env);
    return;
  }
  if (!allowed.includes(c)) {
    await sendWhatsAppText(mapping.phone, `Unsupported language. Allowed: ${allowed.join(', ')}.`, env);
    return;
  }
  await persistSession(mapping.id, { ...session, pendingLanguage: c }, env);
  await sendWhatsAppText(mapping.phone, `Next scan will use language: *${c}*.`, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Card scan flow — same shape as Telegram's, delegated to runCardScan().
// ─────────────────────────────────────────────────────────────────────────────
async function handleCardScan(msg: WaMessage, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  if (!mapping.user_id) return;

  const now = Math.floor(Date.now() / 1000);
  const stale = session.activeShowSetAt && (now - session.activeShowSetAt) > SHOW_STALENESS_SEC;

  if (!session.activeShowName || stale) {
    await persistSession(mapping.id, { ...session, step: 'awaiting_show_name', activeShowName: undefined, activeShowSetAt: undefined }, env);
    await sendWhatsAppText(mapping.phone,
      stale
        ? `⏰ It's been over 2 weeks since you set a show. Which show are you at now? (Just type the name — e.g. "Canton Fair Phase 1 2027".) Then resend the card.`
        : `Which trade show are you at? (Just type the name — e.g. "CES 2027".) Then resend the card.`,
      env);
    return;
  }

  await sendWhatsAppText(mapping.phone, `📸 Got the card. Extracting…`, env);

  const media = await fetchWhatsAppMedia(msg.image!.id, env);
  if (!media) {
    await sendWhatsAppText(mapping.phone, `❌ Couldn't download the photo. Try again.`, env);
    return;
  }

  const result = await runCardScan({
    freelancerUserId: mapping.user_id,
    showId:           null,
    showName:         session.activeShowName,
    cardBytes:        (media.bytes.buffer as ArrayBuffer),
    cardMimeType:     media.mimeType,
    pendingLanguage:  session.pendingLanguage,
    env,
  });

  if (!result.ok) {
    await sendWhatsAppText(mapping.phone, `${result.reason === 'no_email' ? '⚠️' : '❌'} ${result.message}`, env);
    return;
  }

  await persistSession(mapping.id, { ...session, lastProspectId: result.prospectId, pendingLanguage: undefined, step: 'idle' }, env);

  const c = result.contact;
  const summary =
    `✅ *${c.name || 'Prospect'}* @ *${c.company || 'Unknown'}*\n` +
    `📧 ${c.email}\n` +
    `📊 Sheet: ${result.bundle.sheetUrl}\n` +
    `📁 Drive: ${result.bundle.driveFolderUrl}\n\n` +
    `Email + PDF being generated… add a person photo or voice note while you wait?`;

  // Reply first; background enrichment runs after.
  await sendWhatsAppButtons(mapping.phone, summary, [
    { id: 'demo_add_person',  title: '📷 Person photo' },
    { id: 'demo_add_voice',   title: '🎤 Voice note' },
    { id: 'demo_skip_person', title: '➡️ Next card' },
  ], env, { sentBy: 'system' }).catch(async () => {
    // Buttons can fail outside the 24h window if no template is approved —
    // fall back to plain text + instructions.
    await sendWhatsAppText(mapping.phone,
      `${summary}\n\nReply with:\n• a photo of the person → adds it to their sheet\n• a voice note → transcribed + attached\n• "skip" → ready for the next card`,
      env);
  });

  // Website analysis + Email 1 + follow-ups + PDF run while the WA webhook
  // is still alive (well within Meta's 30s budget for our fast path; the
  // remainder finishes during the rest of this handler invocation).
  await backgroundEnrichProspect(result.prospectId, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Person photo — runs after the user taps the "Person photo" quick reply.
// ─────────────────────────────────────────────────────────────────────────────
async function handlePersonPhoto(msg: WaMessage, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  if (!session.lastProspectId) {
    await sendWhatsAppText(mapping.phone, `No active prospect. Send a card first.`, env);
    return;
  }
  const media = await fetchWhatsAppMedia(msg.image!.id, env);
  if (!media) { await sendWhatsAppText(mapping.phone, `❌ Couldn't download.`, env); return; }

  const desc = await describePersonPhoto(arrayBufferToBase64((media.bytes.buffer as ArrayBuffer)), media.mimeType, env);

  const p = await env.DB.prepare(
    `SELECT drive_folder_id, sheet_id, prospect_name, company FROM demobot_prospects WHERE id = ?`
  ).bind(session.lastProspectId).first<{ drive_folder_id: string | null; sheet_id: string | null; prospect_name: string | null; company: string | null }>();
  if (!p?.drive_folder_id) { await sendWhatsAppText(mapping.phone, `Prospect folder missing.`, env); return; }

  const tok = await getServiceAccountToken(env);
  const personFolderId = await findChildFolderId(p.drive_folder_id, 'Person', tok);
  let photoUrl: string | null = null;
  if (personFolderId) {
    try {
      photoUrl = await uploadJpegToDrive((media.bytes.buffer as ArrayBuffer), sanitize(p.company ?? 'person'), personFolderId, media.mimeType, tok);
    } catch (e) { console.error('[demobot/wa] person upload failed:', e); }
  }

  await env.DB.prepare(
    `UPDATE demobot_prospects SET person_photo_url = ?, person_description = ?, person_confidence = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(photoUrl, desc?.description ?? null, desc?.confidence ?? null, session.lastProspectId).run();

  if (p.sheet_id && photoUrl) {
    try {
      const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
      const { toSheetsImageUrl } = await import('./sb_sheets');
      await fetch(`${SHEETS_API}/${p.sheet_id}/values/Contact!K2:L2?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[`=IMAGE("${toSheetsImageUrl(photoUrl)}")`, desc?.description ?? '']] }),
      });
    } catch (e) { console.error('[demobot/wa] sheet person update failed:', e); }
  }

  await persistSession(mapping.id, { ...session, step: 'idle' }, env);
  await sendWhatsAppText(mapping.phone,
    desc
      ? `✅ Photo added — "${desc.description}"`
      : `✅ Photo added (description not generated; confidence too low).`,
    env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice note — runs after the user taps the "Voice note" quick reply OR sends
// any audio while a prospect is active.
// ─────────────────────────────────────────────────────────────────────────────
async function handleVoiceNote(msg: WaMessage, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  if (!session.lastProspectId) {
    await sendWhatsAppText(mapping.phone, `Send a card photo first; then I can attach a voice note to that prospect.`, env);
    return;
  }
  const media = await fetchWhatsAppMedia(msg.audio!.id, env);
  if (!media) { await sendWhatsAppText(mapping.phone, `❌ Couldn't download voice note.`, env); return; }

  const transcript = await transcribeVoiceNote(arrayBufferToBase64((media.bytes.buffer as ArrayBuffer)), media.mimeType, env);
  if (!transcript || transcript === '[unintelligible]') {
    await sendWhatsAppText(mapping.phone, `⚠️ Couldn't transcribe — try recording somewhere quieter.`, env);
    return;
  }

  const p = await env.DB.prepare(
    `SELECT sheet_id, voice_note_transcript FROM demobot_prospects WHERE id = ?`
  ).bind(session.lastProspectId).first<{ sheet_id: string | null; voice_note_transcript: string | null }>();
  const merged = p?.voice_note_transcript ? `${p.voice_note_transcript}\n---\n${transcript}` : transcript;

  await env.DB.prepare(
    `UPDATE demobot_prospects SET voice_note_transcript = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(merged, session.lastProspectId).run();

  if (p?.sheet_id) {
    await appendProspectVoiceNote(p.sheet_id, transcript, env)
      .catch(e => console.error('[demobot/wa] voice sheet write failed:', e));
  }

  await persistSession(mapping.id, { ...session, step: 'idle' }, env);
  await sendWhatsAppText(mapping.phone, `✅ Transcribed and attached:\n\n_${transcript.slice(0, 400)}_`, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive (button reply) — same callback ids as Telegram.
// ─────────────────────────────────────────────────────────────────────────────
async function handleInteractive(msg: WaMessage, mapping: WaMapping, session: DemoSession, env: Env): Promise<void> {
  const id = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id ?? '';
  if (id === 'demo_skip_person') {
    await persistSession(mapping.id, { ...session, step: 'idle' }, env);
    await sendWhatsAppText(mapping.phone, `Skipped. Send the next card whenever you're ready.`, env);
    return;
  }
  if (id === 'demo_add_person') {
    await persistSession(mapping.id, { ...session, step: 'awaiting_person_photo' }, env);
    await sendWhatsAppText(mapping.phone, `Send a photo of the prospect. I'll add it to their sheet.`, env);
    return;
  }
  if (id === 'demo_add_voice') {
    await persistSession(mapping.id, { ...session, step: 'awaiting_voice_note' }, env);
    await sendWhatsAppText(mapping.phone, `Hold the mic in WhatsApp and record. I'll transcribe and attach.`, env);
    return;
  }
  await sendWhatsAppText(mapping.phone, `Unrecognised choice — type "help" for commands.`, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function upsertFreelancer(email: string, name: string, env: Env): Promise<string | null> {
  const existing = await env.DB.prepare(`SELECT id, role FROM users WHERE email = ?`).bind(email).first<{ id: string; role: string }>();
  if (existing) {
    if (existing.role !== 'freelancer') {
      await env.DB.prepare(`UPDATE users SET role = 'freelancer' WHERE id = ?`).bind(existing.id).run();
    }
    await env.DB.prepare(
      `UPDATE users SET name = COALESCE(NULLIF(name, ''), ?) WHERE id = ?`
    ).bind(name, existing.id).run();
    return existing.id;
  }
  const placeholderPw = await hashPassword(crypto.randomUUID());
  const created = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'freelancer') RETURNING id`
  ).bind(email, name, placeholderPw).first<{ id: string }>();
  return created?.id ?? null;
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;
}

function parseSession(raw: string | null): DemoSession {
  if (!raw) return { step: 'awaiting_email' };
  try {
    const s = JSON.parse(raw) as Partial<DemoSession>;
    return {
      step: (s.step as DemoStep) ?? 'idle',
      email: s.email,
      activeShowName: s.activeShowName,
      activeShowSetAt: s.activeShowSetAt,
      lastProspectId: s.lastProspectId,
      pendingLanguage: s.pendingLanguage,
    };
  } catch {
    return { step: 'awaiting_email' };
  }
}

async function persistSession(mappingId: string, session: DemoSession, env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE wa_user_mappings SET session = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(JSON.stringify(session), mappingId).run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry hook used by whatsapp.ts handleUnassignedMessage — when a freelancer
// sends "demo" / "freelancer" / "join demo_<token>", flip the mapping to
// 'demobot' and start self-serve registration (or consume the token if
// admin-issued).
//
// Returns true if it claimed the message (caller should not run its default
// "sign up at heydagama.com" reply).
// ─────────────────────────────────────────────────────────────────────────────
export async function tryClaimAsDemoBot(text: string, mapping: WaMapping, env: Env): Promise<boolean> {
  const lc = text.trim().toLowerCase();

  // 1. Magic words to opt into freelancer flow
  if (lc === 'demo' || lc === 'freelancer' || lc === 'demobot') {
    await env.DB.prepare(
      `UPDATE wa_user_mappings SET bot_role = 'demobot', session = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(JSON.stringify({ step: 'awaiting_email' } as DemoSession), mapping.id).run();
    await sendWhatsAppText(mapping.phone,
      `Welcome to DaGama. To finish setup as a freelancer, what's your email address?`,
      env);
    return true;
  }

  // 2. Admin-issued deep link "join demo_<token>" (parallels Telegram /start <token>)
  const m = lc.match(/^join\s+demo_([a-f0-9-]+)$/i);
  if (m) {
    const token = m[1];
    const tok = await env.DB.prepare(
      `SELECT user_id, used_at, expires_at FROM onboarding_tokens WHERE token = ? AND bot_role = 'demobot'`
    ).bind(token).first<{ user_id: string; used_at: number | null; expires_at: number }>();
    if (tok && !tok.used_at && tok.expires_at >= Math.floor(Date.now() / 1000)) {
      const u = await env.DB.prepare(`SELECT id, name FROM users WHERE id = ?`).bind(tok.user_id).first<{ id: string; name: string | null }>();
      if (u) {
        await env.DB.prepare(`UPDATE users SET role = 'freelancer' WHERE id = ?`).bind(u.id).run();
        await env.DB.prepare(
          `UPDATE wa_user_mappings SET bot_role = 'demobot', user_id = ?, session = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(u.id, JSON.stringify({ step: 'awaiting_show_name' } as DemoSession), mapping.id).run();
        await env.DB.prepare(`UPDATE onboarding_tokens SET used_at = ? WHERE token = ?`)
          .bind(Math.floor(Date.now() / 1000), token).run();
        await sendWhatsAppText(mapping.phone,
          `Welcome${u.name ? `, ${u.name}` : ''}. You're set up.\n\nWhich trade show are you at right now? (Just type the name — e.g. "CES 2027".)`,
          env);
        return true;
      }
    }
    await sendWhatsAppText(mapping.phone, `That token isn't recognised or has expired. Generate a new one from the dashboard, or type "demo" to register manually.`, env);
    return true;
  }

  return false;
}

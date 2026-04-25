/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { ask, buildSummaryPrompt, buildFollowUpPrompt } from './gemini';
import { getOrCreateSheet, appendLeadRow, updateLeadEmailStatus, uploadCardPhotoToDrive, patchLeadNotes, updateLeadLinkedIn } from './sheets';
import { buildGmailAuthUrl, getGmailToken, getValidAccessToken, sendGmailEmail } from './gmail';
import { buildLinkedInSearchURL, isLinkedInProfileURL, cleanLinkedInURL } from './utils/linkedin';
import { getServiceAccountToken } from './google';
import { ocrThenExtract } from './extract';

// ── Telegram types ────────────────────────────────────────────────────────────

interface TgPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

interface TgVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
  photo?: TgPhotoSize[];
  voice?: TgVoice;
  reply_to_message?: { message_id: number };
}

interface TgCallbackQuery {
  id: string;
  from: { id: number; first_name: string; username?: string };
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ── Show Pass constants ───────────────────────────────────────────────────────

const SHOW_PASS_DURATION_SEC = 96 * 3600;
const GRACE_PERIOD_SEC       = 2  * 3600;
const WARNING_BEFORE_SEC     = 6  * 3600;

// ── Session ───────────────────────────────────────────────────────────────────

type SessionStep = 'idle' | 'await_show_text' | 'await_card' | 'await_note';

interface Session {
  step: SessionStep;
  lead: Partial<Lead>;
  pendingPhotoFileId?: string;
  cardFileId?: string;
  cardCenter?: { x: number; y: number };
  cardBbox?: { left: number; top: number; width: number; height: number };
  cardRotation?: 0 | 90 | 180 | 270;
  awaitingLinkedInForLeadId?: string;
}

interface Lead {
  name: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  country: string;
  website: string;
  linkedin: string;
  address: string;
  notes: string;
  show_name: string;
}

// ── Webhook handler ───────────────────────────────────────────────────────────

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = await request.json() as TgUpdate;
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query, env);
  }

  return new Response('OK', { status: 200 });
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO bot_users (chat_id, username) VALUES (?, ?)`
  ).bind(chatId, msg.from?.username ?? null).run();

  const session = await getSession(chatId, env);

  // LinkedIn-awaiting intercept — takes priority over all other text routing
  if (session.awaitingLinkedInForLeadId && msg.text) {
    const txt = msg.text.trim();
    if (txt === '/skip') {
      delete session.awaitingLinkedInForLeadId;
      await setSession(chatId, session, env);
      await send(chatId, 'No problem. Skipped.', env);
      return;
    }
    if (isLinkedInProfileURL(txt)) {
      await handleLinkedInURLReceived(chatId, session.awaitingLinkedInForLeadId, txt, env);
      return;
    }
    await send(chatId,
      `That doesn't look like a LinkedIn profile URL.\n\n` +
      `Expected format: linkedin.com/in/firstname-lastname\n\n` +
      `Send the URL or type /skip to skip.`,
      env,
    );
    return;
  }

  // Reply to a lead confirmation → update that lead
  if (msg.reply_to_message && (msg.text || msg.voice)) {
    const replied = await env.DB.prepare(
      `SELECT id, name, show_name, notes, sheet_row FROM leads WHERE chat_id = ? AND confirmation_message_id = ? LIMIT 1`
    ).bind(chatId, msg.reply_to_message.message_id).first<{ id: string; name: string; show_name: string; notes: string | null; sheet_row: number | null }>();
    if (replied) {
      await handleLeadReply(chatId, msg, replied, env);
      return;
    }
  }

  // Commands always take priority
  if (text === '/start' || text.startsWith('/start ')) {
    await cmdStart(chatId, msg.from?.first_name ?? 'there', env);
    return;
  }
  if (text === '/cancel') {
    await setSession(chatId, { step: 'idle', lead: {} }, env);
    await sendButtons(chatId, '❌ Cancelled.', [[{ text: '📸 Capture a lead', callback_data: 'new_lead' }]], env);
    return;
  }
  if (text === '/leads')        { await cmdLeads(chatId, env); return; }
  if (text === '/sheet')        { await cmdSheet(chatId, env); return; }
  if (text === '/summary')      { await cmdSummary(chatId, env); return; }
  if (text === '/help')         { await cmdHelp(chatId, env); return; }
  if (text === '/status')       { await cmdStatus(chatId, env); return; }
  if (text === '/connectgmail') { await cmdConnectGmail(chatId, env); return; }
  if (text.startsWith('/followup'))  { await cmdFollowup(chatId, text, env); return; }
  if (text.startsWith('/sendemail')) { await cmdSendEmail(chatId, text, env); return; }

  // In-flow handling
  if (session.step === 'await_show_text') {
    await handleShowEntry(chatId, text, session, env);
    return;
  }

  if (session.step === 'await_card') {
    if (msg.photo && msg.photo.length > 0) {
      await handleCardPhoto(chatId, msg.photo, session, env);
    } else {
      await send(chatId, '📸 Please send a photo of the business card, or tap *Cancel* to stop.', env, true);
    }
    return;
  }

  if (session.step === 'await_note') {
    if (msg.voice) {
      await handleVoiceNote(chatId, msg.voice, session, env);
    } else if (text) {
      await finishLead(chatId, text, session, env);
    }
    return;
  }

  // Idle — if user sent a photo, treat it as starting a lead capture
  if (msg.photo && msg.photo.length > 0) {
    const hasAccess = await checkSubscription(chatId, env);
    if (!hasAccess) {
      await sendButtons(chatId,
        '🔒 *No active plan*\n\nYou need a DaGama plan to capture leads.\n\nVisit heydagama.com to get started.',
        [[{ text: '🌐 Get a plan', url: 'https://heydagama.com' }]],
        env, true
      );
      return;
    }
    const photo = msg.photo.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a);
    await startLeadCapture(chatId, msg.from?.first_name ?? 'there', env, photo.file_id);
    return;
  }

  // Idle — show start prompt
  await cmdStart(chatId, msg.from?.first_name ?? 'there', env);
}

// ── Callback handler (button presses) ────────────────────────────────────────

async function handleCallback(cb: TgCallbackQuery, env: Env): Promise<void> {
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const data = cb.data ?? '';

  // Ack with a toast — visual + haptic feedback on mobile
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cb.id, text: toastForAction(data) }),
  });

  // Strip inline keyboard from the source message so a second tap can't reach stale buttons
  if (cb.message) await stripInlineKeyboard(chatId, cb.message.message_id, env);

  if (data === 'new_lead') {
    const hasAccess = await checkSubscription(chatId, env);
    if (!hasAccess) {
      await sendButtons(chatId,
        '🔒 *No active plan*\n\nYou need a DaGama plan to capture leads.\n\nVisit heydagama.com to get started.',
        [[{ text: '🌐 Get a plan', url: 'https://heydagama.com' }]],
        env, true
      );
      return;
    }
    await startLeadCapture(chatId, cb.from.first_name, env, undefined);
    return;
  }

  if (data.startsWith('show:')) {
    const showName = data.slice(5);
    const session = await getSession(chatId, env);
    const pendingFileId = session.pendingPhotoFileId;
    await createShowPass(chatId, showName, env);
    await setSession(chatId, { step: 'await_card', lead: { show_name: showName } }, env);
    if (pendingFileId) {
      await handleCardPhoto(chatId, [{ file_id: pendingFileId, width: 0, height: 0 }], { step: 'await_card', lead: { show_name: showName } }, env);
    } else {
      const label = showName === 'General' ? '📸 Send me a photo of the business card and I\'ll scan it automatically.' : `🎪 *${showName}*\n\n📸 Send me a photo of the business card and I'll scan it automatically.`;
      await send(chatId, label, env, showName !== 'General');
    }
    return;
  }

  if (data === 'new_show') {
    const session = await getSession(chatId, env);
    await setSession(chatId, { step: 'await_show_text', lead: {}, pendingPhotoFileId: session.pendingPhotoFileId }, env);
    await send(chatId, '✏️ Type the name of the trade show or event:', env);
    return;
  }

  if (data === 'confirm_lead') {
    const session = await getSession(chatId, env);
    if (session.step !== 'await_card') return; // guard against duplicate tap
    await setSession(chatId, { step: 'await_note', lead: session.lead, cardFileId: session.cardFileId, cardCenter: session.cardCenter, cardBbox: session.cardBbox, cardRotation: session.cardRotation }, env);
    await sendButtons(chatId,
      '📝 *Add a note about this lead?*\n\nYou can send a voice message, type a note, or skip.',
      [[{ text: '⏭️ Skip', callback_data: 'skip_note' }]],
      env, true
    );
    return;
  }

  if (data === 'retake_card') {
    const session = await getSession(chatId, env);
    const showName = session.lead.show_name ?? '';
    await setSession(chatId, { step: 'await_card', lead: { show_name: showName } }, env);
    await send(chatId, '📸 Send the business card photo again:', env);
    return;
  }

  if (data === 'scan_back') {
    const session = await getSession(chatId, env);
    await setSession(chatId, { step: 'await_card', lead: session.lead, pendingPhotoFileId: undefined }, env);
    await send(chatId, '📷 Send a photo of the *back* of the card and I\'ll merge the info.', env, true);
    return;
  }

  if (data === 'skip_note') {
    const session = await getSession(chatId, env);
    if (session.step !== 'await_note') return; // guard against duplicate tap
    // Flip step immediately so a concurrent tap sees 'idle' and exits
    await setSession(chatId, { step: 'idle', lead: session.lead, cardFileId: session.cardFileId, cardCenter: session.cardCenter, cardBbox: session.cardBbox, cardRotation: session.cardRotation }, env);
    await finishLead(chatId, '', session, env);
    return;
  }

  if (data === 'next_card') {
    const session = await getSession(chatId, env);
    const showName = session.lead.show_name ?? '';
    await setSession(chatId, { step: 'await_card', lead: { show_name: showName } }, env);
    await send(chatId, '📸 Send the next business card photo:', env);
    return;
  }

  if (data === 'view_leads') {
    await cmdLeads(chatId, env);
    return;
  }

  if (data === 'view_sheet') {
    await cmdSheet(chatId, env);
    return;
  }

  if (data.startsWith('li_search:')) {
    const leadId = data.slice('li_search:'.length);
    const lead = await env.DB.prepare(
      `SELECT id, name, company, linkedin FROM leads WHERE id = ?`
    ).bind(leadId).first<{ id: string; name: string; company: string | null; linkedin: string | null }>();

    if (!lead) {
      await send(chatId, 'Contact not found.', env);
      return;
    }

    const url = buildLinkedInSearchURL(lead.name, lead.company ?? '');
    // Remember we're awaiting a LinkedIn URL for this lead (10-min soft window is enforced by user UX, not by TTL)
    const session = await getSession(chatId, env);
    session.awaitingLinkedInForLeadId = lead.id;
    await setSession(chatId, session, env);

    await sendButtons(chatId,
      `🔍 *Find ${lead.name} on LinkedIn*\n\n` +
      `Tap below — LinkedIn opens pre-filled with name and company.\n\n` +
      `Found them? Copy their profile URL and send it here, or tap /skip.`,
      [[{ text: 'Search LinkedIn ↗', url }]],
      env, true,
    );
    return;
  }
}

// ── Show Pass helpers ─────────────────────────────────────────────────────────

interface ShowPass {
  id: string;
  show_name: string;
  status: string;
  pass_expires_at: number;
  grace_period_end: number;
}

async function getActiveShowPass(chatId: number, env: Env): Promise<ShowPass | null> {
  const now = Math.floor(Date.now() / 1000);
  return env.DB.prepare(
    `SELECT id, show_name, status, pass_expires_at, grace_period_end FROM buyer_shows
     WHERE chat_id = ? AND status IN ('active', 'grace') AND grace_period_end > ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(chatId, now).first<ShowPass>();
}

async function createShowPass(chatId: number, showName: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const passExpiresAt  = now + SHOW_PASS_DURATION_SEC;
  const gracePeriodEnd = passExpiresAt + GRACE_PERIOD_SEC;
  await env.DB.prepare(
    `INSERT INTO buyer_shows (chat_id, show_name, status, first_scan_at, pass_expires_at, grace_period_end)
     VALUES (?, ?, 'active', ?, ?, ?)`
  ).bind(chatId, showName, now, passExpiresAt, gracePeriodEnd).run();
}

// ── Lead capture flow ─────────────────────────────────────────────────────────

async function startLeadCapture(chatId: number, _firstName: string, env: Env, pendingPhotoFileId?: string): Promise<void> {
  // If user has an active Show Pass, skip show selection entirely
  const activePass = await getActiveShowPass(chatId, env);
  if (activePass) {
    const newSession: Session = { step: 'await_card', lead: { show_name: activePass.show_name } };
    await setSession(chatId, newSession, env);
    if (pendingPhotoFileId) {
      await handleCardPhoto(chatId, [{ file_id: pendingPhotoFileId, width: 0, height: 0 }], newSession, env);
    } else {
      await send(chatId, `🎪 *${activePass.show_name}*\n\n📸 Send me a photo of the business card.\n\n_Tip: phone directly above, fill the frame._`, env, true);
    }
    return;
  }

  const recentShows = await env.DB.prepare(
    `SELECT DISTINCT show_name FROM leads WHERE chat_id = ? AND show_name != 'General' ORDER BY created_at DESC LIMIT 5`
  ).bind(chatId).all<{ show_name: string }>();

  if (pendingPhotoFileId) {
    await setSession(chatId, { step: 'await_show_text', lead: {}, pendingPhotoFileId }, env);
  }

  if (recentShows.results.length > 0) {
    const showButtons = recentShows.results.map(r => ([{ text: `🎪 ${r.show_name}`, callback_data: `show:${r.show_name}` }]));
    showButtons.push([{ text: '➕ New show / event', callback_data: 'new_show' }]);
    showButtons.push([{ text: '📌 No specific show', callback_data: 'show:General' }]);
    await sendButtons(chatId, '📋 *Which show are you at?*', showButtons, env, true);
  } else {
    if (!pendingPhotoFileId) {
      await setSession(chatId, { step: 'await_show_text', lead: {} }, env);
    }
    await sendButtons(chatId,
      '📋 *What show or event are you at?*\n\n_(e.g. "Canton Fair 2026") — or tap below to skip_',
      [[{ text: '📌 No specific show', callback_data: 'show:General' }]],
      env, true
    );
  }
}

async function handleShowEntry(chatId: number, text: string, session: Session, env: Env): Promise<void> {
  if (!text) {
    await send(chatId, 'Please type the show name:', env);
    return;
  }
  const pendingFileId = session.pendingPhotoFileId;
  await createShowPass(chatId, text, env);
  await setSession(chatId, { step: 'await_card', lead: { show_name: text } }, env);
  if (pendingFileId) {
    await handleCardPhoto(chatId, [{ file_id: pendingFileId, width: 0, height: 0 }], { step: 'await_card', lead: { show_name: text } }, env);
  } else {
    await send(chatId, `🎪 *${text}*\n\n📸 Send me a photo of the business card and I'll scan it automatically.`, env, true);
  }
}

async function handleCardPhoto(chatId: number, photos: TgPhotoSize[], session: Session, env: Env): Promise<void> {
  await send(chatId, '🔍 Scanning business card…', env);

  const photo = photos.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a);

  let extracted: ScanResult;
  try {
    extracted = await scanBusinessCard(photos, env);
  } catch {
    await sendButtons(chatId,
      '⚠️ Could not scan the card. Try sending a clearer photo.',
      [[{ text: '📸 Try again', callback_data: 'retake_card' }, { text: '❌ Cancel', callback_data: 'new_lead' }]],
      env
    );
    return;
  }

  // Merge: prefer existing non-empty values, fill in blanks from new scan
  const cardCenter = extracted.cardCenter ?? undefined;
  const cardBbox = extracted.cardBbox ?? undefined;
  const cardRotation = extracted.cardRotation ?? 0;
  const merged: Partial<Lead> = { ...extracted };
  delete (merged as Record<string, unknown>).cardCenter;
  delete (merged as Record<string, unknown>).cardBbox;
  delete (merged as Record<string, unknown>).cardRotation;
  for (const key of Object.keys(session.lead) as Array<keyof Lead>) {
    if (session.lead[key]) merged[key] = session.lead[key] as never;
  }
  const lead = merged;
  await setSession(chatId, { step: 'await_card', lead, cardFileId: photo.file_id, cardCenter, cardBbox, cardRotation }, env);

  const preview =
    `✅ *Card scanned!*\n\n` +
    `📛 *Name:* ${lead.name || '—'}\n` +
    `💼 *Title:* ${lead.title || '—'}\n` +
    `🏢 *Company:* ${lead.company || '—'}\n` +
    `📧 *Email:* ${lead.email || '—'}\n` +
    `📞 *Phone:* ${lead.phone || '—'}\n` +
    (lead.country ? `🌍 *Country:* ${lead.country}\n` : '') +
    (lead.website ? `🌐 *Website:* ${lead.website}\n` : '') +
    (lead.linkedin ? `🔗 *LinkedIn:* ${lead.linkedin}\n` : '') +
    (lead.address ? `📍 *Address:* ${lead.address}\n` : '');

  await sendButtons(chatId, preview, [
    [{ text: '✅ Looks good', callback_data: 'confirm_lead' }, { text: '🔄 Retake', callback_data: 'retake_card' }],
    [{ text: '📷 Scan back of card', callback_data: 'scan_back' }],
  ], env, true);
}

async function handleVoiceNote(chatId: number, voice: TgVoice, session: Session, env: Env): Promise<void> {
  await send(chatId, '🎤 Transcribing voice note…', env);

  let transcription = '';
  try {
    transcription = await transcribeVoice(voice, env);
  } catch {
    await send(chatId, '⚠️ Could not transcribe voice. Saving lead without note.', env);
  }

  await finishLead(chatId, transcription, session, env);
}

async function finishLead(chatId: number, notes: string, session: Session, env: Env): Promise<void> {
  const lead = { ...session.lead, notes } as Lead;
  let leadId: string | null = null;
  try {
    const result = await saveLead(chatId, lead, session.cardFileId, session.cardCenter, session.cardBbox, session.cardRotation, env);
    leadId = result.leadId;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await send(chatId, `❌ Failed to save lead: ${msg}`, env);
    return;
  }
  await setSession(chatId, { step: 'idle', lead: { show_name: lead.show_name } }, env);

  const summary =
    `✅ *Lead saved!*\n\n` +
    `📛 ${lead.name || '—'}${lead.company ? ` · ${lead.company}` : ''}` +
    (lead.country ? ` · ${lead.country}` : '') +
    (lead.notes ? `\n📝 ${lead.notes}` : '') +
    `\n\n_💬 Reply to this message anytime to add notes or update details._`;

  const buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [{ text: '📸 Next card', callback_data: 'next_card' }, { text: '📋 My leads', callback_data: 'view_leads' }],
    [{ text: '📊 Google Sheet', callback_data: 'view_sheet' }],
  ];
  // LinkedIn row — show "Find" if empty, "Update" if already populated
  if (leadId) {
    const linkedinLabel = lead.linkedin ? '🔗 Update LinkedIn' : '🔍 Find on LinkedIn';
    buttons.push([{ text: linkedinLabel, callback_data: `li_search:${leadId}` }]);
  }

  const msgId = await sendButtons(chatId, summary, buttons, env, true);

  if (msgId && leadId) {
    await env.DB.prepare(`UPDATE leads SET confirmation_message_id = ? WHERE id = ?`).bind(msgId, leadId).run();
  }
}

// ── Business card scanner ─────────────────────────────────────────────────────

// Shape returned to the caller (handleCardPhoto).
type ScanResult = Partial<Lead> & {
  cardCenter?: { x: number; y: number } | null;
  cardBbox?: { left: number; top: number; width: number; height: number } | null;
  cardRotation?: 0 | 90 | 180 | 270;
};

// Telegram-specific glue — downloads the photo from Telegram's CDN and hands
// off to the shared OCR + Gemini extraction pipeline in src/extract.ts.
async function scanBusinessCard(photos: TgPhotoSize[], env: Env): Promise<ScanResult> {
  const photo = photos.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a);

  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${photo.file_id}`);
  const fileData = await fileRes.json() as { result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) throw new Error('Could not get file path');

  const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  const imgBuffer = await imgRes.arrayBuffer();
  const base64 = arrayBufferToBase64(imgBuffer);
  const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const result = await ocrThenExtract(base64, mimeType, env);
  return {
    name:         result.contact.name,
    title:        result.contact.title,
    company:      result.contact.company,
    email:        result.contact.email,
    phone:        result.contact.phone,
    website:      result.contact.website,
    linkedin:     result.contact.linkedin,
    address:      result.contact.address,
    country:      result.contact.country,
    cardCenter:   result.cardCenter,
    cardBbox:     result.cardBbox,
    cardRotation: result.rotation,
  };
}

// (Legacy OCR/Gemini extraction helpers used to live here. They moved to
//  src/extract.ts. To debug OCR or tune the extraction prompt, edit that
//  module — all three callers (BoothBot, SourceBot, queue) share it.)

// ── Voice transcription ───────────────────────────────────────────────────────

async function transcribeVoice(voice: TgVoice, env: Env): Promise<string> {
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${voice.file_id}`);
  const fileData = await fileRes.json() as { result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) throw new Error('Could not get voice file path');

  const audioRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  const audioBuffer = await audioRes.arrayBuffer();
  const base64 = arrayBufferToBase64(audioBuffer);

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Transcribe this voice note accurately. Return only the transcription text, no labels or explanations.' },
            { inlineData: { mimeType: 'audio/ogg', data: base64 } },
          ],
        }],
      }),
    }
  );

  const data = await geminiRes.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStart(chatId: number, firstName: string, env: Env): Promise<void> {
  await setSession(chatId, { step: 'idle', lead: {} }, env);

  const hasAccess = await checkSubscription(chatId, env);

  if (!hasAccess) {
    await sendButtons(chatId,
      `👋 *Welcome to DaGama, ${firstName}!*\n\nI help you capture leads at trade shows — just photograph a business card and I'll do the rest.\n\n🔒 You need a plan to start capturing.`,
      [[{ text: '🌐 Get started at heydagama.com', url: 'https://heydagama.com' }]],
      env, true
    );
    return;
  }

  const gmailToken = await getGmailToken(chatId, env);
  const gmailStatus = gmailToken
    ? `✅ Gmail connected as *${gmailToken.gmail_address}*`
    : `⚠️ Gmail not connected — run /connectgmail to enable email sending`;

  // 1. Welcome + commands (with action buttons)
  const welcome =
    `👋 *Welcome back, ${firstName}!*\n\n` +
    `${gmailStatus}\n\n` +
    `*Commands:*\n` +
    `📸 *Capture a lead* — photograph a business card\n` +
    `📋 /leads — see your recent leads\n` +
    `📊 /sheet — open your Google Sheet\n` +
    `🤖 /summary — AI analysis of your leads\n` +
    `📧 /connectgmail — link Gmail for email sending\n` +
    `✉️ /sendemail N — send follow-up to lead #N\n` +
    `✍️ /followup N — draft a follow-up for lead #N\n` +
    `❌ /cancel — cancel current action`;

  await sendButtons(chatId, welcome,
    [
      [{ text: '📸 Capture a lead', callback_data: 'new_lead' }],
      [{ text: '📋 My leads', callback_data: 'view_leads' }, { text: '📊 Google Sheet', callback_data: 'view_sheet' }],
    ],
    env, true
  );

  // 2. Photo tip image with caption
  const tipCaption =
    `*📸 Tips for a clean scan:*\n` +
    `• Hold the phone *directly above* the card\n` +
    `• Fill the frame — card edges near the photo edges\n` +
    `• Good lighting, avoid shadows & glare\n` +
    `• Card flat on a plain, contrasting surface`;
  await sendPhoto(
    chatId,
    'https://api.heydagama.com/_r2/assets/photo-tip.png',
    tipCaption,
    env,
    true,
  );
}

async function cmdHelp(chatId: number, env: Env): Promise<void> {
  await sendButtons(chatId,
    `*DaGama — Lead Capture Bot*\n\n` +
    `📸 Tap *Capture a lead* to start\n` +
    `📋 /leads — See your recent leads\n` +
    `📊 /sheet — Open your Google Sheet\n` +
    `🤖 /summary — AI analysis of your leads\n` +
    `📧 /connectgmail — Link Gmail to send emails\n` +
    `❌ /cancel — Cancel current action`,
    [[{ text: '📸 Capture a lead', callback_data: 'new_lead' }]],
    env, true
  );
}

async function cmdLeads(chatId: number, env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT name, company, email, linkedin, show_name, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10`
  ).bind(chatId).all<{ name: string; company: string; email: string; linkedin: string | null; show_name: string; created_at: string }>();

  if (!rows.results.length) {
    await sendButtons(chatId, 'No leads yet.', [[{ text: '📸 Capture your first lead', callback_data: 'new_lead' }]], env);
    return;
  }

  const lines = rows.results.map((l, i) => {
    const meta = [
      `🎪 ${l.show_name}`,
      l.email    ? `📧 ${l.email}`     : null,
      l.linkedin ? `🔗 ${l.linkedin}`  : null,
    ].filter(Boolean).join('  ');
    return `*${i + 1}. ${l.name}*${l.company ? ` — ${l.company}` : ''}\n   ${meta}`;
  }).join('\n\n');

  await sendButtons(chatId, `📋 *Your recent leads:*\n\n${lines}`,
    [[{ text: '📸 Capture another', callback_data: 'new_lead' }]],
    env, true
  );
}

async function cmdSheet(chatId: number, env: Env): Promise<void> {
  const botUser = await env.DB.prepare(
    `SELECT user_id FROM bot_users WHERE chat_id = ?`
  ).bind(chatId).first<{ user_id: string | null }>();

  if (!botUser?.user_id) {
    await send(chatId, '⚠️ Your Telegram is not linked to a DaGama account. Visit heydagama.com to sign up.', env);
    return;
  }

  const sheets = await env.DB.prepare(
    `SELECT show_name, sheet_url FROM google_sheets WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`
  ).bind(botUser.user_id).all<{ show_name: string; sheet_url: string }>();

  if (!sheets.results.length) {
    await sendButtons(chatId, '📊 No sheets yet. Capture your first lead to create one automatically.',
      [[{ text: '📸 Capture a lead', callback_data: 'new_lead' }]], env
    );
    return;
  }

  const buttons = sheets.results.map(s => ([{ text: `📋 ${s.show_name} Lead list ↗`, url: s.sheet_url }]));
  await sendButtons(chatId, '📊 *Your lead sheets:*', buttons, env, true);
}

async function cmdSummary(chatId: number, env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT name, company, email, notes, show_name, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(chatId).all<{ name: string; company: string; email: string; notes: string; show_name: string; created_at: string }>();

  if (!rows.results.length) {
    await sendButtons(chatId, 'No leads yet to analyze.',
      [[{ text: '📸 Capture a lead', callback_data: 'new_lead' }]], env
    );
    return;
  }

  await send(chatId, '🤖 Analyzing your leads…', env);
  const showName = rows.results[0].show_name;
  const showLeads = rows.results.filter(l => l.show_name === showName);

  try {
    const prompt = buildSummaryPrompt(showName, showLeads);
    const analysis = await ask(prompt, env.GEMINI_API_KEY);
    await send(chatId, `📊 *AI Analysis — ${showName}*\n\n${analysis}`, env, true);
  } catch {
    await send(chatId, '❌ AI analysis failed. Please try again later.', env);
  }
}

async function cmdFollowup(chatId: number, text: string, env: Env): Promise<void> {
  const n = parseInt(text.split(/\s+/)[1] ?? '1', 10);
  if (isNaN(n) || n < 1) { await send(chatId, 'Usage: /followup 1', env); return; }

  const rows = await env.DB.prepare(
    `SELECT name, company, email, notes, show_name, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10`
  ).bind(chatId).all<{ name: string; company: string; email: string; notes: string; show_name: string; created_at: string }>();

  const lead = rows.results[n - 1];
  if (!lead) { await send(chatId, `No lead #${n}. Use /leads to see your leads.`, env); return; }

  await send(chatId, `✍️ Drafting follow-up for *${lead.name}*…`, env, true);
  try {
    const email = await ask(buildFollowUpPrompt(lead, lead.show_name), env.GEMINI_API_KEY);
    await send(chatId, `📧 *Follow-up for ${lead.name}:*\n\n${email}`, env, true);
  } catch {
    await send(chatId, '❌ Failed to generate email. Please try again.', env);
  }
}

async function cmdStatus(chatId: number, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const pass = await env.DB.prepare(
    `SELECT show_name, status, pass_expires_at, grace_period_end FROM buyer_shows
     WHERE chat_id = ? AND status IN ('active', 'grace') AND grace_period_end > ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(chatId, now).first<{ show_name: string; status: string; pass_expires_at: number; grace_period_end: number }>();

  if (!pass) {
    await sendButtons(chatId, '⚫ No active Show Pass.\n\nCapture a lead to start a 96-hour pass for your current show.',
      [[{ text: '📸 Capture a lead', callback_data: 'new_lead' }]], env, true);
    return;
  }

  if (pass.status === 'active') {
    const secsLeft  = pass.pass_expires_at - now;
    const hoursLeft = Math.floor(secsLeft / 3600);
    const minsLeft  = Math.floor((secsLeft % 3600) / 60);
    await sendButtons(chatId,
      `🟢 *Active — ${pass.show_name}*\n\nPass expires in *${hoursLeft}h ${minsLeft}m*`,
      [[{ text: '📸 Next card', callback_data: 'next_card' }, { text: '📊 Open Sheet', callback_data: 'view_sheet' }]],
      env, true
    );
  } else {
    const secsLeft = Math.max(0, pass.grace_period_end - now);
    const minsLeft = Math.floor(secsLeft / 60);
    await sendButtons(chatId,
      `🟡 *Grace Period — ${pass.show_name}*\n\nPass ended. Scanning closes in *${minsLeft} min*.`,
      [[{ text: '📊 Open Sheet', callback_data: 'view_sheet' }]],
      env, true
    );
  }
}

async function cmdConnectGmail(chatId: number, env: Env): Promise<void> {
  const existing = await getGmailToken(chatId, env);
  if (existing) {
    await send(chatId, `✅ Gmail already connected as *${existing.gmail_address}*.\n\nUse /sendemail N to send follow-up emails.`, env, true);
    return;
  }
  const url = buildGmailAuthUrl(chatId, env);
  await sendButtons(chatId, `📧 *Connect your Gmail*\n\nOne-time setup. Emails will be sent from your own address.`, [[{ text: '🔗 Connect Gmail', url }]], env, true);
}

async function cmdSendEmail(chatId: number, text: string, env: Env): Promise<void> {
  const n = parseInt(text.split(/\s+/)[1] ?? '1', 10);
  if (isNaN(n) || n < 1) { await send(chatId, 'Usage: /sendemail 1', env); return; }

  const gmailToken = await getGmailToken(chatId, env);
  if (!gmailToken) { await send(chatId, '📧 Gmail not connected. Run /connectgmail first.', env); return; }

  const rows = await env.DB.prepare(
    `SELECT id, name, company, email, notes, show_name, sheet_row, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10`
  ).bind(chatId).all<{ id: string; name: string; company: string; email: string; notes: string; show_name: string; sheet_row: number | null; created_at: string }>();

  const lead = rows.results[n - 1];
  if (!lead) { await send(chatId, `No lead #${n}. Use /leads.`, env); return; }
  if (!lead.email) { await send(chatId, `❌ Lead #${n} (${lead.name}) has no email address.`, env); return; }

  await send(chatId, `✍️ Generating and sending email to *${lead.name}*…`, env, true);

  try {
    const emailText = await ask(buildFollowUpPrompt(lead, lead.show_name), env.GEMINI_API_KEY);
    const result = await sendGmailEmail(chatId, lead.email, emailText, env);
    await send(chatId, `✅ *Email sent to ${lead.email}!*\n\n📧 *Subject:* ${result.subject}\n🕐 *Sent:* ${result.sentAt}`, env, true);

    if (lead.sheet_row) {
      const tok = await resolveSheetToken(chatId, lead.show_name, env);
      if (tok) {
        try {
          await updateLeadEmailStatus(tok.sheetId, lead.sheet_row, { emailSent: 'Yes', emailSentAt: result.sentAt, emailSubject: result.subject, emailStatus: 'Sent' }, tok.token, env);
        } catch (e) { console.error('[cmdSendEmail] sheet status update failed:', e); }
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'GMAIL_NOT_CONNECTED') {
      await send(chatId, '📧 Gmail not connected. Run /connectgmail first.', env);
    } else {
      await send(chatId, `❌ Failed to send email: ${msg}`, env);
    }
  }
}

// ── Subscription gate ─────────────────────────────────────────────────────────

async function checkSubscription(chatId: number, env: Env): Promise<boolean> {
  // Check active show pass first (no user_id required)
  const activePass = await getActiveShowPass(chatId, env);
  if (activePass) return true;

  const botUser = await env.DB.prepare(
    `SELECT user_id FROM bot_users WHERE chat_id = ?`
  ).bind(chatId).first<{ user_id: string | null }>();

  if (!botUser?.user_id) return false;

  const sub = await env.DB.prepare(
    `SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1`
  ).bind(botUser.user_id).first();

  return !!sub;
}

// ── LinkedIn URL received (from /li_search flow) ─────────────────────────────

async function handleLinkedInURLReceived(
  chatId: number,
  leadId: string,
  rawUrl: string,
  env: Env,
): Promise<void> {
  const lead = await env.DB.prepare(
    `SELECT id, name, show_name, sheet_row FROM leads WHERE id = ?`
  ).bind(leadId).first<{ id: string; name: string; show_name: string; sheet_row: number | null }>();

  // Always clear the awaiting state, even on the error paths below
  const session = await getSession(chatId, env);
  delete session.awaitingLinkedInForLeadId;
  await setSession(chatId, session, env);

  if (!lead) {
    await send(chatId, 'Something went wrong — contact not found. Please try again.', env);
    return;
  }

  const cleanUrl = cleanLinkedInURL(rawUrl);

  // 1. Update D1
  await env.DB.prepare(`UPDATE leads SET linkedin = ? WHERE id = ?`).bind(cleanUrl, lead.id).run();

  // 2. Update Sheet column J — uses service-account or user Gmail token based on owner_type
  if (lead.sheet_row) {
    const tok = await resolveSheetToken(chatId, lead.show_name, env);
    if (tok) {
      try { await updateLeadLinkedIn(tok.sheetId, lead.sheet_row, cleanUrl, tok.token); }
      catch (e) { console.error('[handleLinkedInURLReceived] sheet update failed:', e); }
    }
  }

  await sendButtons(chatId,
    `✅ LinkedIn saved!\n\n${cleanUrl}`,
    [[{ text: '📸 Next card', callback_data: 'next_card' }, { text: '📋 My leads', callback_data: 'view_leads' }]],
    env,
  );
}

// ── Reply-to-lead update ──────────────────────────────────────────────────────

async function handleLeadReply(
  chatId: number,
  msg: TgMessage,
  lead: { id: string; name: string; show_name: string; notes: string | null; sheet_row: number | null },
  env: Env,
): Promise<void> {
  await send(chatId, `🔄 Updating lead *${lead.name}*…`, env, true);

  let addition = msg.text ?? '';
  if (msg.voice) {
    try {
      addition = await transcribeVoice(msg.voice, env);
    } catch {
      await send(chatId, '⚠️ Could not transcribe voice note.', env);
      return;
    }
  }

  if (!addition.trim()) return;

  // Resolve the right Google API token (service-account vs user's Gmail) once for both branches.
  const tokenForSheet = await resolveSheetToken(chatId, lead.show_name, env);

  // Auto-detect LinkedIn URLs in the reply — route to the linkedin field
  // instead of dumping the URL into notes.
  if (isLinkedInProfileURL(addition.trim())) {
    const cleanUrl = cleanLinkedInURL(addition.trim());
    await env.DB.prepare(`UPDATE leads SET linkedin = ? WHERE id = ?`).bind(cleanUrl, lead.id).run();
    if (tokenForSheet && lead.sheet_row) {
      try { await updateLeadLinkedIn(tokenForSheet.sheetId, lead.sheet_row, cleanUrl, tokenForSheet.token); }
      catch (e) { console.error('[handleLeadReply] sheet linkedin update failed:', e); }
    }
    await send(chatId, `✅ LinkedIn saved for *${lead.name}*:\n${cleanUrl}`, env, true);
    return;
  }

  // Otherwise append to notes (legacy behavior)
  const newNotes = lead.notes ? `${lead.notes}\n${addition}` : addition;
  await env.DB.prepare(`UPDATE leads SET notes = ? WHERE id = ?`).bind(newNotes, lead.id).run();

  if (tokenForSheet && lead.sheet_row) {
    try { await patchLeadNotes(tokenForSheet.sheetId, lead.sheet_row, newNotes, tokenForSheet.token); }
    catch (e) { console.error('[handleLeadReply] sheet notes update failed:', e); }
  }

  await send(chatId, `✅ Notes updated for *${lead.name}*:\n\n_${addition}_`, env, true);
}

// Resolve sheet_id + the right Google token (service-account vs user Gmail)
// for a given chat + show. Returns null if anything is missing — callers fall
// back to D1-only updates so we never block the user-visible flow.
async function resolveSheetToken(chatId: number, showName: string, env: Env): Promise<{ sheetId: string; token: string } | null> {
  const botUser = await env.DB.prepare(
    `SELECT user_id FROM bot_users WHERE chat_id = ?`
  ).bind(chatId).first<{ user_id: string | null }>();
  if (!botUser?.user_id) return null;

  const sheet = await env.DB.prepare(
    `SELECT sheet_id, owner_type FROM google_sheets WHERE user_id = ? AND show_name = ?`
  ).bind(botUser.user_id, showName).first<{ sheet_id: string; owner_type: string }>();
  if (!sheet?.sheet_id) return null;

  try {
    const token = sheet.owner_type === 'service_account'
      ? await getServiceAccountToken(env)
      : await getValidAccessToken(chatId, env);
    return { sheetId: sheet.sheet_id, token };
  } catch (e) {
    console.error('[resolveSheetToken] failed:', e);
    return null;
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function saveLead(
  chatId: number,
  lead: Lead,
  cardFileId: string | undefined,
  cardCenter: { x: number; y: number } | undefined,
  cardBbox: { left: number; top: number; width: number; height: number } | undefined,
  cardRotation: 0 | 90 | 180 | 270 | undefined,
  env: Env,
): Promise<{ leadId: string | null }> {
  const inserted = await env.DB.prepare(
    `INSERT INTO leads (chat_id, show_name, name, company, email, phone, title, website, linkedin, address, country, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(chatId, lead.show_name, lead.name || 'Unknown', lead.company || null, lead.email || null, lead.phone || null, lead.title || null, lead.website || null, lead.linkedin || null, lead.address || null, lead.country || null, lead.notes || null).first<{ id: string }>();
  const leadId = inserted?.id ?? null;

  try {
    const botUser = await env.DB.prepare(`SELECT user_id FROM bot_users WHERE chat_id = ?`).bind(chatId).first<{ user_id: string | null }>();
    if (botUser?.user_id) {
      // Pick the right token based on who owns the Sheet:
      //   - service_account → use the service-account JWT (new flow, no Gmail required)
      //   - user           → use the buyer's Gmail OAuth token (legacy flow)
      const sheetOwner = await env.DB.prepare(
        `SELECT owner_type FROM google_sheets WHERE user_id = ? AND show_name = ?`
      ).bind(botUser.user_id, lead.show_name).first<{ owner_type: string }>();

      let googleToken: string;
      if (sheetOwner?.owner_type === 'service_account') {
        googleToken = await getServiceAccountToken(env);
      } else {
        try {
          googleToken = await getValidAccessToken(chatId, env);
        } catch {
          // Gmail not connected yet — sheet sync skipped silently
          return { leadId };
        }
      }

      // Upload card photo to Drive (cropped via R2 + CF image transform)
      let cardPhotoUrl: string | undefined;
      if (cardFileId) {
        try {
          const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${cardFileId}`);
          const fileData = await fileRes.json() as { result?: { file_path?: string } };
          const filePath = fileData.result?.file_path;
          if (filePath) {
            const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
            const rawBuffer = await imgRes.arrayBuffer();

            // Upload raw to R2. The /_r2/<key> route (defined in src/index.ts) serves
            // the object's raw bytes via HTTP with no transformation applied — we need
            // a URL because cf.image transforms only work on fetch() responses.
            const r2Key = `tmp/${Date.now()}_${chatId}.jpg`;
            await env.R2_BUCKET.put(r2Key, rawBuffer, { httpMetadata: { contentType: 'image/jpeg' } });
            const r2Url = `https://api.heydagama.com/_r2/${r2Key}`;

            let croppedBuffer: ArrayBuffer = rawBuffer;

            if (cardBbox && cardBbox.width > 0 && cardBbox.height > 0) {
              console.log(`Card bbox detected: ${JSON.stringify(cardBbox)}`);
              // Get original image dimensions via cf.image format=json.
              // Fallback to 3000x2000 (typical landscape phone camera) if the call
              // fails — better to crop with slightly-off trim than skip cropping.
              let origW = 3000, origH = 2000;
              try {
                const metaRes = await fetch(r2Url, { cf: { image: { format: 'json' } } as RequestInitCfProperties });
                if (metaRes.ok) {
                  const meta = await metaRes.json() as { original?: { width?: number; height?: number }; width?: number; height?: number };
                  const w = meta.original?.width ?? meta.width;
                  const h = meta.original?.height ?? meta.height;
                  if (w && h && w > 0 && h > 0) { origW = w; origH = h; }
                  else console.log(`[crop] dims lookup returned null — using fallback ${origW}x${origH}`);
                } else {
                  console.log(`[crop] dims lookup status=${metaRes.status} — using fallback ${origW}x${origH}`);
                }
              } catch (e) {
                console.error(`[crop] dims lookup threw — using fallback ${origW}x${origH}:`, e);
              }

              const trim = {
                left:   Math.max(0, Math.floor((cardBbox.left   / 100) * origW)),
                top:    Math.max(0, Math.floor((cardBbox.top    / 100) * origH)),
                right:  Math.max(0, Math.floor(((100 - cardBbox.left - cardBbox.width)  / 100) * origW)),
                bottom: Math.max(0, Math.floor(((100 - cardBbox.top  - cardBbox.height) / 100) * origH)),
              };
              try {
                // CF applies operations in order: trim → rotate → fit/scale.
                // So `trim` coords stay in original-image space; `rotate` rotates the trimmed card.
                // fit: 'contain' with width 1600 upscales small crops (typical card is
                // only 300-400px after cropping a Telegram-compressed 720x1280 photo).
                // Stronger sharpen compensates for the upscale softness.
                const imageOps: Record<string, unknown> = {
                  metadata: 'none',
                  trim,
                  fit: 'contain',
                  width: 1600,
                  height: 1600,
                  sharpen: 2,
                  format: 'webp',
                  quality: 95,
                };
                if (cardRotation) imageOps.rotate = cardRotation;
                const cropRes = await fetch(r2Url, { cf: { image: imageOps } as RequestInitCfProperties });
                if (cropRes.ok) {
                  croppedBuffer = await cropRes.arrayBuffer();
                  console.log(`[crop] trim ok orig=${origW}x${origH} trim=${JSON.stringify(trim)} rotate=${cardRotation ?? 0}`);
                } else {
                  const body = await cropRes.text().catch(() => '');
                  console.error(`[crop] trim fetch failed status=${cropRes.status} body=${body.slice(0, 200)}`);
                  // Last-resort fallback: read raw bytes directly from R2 binding
                  const r2Obj = await env.R2_BUCKET.get(r2Key);
                  if (r2Obj) croppedBuffer = await r2Obj.arrayBuffer();
                }
              } catch (e) {
                console.error('[crop] trim fetch threw:', e);
                const r2Obj = await env.R2_BUCKET.get(r2Key);
                if (r2Obj) croppedBuffer = await r2Obj.arrayBuffer();
              }
            } else {
              console.log('Card bbox not detected, using full image');
              // Fallback: gravity-based cover crop from cardCenter
              const cx = cardCenter?.x ?? 0.5;
              const cy = cardCenter?.y ?? 0.5;
              const coverRes = await fetch(r2Url, {
                cf: {
                  image: {
                    metadata: 'none',
                    fit: 'cover',
                    width: 1600,
                    height: 914,
                    gravity: { x: cx, y: cy },
                    sharpen: 1.5,
                    format: 'webp',
                    quality: 85,
                  },
                } as RequestInitCfProperties,
              });
              if (coverRes.ok) croppedBuffer = await coverRes.arrayBuffer();
            }

            // Delete temp R2 file (best-effort)
            env.R2_BUCKET.delete(r2Key).catch(() => {});

            const namePart = (lead.name || 'card').replace(/[^a-z0-9]/gi, '_');
            const companyPart = lead.company ? `_${lead.company.replace(/[^a-z0-9]/gi, '_')}` : '';
            const fileName = `${namePart}${companyPart}.webp`;
            cardPhotoUrl = await uploadCardPhotoToDrive(
              fileName, croppedBuffer, 'image/webp', googleToken, lead.show_name,
              sheetOwner?.owner_type === 'service_account' ? env.SHARED_DRIVE_ID : undefined,
            );
          }
        } catch { /* photo upload is best-effort */ }
      }

      const { sheetId } = await getOrCreateSheet(botUser.user_id, lead.show_name, googleToken, env);
      const { rowIndex } = await appendLeadRow(sheetId, {
        timestamp: new Date().toISOString(),
        showName: lead.show_name || '',
        name: lead.name || 'Unknown',
        title: lead.title || '',
        company: lead.company || '',
        email: lead.email || '',
        phone: lead.phone || '',
        country: lead.country || '',
        website: lead.website || '',
        linkedin: lead.linkedin || '',
        address: lead.address || '',
        notes: lead.notes || '',
        cardPhotoUrl,
      }, googleToken, env);
      if (leadId) {
        await env.DB.prepare(`UPDATE leads SET sheet_row = ? WHERE id = ?`).bind(rowIndex, leadId).run();
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await send(chatId, `⚠️ Sheet sync error: ${msg.slice(0, 300)}`, env);
  }
  return { leadId };
}

async function getSession(chatId: number, env: Env): Promise<Session> {
  const row = await env.DB.prepare(`SELECT session FROM bot_users WHERE chat_id = ?`).bind(chatId).first<{ session: string | null }>();
  try {
    return row?.session ? JSON.parse(row.session) : { step: 'idle', lead: {} };
  } catch {
    return { step: 'idle', lead: {} };
  }
}

async function setSession(chatId: number, session: Session, env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE bot_users SET session = ? WHERE chat_id = ?`).bind(JSON.stringify(session), chatId).run();
}

// ── Telegram API helpers ──────────────────────────────────────────────────────

async function send(chatId: number, text: string, env: Env, markdown = false): Promise<number> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: markdown ? 'Markdown' : undefined,
    }),
  });
  const data = await res.json() as { result?: { message_id?: number } };
  return data.result?.message_id ?? 0;
}

async function sendPhoto(
  chatId: number,
  photoUrl: string,
  caption: string,
  env: Env,
  markdown = false,
  buttons?: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
): Promise<number> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: markdown ? 'Markdown' : undefined,
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { result?: { message_id?: number } };
  return data.result?.message_id ?? 0;
}

async function sendButtons(
  chatId: number,
  text: string,
  buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
  env: Env,
  markdown = false
): Promise<number> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: markdown ? 'Markdown' : undefined,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  const data = await res.json() as { result?: { message_id?: number } };
  return data.result?.message_id ?? 0;
}

async function stripInlineKeyboard(chatId: number, messageId: number, env: Env): Promise<void> {
  // Best-effort: remove buttons so duplicate taps can't reach them
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  }).catch(() => {});
}

function toastForAction(data: string): string {
  if (data === 'new_lead')      return '📸 Starting…';
  if (data.startsWith('show:')) return `🎪 ${data.slice(5)}`;
  if (data === 'new_show')      return '✏️ New show';
  if (data === 'confirm_lead')  return '✅ Looks good';
  if (data === 'retake_card')   return '🔄 Retake';
  if (data === 'scan_back')     return '📷 Scan back';
  if (data === 'skip_note')     return '💾 Saving…';
  if (data === 'next_card')     return '📸 Next card';
  if (data === 'view_leads')    return '📋 Loading…';
  if (data === 'view_sheet')    return '📊 Opening…';
  return '⏳';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
  }
  return btoa(binary);
}

// ── Show Pass cron sweep ──────────────────────────────────────────────────────

export async function handleShowPassCron(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // 1. Warn users whose pass expires within WARNING_BEFORE_SEC
  const toWarn = await env.DB.prepare(
    `SELECT id, chat_id, show_name, pass_expires_at FROM buyer_shows
     WHERE status = 'active' AND warning_sent = 0
       AND pass_expires_at - ? <= ? AND pass_expires_at > ?`
  ).bind(now, WARNING_BEFORE_SEC, now)
   .all<{ id: string; chat_id: number; show_name: string; pass_expires_at: number }>();

  for (const p of toWarn.results) {
    const hoursLeft = Math.floor((p.pass_expires_at - now) / 3600);
    await send(p.chat_id,
      `⏰ Your Show Pass for *${p.show_name}* ends in ${hoursLeft} hours. Finish capturing your last leads — your data is safe either way.`,
      env, true
    );
    await env.DB.prepare(`UPDATE buyer_shows SET warning_sent = 1 WHERE id = ?`).bind(p.id).run();
  }

  // 2. active → grace
  const toGrace = await env.DB.prepare(
    `SELECT id, chat_id, show_name FROM buyer_shows
     WHERE status = 'active' AND pass_expires_at <= ? AND grace_msg_sent = 0`
  ).bind(now).all<{ id: string; chat_id: number; show_name: string }>();

  for (const p of toGrace.results) {
    await env.DB.prepare(
      `UPDATE buyer_shows SET status = 'grace', updated_at = datetime('now') WHERE id = ?`
    ).bind(p.id).run();
    await sendButtons(p.chat_id,
      `Your 4-Day Show Pass for *${p.show_name}* has ended. You have a short window to finish any active captures. Tap to archive your leads.`,
      [[{ text: '📊 Archive & Export', callback_data: 'view_sheet' }]],
      env, true
    );
    await env.DB.prepare(`UPDATE buyer_shows SET grace_msg_sent = 1 WHERE id = ?`).bind(p.id).run();
  }

  // 3. grace → readonly (hard lock)
  const toLock = await env.DB.prepare(
    `SELECT id, chat_id, show_name FROM buyer_shows
     WHERE status = 'grace' AND grace_period_end <= ? AND lock_msg_sent = 0`
  ).bind(now).all<{ id: string; chat_id: number; show_name: string }>();

  for (const p of toLock.results) {
    await env.DB.prepare(
      `UPDATE buyer_shows SET status = 'readonly', updated_at = datetime('now') WHERE id = ?`
    ).bind(p.id).run();
    await sendButtons(p.chat_id,
      `🔒 Scanning is now closed for *${p.show_name}*. All your leads are saved in your Google Sheet.`,
      [[{ text: '📊 Open Sheet', callback_data: 'view_sheet' }]],
      env, true
    );
    await env.DB.prepare(`UPDATE buyer_shows SET lock_msg_sent = 1 WHERE id = ?`).bind(p.id).run();
  }
}

// ── Webhook registration ──────────────────────────────────────────────────────

export async function handleSetupWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { url?: string };
  try { body = await request.json() as typeof body; } catch { return new Response('Bad request', { status: 400 }); }
  if (!body.url) return new Response(JSON.stringify({ error: 'url is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${body.url}/api/telegram/webhook`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
    }),
  });

  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}

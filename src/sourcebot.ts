/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { consumeOnboardingToken } from './onboarding';
import { getServiceAccountToken, createDriveFolder } from './google';
import { appendSupplierRow, updateSupplierProducts, updateSupplierVoiceNote, updateSupplierEmailStatus, appendProductRow, updateProductRow, ensureProductsTab } from './sb_sheets';
import { buildGmailAuthUrl, getGmailToken, getValidAccessToken, sendGmailEmail } from './gmail';
import { ocrThenExtract } from './extract';

// ─────────────────────────────────────────────────────────────────────────────
// SourceBot Telegram webhook handler.
//
// This bot is for trade-show *buyers* capturing supplier business cards. It
// shares infrastructure with BoothBot (same Worker, same D1, same R2) but uses
// its own bot token (TELEGRAM_BOT_TOKEN_SOURCE), its own tables (sb_*), and
// its own Sheet schema (30 columns, sb_sheets.ts).
//
// MVP scope (this file): /start <token>, /start, /menu, /help, photo capture.
// Out of scope for now: /products, /email, /blast, /find, /compare, /pdf,
// voice notes, multi-supplier batches, catalog detection.
// ─────────────────────────────────────────────────────────────────────────────

interface TgPhotoSize { file_id: string; file_size?: number; width: number; height: number }
interface TgVoice    { file_id: string; duration: number; mime_type?: string; file_size?: number }
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
  photo?: TgPhotoSize[];
  voice?: TgVoice;
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

// ── SourceBot session ────────────────────────────────────────────────────────

type SourceBotStep =
  | 'idle'
  | 'awaiting_product_photo'
  | 'awaiting_product_name'
  | 'awaiting_product_price'
  | 'awaiting_product_moq'
  | 'awaiting_product_lead_time'
  | 'awaiting_voice_note';

interface SourceBotSession {
  step: SourceBotStep;
  activeCompanyId?: string;
  activeProductId?: string;
  activeEmailDraft?: { draftId: string; companyId: string; recipient: string; subject: string; body: string };
}

export async function handleSourceBotWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

  if (!env.TELEGRAM_BOT_TOKEN_SOURCE) {
    console.error('[sourcebot] TELEGRAM_BOT_TOKEN_SOURCE not set');
    return new Response('Bot not configured', { status: 503 });
  }

  let update: TgUpdate;
  try { update = await request.json() as TgUpdate; } catch { return new Response('Bad request', { status: 400 }); }

  if (update.message)        await handleMessage(update.message, env);
  else if (update.callback_query) await handleCallback(update.callback_query, env);
  return new Response('OK', { status: 200 });
}

// ── Message dispatch ─────────────────────────────────────────────────────────

async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();

  // /start [token] — link Telegram chat to buyer if token provided
  if (text === '/start' || text.startsWith('/start ')) {
    const arg = text.slice(7).trim();
    if (arg) await cmdStartWithToken(chatId, msg.from?.first_name ?? 'there', arg, env);
    else await cmdStart(chatId, msg.from?.first_name ?? 'there', env);
    return;
  }

  if (text === '/help' || text === '/menu') {
    await cmdHelp(chatId, env);
    return;
  }

  if (text === '/cancel' || text === '/done') {
    await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, `👍 Done. Send a supplier card photo to start again.`, env);
    return;
  }

  // Lookup the buyer for this chat_id; required for everything below
  const buyer = await getBuyerForChat(chatId, env);
  if (!buyer) {
    await send(chatId,
      `👋 Welcome to DaGama SourceBot.\n\n` +
      `It looks like you haven't connected your account yet. ` +
      `Open the welcome email we sent you and tap the Telegram link there to connect.`,
      env);
    return;
  }

  if (text === '/summary')                 { await cmdSummary(chatId, buyer, env); return; }
  if (text === '/find' || text.startsWith('/find ')) {
    const query = text.slice('/find'.length).trim();
    await cmdFind(chatId, query, buyer, env);
    return;
  }
  if (text === '/compare' || text.startsWith('/compare ')) {
    const query = text.slice('/compare'.length).trim();
    await cmdCompare(chatId, query, buyer, env);
    return;
  }
  if (text === '/email' || text.startsWith('/email ')) {
    const query = text.slice('/email'.length).trim();
    await cmdEmail(chatId, query, buyer, env);
    return;
  }
  if (text === '/connectgmail') {
    await cmdConnectGmail(chatId, env);
    return;
  }
  if (text === '/pending') { await cmdPending(chatId, buyer, env); return; }

  // ── Step machine: in-flow handling for the product capture sequence ──
  const session = await getSession(chatId, env);
  if (session.step === 'awaiting_product_photo') {
    if (msg.photo && msg.photo.length > 0) {
      await handleProductPhoto(chatId, msg.photo, session, buyer, env);
      return;
    }
    // Reply (text or voice) attaches details to the most recently saved product.
    if (msg.voice && session.activeProductId) {
      await handleProductDetailsVoice(chatId, msg.voice, session, buyer, env);
      return;
    }
    if (text && session.activeProductId) {
      await handleProductDetailsText(chatId, text, session, buyer, env);
      return;
    }
    // Fallback — no product yet, treat as company-level note
    if (msg.voice) {
      await handleVoiceNote(chatId, msg.voice, session, buyer, env);
      return;
    }
    if (text) {
      await handleDetailsText(chatId, text, session, buyer, env);
      return;
    }
    await send(chatId, `📸 Send a product photo, or reply to the last item to add details.`, env, true);
    return;
  }
  if (session.step === 'awaiting_voice_note') {
    // A photo arriving in voice-note mode means the user is moving on — exit the
    // voice prompt and process the photo as a product.
    if (msg.photo && msg.photo.length > 0) {
      await setSession(chatId, { step: 'awaiting_product_photo', activeCompanyId: session.activeCompanyId }, env);
      const refreshed = await getSession(chatId, env);
      await handleProductPhoto(chatId, msg.photo, refreshed, buyer, env);
      return;
    }
    if (msg.voice) {
      await handleVoiceNote(chatId, msg.voice, session, buyer, env);
      return;
    }
    if (text) {
      await handleDetailsText(chatId, text, session, buyer, env);
      return;
    }
    await send(chatId, `💬 Reply with text, hold 🎤 for a voice note, or send a product photo. /cancel to abort.`, env, true);
    return;
  }
  if (session.step === 'awaiting_product_price') {
    await handleProductPrice(chatId, text, session, buyer, env);
    return;
  }
  if (session.step === 'awaiting_product_moq') {
    await handleProductMoq(chatId, text, session, buyer, env);
    return;
  }
  if (session.step === 'awaiting_product_lead_time') {
    await handleProductLeadTime(chatId, text, session, buyer, env);
    return;
  }

  // Idle: a photo means a supplier card
  if (msg.photo && msg.photo.length > 0) {
    await handleSupplierCard(chatId, msg.photo, buyer, env);
    return;
  }

  // Anything else → gentle nudge
  await send(chatId, `📸 Send me a photo of a supplier's business card to save them to your sheet.`, env);
}

// ── Callback query dispatch ──────────────────────────────────────────────────

async function handleCallback(cb: TgCallbackQuery, env: Env): Promise<void> {
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const data = cb.data ?? '';

  // Always ack with a small toast
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cb.id, text: toastFor(data) }),
  });

  // Strip the keyboard so the user can't double-tap
  if (cb.message) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }),
    }).catch(() => {});
  }

  if (data.startsWith('add_product:')) {
    const companyId = data.slice('add_product:'.length);
    await setSession(chatId, { step: 'awaiting_product_photo', activeCompanyId: companyId }, env);
    await send(chatId, `📦 Send a *photo of the product* — I'll capture it and ask you a few quick details.`, env, true);
    return;
  }
  if (data.startsWith('add_voice:')) {
    const companyId = data.slice('add_voice:'.length);
    await setSession(chatId, { step: 'awaiting_voice_note', activeCompanyId: companyId }, env);
    await sendForceReply(chatId,
      `💬 *Reply to this message* with details about this supplier — type a note or hold 🎤 to record. ` +
      `I'll pull out any prices, MOQ, lead times, and tone you mention.`,
      env, true);
    return;
  }
  if (data === 'done_capturing') {
    await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, `👍 Done. Send the next supplier card whenever you're ready.`, env);
    return;
  }
  if (data === 'new_supplier') {
    await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, `📷 Send the next supplier's business card.`, env);
    return;
  }
  if (data === 'skip_field') {
    await advanceProductFlow(chatId, '', env);  // empty = "TBD"
    return;
  }
  if (data.startsWith('email_send:')) {
    const draftId = data.slice('email_send:'.length);
    const buyer = await getBuyerForChat(chatId, env);
    if (buyer) await sendDraftedEmail(chatId, draftId, buyer, env);
    return;
  }
  if (data === 'email_discard') {
    const session = await getSession(chatId, env);
    delete session.activeEmailDraft;
    await setSession(chatId, session, env);
    await send(chatId, `🗑 Draft discarded.`, env);
    return;
  }
}

function toastFor(data: string): string {
  if (data.startsWith('add_product:')) return '📦 Add product';
  if (data.startsWith('add_voice:'))   return '💬 Add details';
  if (data.startsWith('email_send:'))  return '📧 Sending…';
  if (data === 'email_discard')        return '🗑 Discarded';
  if (data === 'done_capturing')       return '✅ Done';
  if (data === 'new_supplier')         return '📷 New supplier';
  if (data === 'skip_field')           return '⏭ Skip';
  return '⏳';
}

// ── /start handlers ──────────────────────────────────────────────────────────

async function cmdStart(chatId: number, firstName: string, env: Env): Promise<void> {
  const buyer = await getBuyerForChat(chatId, env);
  if (buyer) {
    await send(chatId,
      `👋 Welcome back, ${firstName}!\n\n` +
      `📸 Send me a supplier's business card photo and I'll save them to your sheet.`,
      env);
    return;
  }
  await send(chatId,
    `👋 Welcome to DaGama SourceBot, ${firstName}.\n\n` +
    `To get started, open the welcome email we sent you and tap the Telegram link.`,
    env);
}

async function cmdStartWithToken(chatId: number, firstName: string, token: string, env: Env): Promise<void> {
  const claim = await consumeOnboardingToken(token, env);
  if (!claim) {
    await send(chatId,
      `❌ That onboarding link is invalid or has expired.\n\n` +
      `Please request a new welcome email or contact support.`, env);
    return;
  }
  if (claim.botRole !== 'sourcebot') {
    await send(chatId, `That link is for a different bot. Open it via the right link from your welcome email.`, env);
    return;
  }

  // Find the sb_buyers row for this user_id
  const buyer = await env.DB.prepare(
    `SELECT id FROM sb_buyers WHERE user_id = ?`
  ).bind(claim.userId).first<{ id: string }>();
  if (!buyer) {
    await send(chatId, `Account not fully provisioned. Please complete signup at heydagama.com first.`, env);
    return;
  }

  // Map this chat_id to the buyer (idempotent)
  await env.DB.prepare(
    `INSERT INTO sb_buyers_telegram (buyer_id, telegram_chat_id) VALUES (?, ?)
     ON CONFLICT(telegram_chat_id) DO UPDATE SET buyer_id = excluded.buyer_id`
  ).bind(buyer.id, chatId).run();

  await send(chatId,
    `✅ Connected, ${firstName}!\n\n` +
    `📸 Send a supplier's business card photo to start capturing leads. ` +
    `I'll extract their contact info and write it straight to your Google Sheet.`,
    env);
}

async function cmdHelp(chatId: number, env: Env): Promise<void> {
  await send(chatId,
    `*DaGama SourceBot — quick reference*\n\n` +
    `📸 Send a business card photo to save the supplier\n` +
    `📦 After saving, tap *Add product* to capture products\n` +
    `🎤 Tap *Voice note* to record a memo about a supplier\n\n` +
    `*Commands*\n` +
    `/find <query> — search your captured suppliers, contacts, products, voice notes\n` +
    `/compare <product> — AI comparison of a product across your suppliers\n` +
    `/summary — AI summary of suppliers at this show\n` +
    `/email <supplier> — draft and send a follow-up email\n` +
    `/pending — list suppliers you haven't emailed yet\n` +
    `/connectgmail — connect your Gmail to send emails from your own address\n` +
    `/cancel — stop the current step\n` +
    `/help — show this message`,
    env, true);
}

// ── /find ────────────────────────────────────────────────────────────────────

async function cmdFind(chatId: number, query: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!query) {
    await send(chatId, `Usage: \`/find led panel\` — searches across your suppliers, contacts, products, and voice notes.`, env, true);
    return;
  }
  const like = `%${query}%`;

  // Combined search across all four tables, scored loosely by table priority
  const rows = await env.DB.prepare(
    `SELECT type, company_id, company_name, context FROM (
       SELECT 'company' AS type, c.id AS company_id, c.name AS company_name, '' AS context
         FROM sb_companies c
         WHERE c.buyer_id = ? AND c.name LIKE ?
       UNION ALL
       SELECT 'contact', co.company_id, c.name, COALESCE(co.name,'') || (CASE WHEN co.email IS NOT NULL THEN ' · ' || co.email ELSE '' END)
         FROM sb_contacts co JOIN sb_companies c ON c.id = co.company_id
         WHERE co.buyer_id = ? AND (co.name LIKE ? OR co.email LIKE ? OR co.phone LIKE ?)
       UNION ALL
       SELECT 'product', p.company_id, c.name, p.name || (CASE WHEN p.price IS NOT NULL THEN ' · ' || p.price ELSE '' END)
         FROM sb_products p JOIN sb_companies c ON c.id = p.company_id
         WHERE p.buyer_id = ? AND p.name LIKE ?
       UNION ALL
       SELECT 'voice', v.company_id, c.name, substr(v.transcript, 1, 120)
         FROM sb_voice_notes v JOIN sb_companies c ON c.id = v.company_id
         WHERE v.buyer_id = ? AND v.transcript LIKE ?
     )
     LIMIT 15`
  ).bind(
    buyer.buyerId, like,
    buyer.buyerId, like, like, like,
    buyer.buyerId, like,
    buyer.buyerId, like,
  ).all<{ type: string; company_id: string; company_name: string; context: string }>();

  if (!rows.results.length) {
    await send(chatId, `🔍 No matches for *${query}*.`, env, true);
    return;
  }

  const icon = (t: string) => t === 'company' ? '🏢' : t === 'contact' ? '👤' : t === 'product' ? '📦' : '🎤';
  const lines = rows.results.map(r =>
    `${icon(r.type)} *${r.company_name}*${r.context ? ` — ${r.context}` : ''}`
  ).join('\n');

  await send(chatId, `🔍 *Results for "${query}":*\n\n${lines}`, env, true);
}

// ── /compare ─────────────────────────────────────────────────────────────────

async function cmdCompare(chatId: number, query: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!query) {
    await send(chatId, `Usage: \`/compare led panel\` — finds matching products across your suppliers and ranks them.`, env, true);
    return;
  }
  const like = `%${query}%`;

  const matches = await env.DB.prepare(
    `SELECT p.name AS product, p.price, p.moq, p.lead_time, p.notes, c.name AS supplier, c.website
       FROM sb_products p JOIN sb_companies c ON c.id = p.company_id
      WHERE p.buyer_id = ? AND p.name LIKE ?
      ORDER BY p.created_at DESC
      LIMIT 30`
  ).bind(buyer.buyerId, like).all<{ product: string | null; price: string | null; moq: string | null; lead_time: string | null; notes: string | null; supplier: string; website: string | null }>();

  if (!matches.results.length) {
    await send(chatId, `🔍 No matching products for *${query}*. Capture more product photos and try again.`, env, true);
    return;
  }

  if (matches.results.length === 1) {
    const m = matches.results[0];
    await send(chatId,
      `Only one match — nothing to compare yet:\n\n` +
      `📦 *${m.product ?? '—'}* from *${m.supplier}*\n` +
      (m.price ? `💰 ${m.price}\n` : '') + (m.moq ? `📊 MOQ ${m.moq}\n` : '') + (m.lead_time ? `⏱ ${m.lead_time}\n` : ''),
      env, true);
    return;
  }

  await send(chatId, `🤖 Comparing ${matches.results.length} match${matches.results.length === 1 ? '' : 'es'} across your suppliers…`, env);

  const corpus = matches.results.map((m, i) =>
    `${i + 1}. ${m.product ?? '—'} from ${m.supplier}${m.website ? ` (${m.website})` : ''}` +
    `${m.price     ? ` · price ${m.price}`    : ''}` +
    `${m.moq       ? ` · MOQ ${m.moq}`        : ''}` +
    `${m.lead_time ? ` · lead time ${m.lead_time}` : ''}` +
    `${m.notes     ? ` · notes: ${m.notes.slice(0, 100)}` : ''}`,
  ).join('\n');

  const prompt =
    `A buyer is comparing offers for "${query}" from multiple suppliers they've captured at a trade show. ` +
    `Here is what they have:\n\n${corpus}\n\n` +
    `Write a concise comparison in plain text (no markdown headings). Cover: best price, ` +
    `best MOQ, fastest lead time, and an overall recommendation with one sentence of reasoning. ` +
    `If a supplier has missing data (TBD, blank), call that out. Keep it under 8 sentences.`;

  let analysis = '';
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
    if (!data.candidates?.length) throw new Error(data.error?.message ?? 'no candidates');
    analysis = (data.candidates[0]?.content?.parts?.[0]?.text ?? '').trim();
  } catch (e) {
    console.error('[sourcebot] compare failed:', e);
    await send(chatId, `❌ Couldn't run the comparison. Try again later.`, env);
    return;
  }

  if (!analysis) {
    await send(chatId, `⚠️ The model returned an empty response. Try again later.`, env);
    return;
  }

  await send(chatId, `📊 *${query} — comparison*\n\n${analysis}`, env, true);
}

// ── /connectgmail ────────────────────────────────────────────────────────────

async function cmdConnectGmail(chatId: number, env: Env): Promise<void> {
  const existing = await getGmailToken(chatId, env);
  if (existing) {
    await send(chatId, `✅ Gmail already connected as *${existing.gmail_address}*. Use /email <supplier> to draft and send.`, env, true);
    return;
  }
  const url = buildGmailAuthUrl(chatId, env, 'sourcebot');
  await sendButtons(chatId,
    `📧 *Connect your Gmail*\n\nFollow-up emails will be sent from your own address — recipients reply to you.`,
    [[{ text: '🔗 Connect Gmail', url }]],
    env, true);
}

// ── /email ───────────────────────────────────────────────────────────────────

async function cmdEmail(chatId: number, query: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!query) {
    await send(chatId, `Usage: \`/email <supplier name>\` — drafts a follow-up to that supplier's first contact email.`, env, true);
    return;
  }

  // 1. Find the supplier (latest match if multiple)
  const company = await env.DB.prepare(
    `SELECT id, name, show_name, sheet_row FROM sb_companies
       WHERE buyer_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId, `%${query}%`).first<{ id: string; name: string; show_name: string; sheet_row: number | null }>();
  if (!company) {
    await send(chatId, `🔍 No supplier matching *${query}*. Try /find first.`, env, true);
    return;
  }

  // 2. Find a contact with an email
  const contact = await env.DB.prepare(
    `SELECT name, title, email FROM sb_contacts
       WHERE company_id = ? AND email IS NOT NULL AND email != ''
       ORDER BY created_at LIMIT 1`
  ).bind(company.id).first<{ name: string | null; title: string | null; email: string }>();
  if (!contact) {
    await send(chatId, `❌ *${company.name}* has no contact email on file. Add the contact's email first.`, env, true);
    return;
  }

  // 3. Make sure Gmail is connected
  const gmailToken = await getGmailToken(chatId, env);
  if (!gmailToken) {
    const url = buildGmailAuthUrl(chatId, env, 'sourcebot');
    await sendButtons(chatId,
      `📧 To send emails from your own address, connect your Gmail first.`,
      [[{ text: '🔗 Connect Gmail', url }]],
      env, true);
    return;
  }

  // 4. Build the draft context
  const products = await env.DB.prepare(
    `SELECT name, price, moq, lead_time FROM sb_products WHERE company_id = ? ORDER BY created_at LIMIT 6`
  ).bind(company.id).all<{ name: string | null; price: string | null; moq: string | null; lead_time: string | null }>();
  const voiceNotes = await env.DB.prepare(
    `SELECT transcript FROM sb_voice_notes WHERE company_id = ? ORDER BY created_at LIMIT 3`
  ).bind(company.id).all<{ transcript: string }>();

  await send(chatId, `✍️ Drafting an email to *${contact.name ?? contact.email}* at *${company.name}*…`, env, true);

  const draft = await draftFollowUpEmail({
    buyerName: '',  // could fetch from sb_buyers; OK to omit, Gemini fills in
    showName: company.show_name,
    company: company.name,
    contactName: contact.name ?? '',
    contactTitle: contact.title ?? '',
    products: products.results.map(p =>
      `${p.name ?? ''}${p.price ? ` (${p.price})` : ''}${p.moq ? ` MOQ ${p.moq}` : ''}${p.lead_time ? ` LT ${p.lead_time}` : ''}`),
    voiceNotes: voiceNotes.results.map(v => v.transcript.slice(0, 240)),
  }, env);

  if (!draft.subject || !draft.body) {
    await send(chatId, `❌ Couldn't draft the email. Try again later.`, env);
    return;
  }

  // 5. Stash the draft in the session and show it for confirmation
  const draftId = crypto.randomUUID();
  const session = await getSession(chatId, env);
  await setSession(chatId, {
    ...session,
    activeEmailDraft: { draftId, companyId: company.id, recipient: contact.email, subject: draft.subject, body: draft.body },
  }, env);

  const preview =
    `📧 *Draft for ${contact.email}*\n\n` +
    `*Subject:* ${draft.subject}\n\n` +
    `${draft.body}`;
  await sendButtons(chatId, preview,
    [[{ text: '✅ Send', callback_data: `email_send:${draftId}` },
      { text: '🗑 Discard', callback_data: 'email_discard' }]],
    env, true);
}

async function sendDraftedEmail(chatId: number, draftId: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  const session = await getSession(chatId, env);
  const draft = session.activeEmailDraft;
  if (!draft || draft.draftId !== draftId) {
    await send(chatId, `That draft isn't available anymore. Run /email again to start a new one.`, env);
    return;
  }

  // Clear the draft from session immediately to prevent double-tap
  await setSession(chatId, { ...session, activeEmailDraft: undefined }, env);

  // Compose RFC-2822 text. gmail.ts's sendGmailEmail expects "Subject: …\n\nbody"
  const rawEmailText = `Subject: ${draft.subject}\n\n${draft.body}`;

  const company = await env.DB.prepare(
    `SELECT name, show_name, sheet_row FROM sb_companies WHERE id = ?`
  ).bind(draft.companyId).first<{ name: string; show_name: string; sheet_row: number | null }>();

  try {
    const result = await sendGmailEmail(chatId, draft.recipient, rawEmailText, env);
    const sentAt = result.sentAt;

    // Log to D1
    await env.DB.prepare(
      `INSERT INTO sb_emails_sent
         (company_id, buyer_id, show_name, recipient_email, subject, body, status, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)`
    ).bind(draft.companyId, buyer.buyerId, company?.show_name ?? '', draft.recipient, draft.subject, draft.body, sentAt).run();

    // Update sheet columns V/W/X/Y on the supplier row
    if (company?.sheet_row) {
      try {
        const sheet = await env.DB.prepare(
          `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
        ).bind(buyer.buyerId, company.show_name).first<{ sheet_id: string }>();
        if (sheet?.sheet_id) {
          const tok = await getValidAccessToken(chatId, env);
          await updateSupplierEmailStatus(sheet.sheet_id, company.sheet_row, {
            sent: 'Yes', sentAt, subject: draft.subject, status: 'Sent',
          }, tok);
        }
      } catch (e) { console.error('[sourcebot] sheet email status update failed:', e); }
    }

    await send(chatId,
      `✅ Email sent to ${draft.recipient}\n\n*Subject:* ${draft.subject}\n🕐 ${sentAt}`,
      env, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot] email send failed:', msg);
    await env.DB.prepare(
      `INSERT INTO sb_emails_sent
         (company_id, buyer_id, show_name, recipient_email, subject, body, status, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)`
    ).bind(draft.companyId, buyer.buyerId, company?.show_name ?? '', draft.recipient, draft.subject, draft.body, msg.slice(0, 500)).run();
    await send(chatId, `❌ Failed to send: ${msg.slice(0, 200)}`, env);
  }
}

interface DraftContext {
  buyerName: string;
  showName: string;
  company: string;
  contactName: string;
  contactTitle: string;
  products: string[];
  voiceNotes: string[];
}

async function draftFollowUpEmail(ctx: DraftContext, env: Env): Promise<{ subject: string; body: string }> {
  const prompt =
    `You are drafting a short, professional follow-up email from a B2B buyer to a supplier they met at a trade show. ` +
    `Context:\n` +
    `- Show: ${ctx.showName}\n` +
    `- Supplier: ${ctx.company}\n` +
    `- Contact: ${ctx.contactName}${ctx.contactTitle ? ` (${ctx.contactTitle})` : ''}\n` +
    (ctx.products.length    ? `- Products discussed: ${ctx.products.join('; ')}\n`             : '') +
    (ctx.voiceNotes.length  ? `- Buyer's notes: ${ctx.voiceNotes.join(' | ')}\n`               : '') +
    `\nReturn ONLY a JSON object with these exact fields:\n` +
    `- subject (concise, 60 chars max)\n` +
    `- body (4-7 sentences, plain text, no markdown). Open by referencing the show. Mention 1-2 specific products if known. Ask a clear next-step question (samples, pricing sheet, MOQ confirmation). Sign off neutrally. Don't fabricate prices or terms.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  if (!data.candidates?.length) return { subject: '', body: '' };
  const raw = data.candidates[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as { subject?: string; body?: string };
  return { subject: parsed.subject ?? '', body: parsed.body ?? '' };
}

// ── /pending ─────────────────────────────────────────────────────────────────

async function cmdPending(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  // Resolve the buyer's currently-active show
  const pass = await env.DB.prepare(
    `SELECT show_name FROM sb_buyer_shows
       WHERE buyer_id = ? AND status IN ('active','grace')
       ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string }>();
  if (!pass) { await send(chatId, `No active show found.`, env); return; }

  // Suppliers with at least one contact email but NO sent email
  const rows = await env.DB.prepare(
    `SELECT c.id, c.name, MIN(co.email) AS email
       FROM sb_companies c
       JOIN sb_contacts co ON co.company_id = c.id
       LEFT JOIN sb_emails_sent es ON es.company_id = c.id AND es.status = 'sent'
      WHERE c.buyer_id = ? AND c.show_name = ?
        AND co.email IS NOT NULL AND co.email != ''
        AND es.id IS NULL
      GROUP BY c.id, c.name
      ORDER BY c.created_at DESC
      LIMIT 20`
  ).bind(buyer.buyerId, pass.show_name).all<{ id: string; name: string; email: string }>();

  if (!rows.results.length) {
    await send(chatId, `🎉 No pending follow-ups for *${pass.show_name}* — every supplier with an email has been contacted.`, env, true);
    return;
  }

  const lines = rows.results.map(r => `• *${r.name}* — ${r.email}`).join('\n');
  await send(chatId,
    `📬 *${rows.results.length} supplier${rows.results.length === 1 ? '' : 's'} pending follow-up:*\n\n${lines}\n\n` +
    `Tap one with \`/email <name>\` to draft and send.`,
    env, true);
}

// ── /summary ─────────────────────────────────────────────────────────────────

async function cmdSummary(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  // Resolve the buyer's currently-active show
  const pass = await env.DB.prepare(
    `SELECT show_name, sheet_url FROM sb_buyer_shows
       WHERE buyer_id = ? AND status IN ('active','grace')
       ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string; sheet_url: string | null }>();
  if (!pass) {
    await send(chatId, `No active show found.`, env);
    return;
  }

  // Pull all companies for this show with aggregated contacts, products, voice notes
  const companies = await env.DB.prepare(
    `SELECT id, name, website, industry FROM sb_companies
       WHERE buyer_id = ? AND show_name = ? ORDER BY created_at DESC`
  ).bind(buyer.buyerId, pass.show_name).all<{ id: string; name: string; website: string | null; industry: string | null }>();

  if (!companies.results.length) {
    await send(chatId, `No suppliers captured yet for *${pass.show_name}*.`, env, true);
    return;
  }

  await send(chatId, `🤖 Analyzing ${companies.results.length} supplier${companies.results.length === 1 ? '' : 's'}…`, env);

  // Hydrate each company with products + voice notes (modest N — fine for MVP)
  const ctx: Array<{ name: string; website: string | null; industry: string | null; products: string[]; voiceHighlights: string[] }> = [];
  for (const c of companies.results.slice(0, 30)) {
    const prods = await env.DB.prepare(
      `SELECT name, price, moq, lead_time FROM sb_products WHERE company_id = ? ORDER BY created_at LIMIT 8`
    ).bind(c.id).all<{ name: string | null; price: string | null; moq: string | null; lead_time: string | null }>();
    const voices = await env.DB.prepare(
      `SELECT transcript, extracted_price, extracted_moq, extracted_tone
         FROM sb_voice_notes WHERE company_id = ? ORDER BY created_at LIMIT 4`
    ).bind(c.id).all<{ transcript: string; extracted_price: string | null; extracted_moq: string | null; extracted_tone: string | null }>();

    ctx.push({
      name: c.name,
      website: c.website,
      industry: c.industry,
      products: prods.results.map(p => `${p.name ?? '—'}${p.price ? ` (${p.price})` : ''}${p.moq ? ` MOQ ${p.moq}` : ''}${p.lead_time ? ` LT ${p.lead_time}` : ''}`),
      voiceHighlights: voices.results.map(v => v.transcript.slice(0, 240)),
    });
  }

  // Build the Gemini prompt
  const corpus = ctx.map((c, i) =>
    `${i + 1}. ${c.name}${c.website ? ` (${c.website})` : ''}${c.industry ? ` — ${c.industry}` : ''}\n` +
    (c.products.length ? `   Products: ${c.products.join('; ')}\n` : '') +
    (c.voiceHighlights.length ? `   Voice notes: ${c.voiceHighlights.join(' || ')}\n` : '')
  ).join('\n');

  const prompt =
    `You are summarizing a buyer's notes from the trade show "${pass.show_name}" for them. ` +
    `Here is what they captured (one supplier per line, with their products and voice notes):\n\n${corpus}\n\n` +
    `Write a clear, useful summary in 5-10 sentences. Cover: how many suppliers and what categories, ` +
    `the most promising leads (with reasoning), notable price ranges or MOQ patterns, and any ` +
    `concerns the voice notes flagged. End with one specific actionable next step. Tone: practical, ` +
    `not salesy. Plain text — no markdown headings.`;

  let analysis = '';
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
    if (!data.candidates?.length) throw new Error(data.error?.message ?? 'no candidates');
    analysis = (data.candidates[0]?.content?.parts?.[0]?.text ?? '').trim();
  } catch (e) {
    console.error('[sourcebot] summary failed:', e);
    await send(chatId, `❌ Couldn't generate the summary. Try again later.`, env);
    return;
  }

  if (!analysis) {
    await send(chatId, `⚠️ The model returned an empty summary. Try again later.`, env);
    return;
  }

  await sendButtons(chatId,
    `📊 *${pass.show_name} — summary*\n\n${analysis}`,
    pass.sheet_url ? [[{ text: '📊 Open Sheet', url: pass.sheet_url }]] : [],
    env, true);
}

// ── Card capture flow ────────────────────────────────────────────────────────

async function handleSupplierCard(
  chatId: number,
  photos: TgPhotoSize[],
  buyer: { buyerId: string },
  env: Env,
): Promise<void> {
  const photo = photos.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a);

  // Find the buyer's active show pass (sheet location)
  const pass = await env.DB.prepare(
    `SELECT show_name, sheet_id, drive_folder_id FROM sb_buyer_shows
     WHERE buyer_id = ? AND status IN ('active','grace')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string; sheet_id: string | null; drive_folder_id: string | null }>();
  if (!pass?.sheet_id) {
    await send(chatId, `⚠️ I couldn't find an active show for your account. Please contact support.`, env);
    return;
  }

  await send(chatId, `🔍 Scanning supplier card…`, env);

  // 1. Download Telegram file
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/getFile?file_id=${photo.file_id}`);
  const fileData = await fileRes.json() as { result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) { await send(chatId, `❌ Could not fetch the photo. Try again.`, env); return; }

  const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/${filePath}`);
  const rawBuffer = await imgRes.arrayBuffer();
  const base64 = arrayBufferToBase64(rawBuffer);

  // 2. OCR + extraction (shared pipeline in src/extract.ts)
  let extracted: ExtractedContactLocal;
  try {
    const result = await ocrThenExtract(base64, filePath.endsWith('.png') ? 'image/png' : 'image/jpeg', env);
    extracted = {
      name:     result.contact.name,
      title:    result.contact.title,
      company:  result.contact.company,
      email:    result.contact.email,
      phone:    result.contact.phone,
      website:  result.contact.website,
      linkedin: result.contact.linkedin,
      address:  result.contact.address,
      country:  result.contact.country,
    };
  } catch (e) {
    console.error('[sourcebot] extraction failed:', e);
    await send(chatId, `⚠️ I couldn't read the card. Try a clearer photo.`, env);
    return;
  }

  if (!extracted.company && !extracted.name) {
    await send(chatId, `⚠️ I couldn't find a supplier name or company on that card. Try a clearer photo.`, env);
    return;
  }

  // 3. Upsert sb_companies first so we have an id to attach the per-supplier folder to.
  const companyName = (extracted.company || extracted.name || 'Unknown').trim();
  const existingCompany = await env.DB.prepare(
    `SELECT id FROM sb_companies WHERE buyer_id = ? AND show_name = ? AND lower(name) = lower(?) LIMIT 1`
  ).bind(buyer.buyerId, pass.show_name, companyName).first<{ id: string }>();

  const companyId = existingCompany?.id ?? (await env.DB.prepare(
    `INSERT INTO sb_companies (buyer_id, show_name, name, website, industry)
     VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).bind(buyer.buyerId, pass.show_name, companyName, extracted.website || null, null).first<{ id: string }>())?.id;
  if (!companyId) { await send(chatId, `❌ Failed to save the supplier.`, env); return; }

  // 3b. Per-supplier Drive folder named "{Company} — {Month YYYY}". Cached on sb_companies.
  let supplierFolderId: string | undefined;
  if (pass.drive_folder_id) {
    try {
      supplierFolderId = await getOrCreateSupplierFolder(companyId, companyName, pass.drive_folder_id, env);
    } catch (e) {
      console.error('[sourcebot] supplier folder create failed:', e);
    }
  }

  // 3c. Upload card to the per-supplier folder (or the show folder as fallback).
  let cardUrl: string | undefined;
  try {
    const parent = supplierFolderId ?? pass.drive_folder_id;
    if (parent) {
      const tok = await getServiceAccountToken(env);
      cardUrl = await uploadCardImage(rawBuffer, extracted.name || 'card', extracted.company, parent, tok);
    }
  } catch (e) {
    console.error('[sourcebot] card upload failed:', e);
  }

  await env.DB.prepare(
    `INSERT INTO sb_contacts (company_id, buyer_id, show_name, name, title, email, phone, linkedin_url, address, card_front_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    companyId, buyer.buyerId, pass.show_name,
    extracted.name || null,
    extracted.title || null,
    extracted.email || null,
    extracted.phone || null,
    extracted.linkedin || null,
    extracted.address || null,
    cardUrl || null,
  ).run();

  // 5. Append row to the buyer's Sheet + record sheet_row on the company so we can update later
  try {
    const token = await getServiceAccountToken(env);
    const { rowIndex } = await appendSupplierRow(pass.sheet_id, {
      timestamp:    new Date().toISOString(),
      company:      companyName,
      contactName:  extracted.name    || '',
      title:        extracted.title   || '',
      email:        extracted.email   || '',
      phone:        extracted.phone   || '',
      website:      extracted.website || '',
      linkedin:     extracted.linkedin|| '',
      industry:     '',
      cardFrontUrl: cardUrl,
    }, token);

    if (!existingCompany) {
      await env.DB.prepare(`UPDATE sb_companies SET sheet_row = ? WHERE id = ?`).bind(rowIndex, companyId).run();
    }
  } catch (e) {
    console.error('[sourcebot] sheet append failed:', e);
    await send(chatId, `⚠️ Saved to database, but couldn't write to your sheet. We'll retry later.`, env);
    return;
  }

  // 6. Confirm + auto-enter product-photo mode so the user can just keep snapping product photos
  await setSession(chatId, { step: 'awaiting_product_photo', activeCompanyId: companyId }, env);

  const preview =
    `✅ *Supplier saved*\n\n` +
    `📛 *Name:* ${extracted.name    || '—'}\n` +
    `💼 *Title:* ${extracted.title  || '—'}\n` +
    `🏢 *Company:* ${companyName}\n` +
    `📧 *Email:* ${extracted.email  || '—'}\n` +
    `📞 *Phone:* ${extracted.phone  || '—'}\n` +
    (extracted.country  ? `🌍 *Country:* ${extracted.country}\n`   : '') +
    (extracted.website  ? `🌐 *Website:* ${extracted.website}\n`   : '') +
    (extracted.linkedin ? `🔗 *LinkedIn:* ${extracted.linkedin}\n` : '') +
    (extracted.address  ? `📍 *Address:* ${extracted.address}\n`   : '') +
    `\n📦 *Send product photos* to attach them to this supplier — or tap below.`;

  await sendButtons(chatId,
    preview,
    [
      [{ text: '💬 Add details',         callback_data: `add_voice:${companyId}` }],
      [{ text: '📷 New supplier card',  callback_data: 'new_supplier' }],
      [{ text: '✅ Done',                callback_data: 'done_capturing' }],
    ],
    env, true);
}

// ── Product capture flow ─────────────────────────────────────────────────────

async function handleProductPhoto(
  chatId: number,
  photos: TgPhotoSize[],
  session: SourceBotSession,
  buyer: { buyerId: string },
  env: Env,
): Promise<void> {
  if (!session.activeCompanyId) {
    await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, `Lost track of which supplier this is for. Please scan the supplier card again.`, env);
    return;
  }

  await send(chatId, `🔍 Reading the product…`, env);

  const photo = photos.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a);

  // Download from Telegram
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/getFile?file_id=${photo.file_id}`);
  const fileData = await fileRes.json() as { result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) { await send(chatId, `❌ Couldn't fetch the photo. Try again.`, env); return; }

  const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/${filePath}`);
  const rawBuffer = await imgRes.arrayBuffer();
  const base64 = arrayBufferToBase64(rawBuffer);

  // Classify + extract in one call. If Gemini decides this is actually a business card,
  // transparently exit product mode and hand off to the supplier-capture flow.
  let productName = 'Product';
  let productDesc = '';
  try {
    const fields = await extractProductFromImage(base64, filePath.endsWith('.png') ? 'image/png' : 'image/jpeg', env);
    if (fields.type === 'business_card') {
      await setSession(chatId, { step: 'idle' }, env);
      await send(chatId, `📷 That looks like a business card — capturing as a new supplier.`, env);
      await handleSupplierCard(chatId, photos, buyer, env);
      return;
    }
    productName = fields.name || 'Product';
    productDesc = fields.description || '';
  } catch (e) {
    console.error('[sourcebot] product extract failed:', e);
  }

  // Get the show context for the active company
  const company = await env.DB.prepare(
    `SELECT show_name FROM sb_companies WHERE id = ?`
  ).bind(session.activeCompanyId).first<{ show_name: string }>();
  if (!company) { await send(chatId, `Lost track of supplier. Please rescan the card.`, env); return; }

  // Upload product photo to the per-supplier Drive folder (created at supplier capture).
  let imageUrl: string | undefined;
  try {
    const folderId = await getOrCreateSupplierFolderById(session.activeCompanyId, env, company.show_name, buyer);
    if (folderId) {
      const token = await getServiceAccountToken(env);
      imageUrl = await uploadCardImage(rawBuffer, productName, '', folderId, token);
    }
  } catch (e) {
    console.error('[sourcebot] product drive upload failed:', e);
  }

  // Insert the sb_products row.
  const product = await env.DB.prepare(
    `INSERT INTO sb_products (company_id, buyer_id, show_name, name, description, image_url)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(session.activeCompanyId, buyer.buyerId, company.show_name, productName, productDesc || null, imageUrl || null).first<{ id: string }>();
  if (!product?.id) { await send(chatId, `❌ Failed to save the product.`, env); return; }

  // Append a row to the Products tab (per-product visibility with image, dedicated price/MOQ columns).
  try {
    const sheet = await env.DB.prepare(
      `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
    ).bind(buyer.buyerId, company.show_name).first<{ sheet_id: string }>();
    if (sheet?.sheet_id) {
      const tok = await getServiceAccountToken(env);
      await ensureProductsTab(sheet.sheet_id, tok);
      const supplierName = await env.DB.prepare(`SELECT name FROM sb_companies WHERE id = ?`).bind(session.activeCompanyId).first<{ name: string }>();
      const { rowIndex } = await appendProductRow(sheet.sheet_id, {
        timestamp:   new Date().toISOString(),
        supplier:    supplierName?.name ?? '',
        productName,
        imageUrl,
        description: productDesc,
      }, tok);
      await env.DB.prepare(`UPDATE sb_products SET sheet_row = ? WHERE id = ?`).bind(rowIndex, product.id).run();

      // Also keep the supplier's Products column (P) up to date as a quick at-a-glance summary.
      const supplier = await env.DB.prepare(`SELECT sheet_row FROM sb_companies WHERE id = ?`).bind(session.activeCompanyId).first<{ sheet_row: number | null }>();
      if (supplier?.sheet_row) {
        const all = await env.DB.prepare(`SELECT name FROM sb_products WHERE company_id = ? ORDER BY created_at`).bind(session.activeCompanyId).all<{ name: string }>();
        const productsText = all.results.map(p => `• ${p.name ?? '—'}`).join('\n');
        await updateSupplierProducts(sheet.sheet_id, supplier.sheet_row, { productsText, priceRange: '', avgLeadTime: '' }, tok);
      }
    }
  } catch (e) { console.error('[sourcebot] products tab append failed:', e); }

  // Stay in product-photo mode but track the just-saved product so any text/voice
  // reply attaches to *this* product. Sending another photo simply rotates activeProductId.
  await setSession(chatId, {
    step: 'awaiting_product_photo',
    activeCompanyId: session.activeCompanyId,
    activeProductId: product.id,
  }, env);

  // Send the photo back as a confirmation with force_reply — the reply preview
  // shows this photo, so the user knows which product they're adding details to.
  const caption =
    `✅ *${productName}*` +
    (productDesc ? `\n_${productDesc}_` : '') +
    `\n\n💬 *Reply* with price, MOQ, lead time, or notes — or send the next product photo. Tap /done to finish.`;
  try {
    await sendPhotoForceReply(chatId, photo.file_id, caption, env, true);
  } catch (e) {
    console.error('[sourcebot] sendPhotoForceReply failed, falling back to text:', e);
    await sendForceReply(chatId, caption, env, true);
  }
}

async function handleProductPrice(chatId: number, text: string, session: SourceBotSession, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!session.activeProductId) { await setSession(chatId, { step: 'idle' }, env); return; }
  await env.DB.prepare(`UPDATE sb_products SET price = ? WHERE id = ?`).bind(text || null, session.activeProductId).run();
  await setSession(chatId, { ...session, step: 'awaiting_product_moq' }, env);
  await sendButtons(chatId, `📊 What's the MOQ? (e.g. "100 pcs", or Skip)`,
    [[{ text: '⏭ Skip', callback_data: 'skip_field' }]], env, true);
  void buyer; // unused but kept for symmetry
}

async function handleProductMoq(chatId: number, text: string, session: SourceBotSession, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!session.activeProductId) { await setSession(chatId, { step: 'idle' }, env); return; }
  await env.DB.prepare(`UPDATE sb_products SET moq = ? WHERE id = ?`).bind(text || null, session.activeProductId).run();
  await setSession(chatId, { ...session, step: 'awaiting_product_lead_time' }, env);
  await sendButtons(chatId, `⏱ What's the lead time? (e.g. "30 days", or Skip)`,
    [[{ text: '⏭ Skip', callback_data: 'skip_field' }]], env, true);
  void buyer;
}

async function handleProductLeadTime(chatId: number, text: string, session: SourceBotSession, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!session.activeProductId) { await setSession(chatId, { step: 'idle' }, env); return; }
  await env.DB.prepare(`UPDATE sb_products SET lead_time = ? WHERE id = ?`).bind(text || null, session.activeProductId).run();
  await finalizeProduct(chatId, session, buyer, env);
}

// Called from "Skip" callback to advance whichever step we're on with empty value.
async function advanceProductFlow(chatId: number, value: string, env: Env): Promise<void> {
  const session = await getSession(chatId, env);
  const buyer = await getBuyerForChat(chatId, env);
  if (!buyer) return;
  if (session.step === 'awaiting_product_price')      await handleProductPrice(chatId, value, session, buyer, env);
  else if (session.step === 'awaiting_product_moq')   await handleProductMoq(chatId, value, session, buyer, env);
  else if (session.step === 'awaiting_product_lead_time') await handleProductLeadTime(chatId, value, session, buyer, env);
}

// After all four product fields are gathered, push the aggregated product list
// onto the supplier's sheet row and confirm with the user.
async function finalizeProduct(chatId: number, session: SourceBotSession, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!session.activeCompanyId) { await setSession(chatId, { step: 'idle' }, env); return; }

  const company = await env.DB.prepare(
    `SELECT name, show_name, sheet_row FROM sb_companies WHERE id = ?`
  ).bind(session.activeCompanyId).first<{ name: string; show_name: string; sheet_row: number | null }>();
  if (!company) { await setSession(chatId, { step: 'idle' }, env); return; }

  // Aggregate all products for this company
  const products = await env.DB.prepare(
    `SELECT name, price, moq, lead_time FROM sb_products WHERE company_id = ? ORDER BY created_at`
  ).bind(session.activeCompanyId).all<{ name: string | null; price: string | null; moq: string | null; lead_time: string | null }>();

  const productsText = products.results.map(p => `• ${p.name ?? '—'}${p.moq ? ` (MOQ ${p.moq})` : ''}`).join('\n');
  const prices = products.results.map(p => p.price).filter(Boolean) as string[];
  const priceRange = prices.length === 0 ? '' : prices.length === 1 ? prices[0] : `${prices[0]} – ${prices[prices.length - 1]}`;
  const leads = products.results.map(p => p.lead_time).filter(Boolean) as string[];
  const avgLeadTime = leads[0] ?? '';   // simple: take the first; can compute average later if numeric

  // Update the supplier's sheet row (P, Q, R columns)
  if (company.sheet_row) {
    try {
      const sheet = await env.DB.prepare(
        `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
      ).bind(buyer.buyerId, company.show_name).first<{ sheet_id: string }>();
      if (sheet?.sheet_id) {
        const token = await getServiceAccountToken(env);
        await updateSupplierProducts(sheet.sheet_id, company.sheet_row, { productsText, priceRange, avgLeadTime }, token);
      }
    } catch (e) {
      console.error('[sourcebot] sheet products update failed:', e);
    }
  }

  // Stay in product-photo mode so the user can just keep sending product photos.
  // They tap Done (or /cancel) to leave product capture; tap Voice note to switch modes.
  await setSession(chatId, { step: 'awaiting_product_photo', activeCompanyId: session.activeCompanyId }, env);

  await sendButtons(chatId,
    `✅ Product saved for *${company.name}*.\n\n📸 Send another product photo, or tap below.`,
    [
      [{ text: '💬 Add details',  callback_data: `add_voice:${session.activeCompanyId}` }],
      [{ text: '✅ Done', callback_data: 'done_capturing' }],
    ],
    env, true);
}

// ── Voice note flow ──────────────────────────────────────────────────────────

async function handleVoiceNote(
  chatId: number,
  voice: TgVoice,
  session: SourceBotSession,
  buyer: { buyerId: string },
  env: Env,
): Promise<void> {
  if (!session.activeCompanyId) {
    await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, `Lost track of which supplier this is for. Please rescan the card.`, env);
    return;
  }

  await send(chatId, `🎤 Transcribing…`, env);

  // Download from Telegram
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/getFile?file_id=${voice.file_id}`);
  const fileData = await fileRes.json() as { result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) { await send(chatId, `❌ Couldn't fetch the voice file. Try again.`, env); return; }

  const audioRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/${filePath}`);
  const audioBuffer = await audioRes.arrayBuffer();
  const base64 = arrayBufferToBase64(audioBuffer);

  // Single Gemini call: verbatim transcript + extracted price/MOQ/lead-time/tone
  let extracted: VoiceExtraction;
  try {
    extracted = await transcribeAndExtract(base64, env);
  } catch (e) {
    console.error('[sourcebot] voice transcribe failed:', e);
    await send(chatId, `⚠️ Couldn't transcribe the voice note. Try again with a clearer recording.`, env);
    return;
  }

  if (!extracted.transcript || !extracted.transcript.trim()) {
    await send(chatId, `⚠️ I couldn't make out any speech in that voice note. Try again.`, env);
    return;
  }

  // Resolve the supplier's show context
  const company = await env.DB.prepare(
    `SELECT name, show_name, sheet_row FROM sb_companies WHERE id = ?`
  ).bind(session.activeCompanyId).first<{ name: string; show_name: string; sheet_row: number | null }>();
  if (!company) { await setSession(chatId, { step: 'idle' }, env); return; }

  // Save the voice note
  await env.DB.prepare(
    `INSERT INTO sb_voice_notes
       (company_id, buyer_id, show_name, transcript, language, duration_seconds,
        extracted_price, extracted_moq, extracted_lead_time, extracted_tone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    session.activeCompanyId, buyer.buyerId, company.show_name,
    extracted.transcript, extracted.language || null, voice.duration ?? null,
    extracted.price || null, extracted.moq || null, extracted.lead_time || null, extracted.tone || null,
  ).run();

  // Update the supplier sheet row's column U with the aggregated transcripts
  if (company.sheet_row) {
    try {
      const all = await env.DB.prepare(
        `SELECT transcript, created_at FROM sb_voice_notes WHERE company_id = ? ORDER BY created_at`
      ).bind(session.activeCompanyId).all<{ transcript: string; created_at: string }>();
      const aggregated = all.results.map(v => `[${v.created_at}] ${v.transcript}`).join('\n\n');

      const sheet = await env.DB.prepare(
        `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
      ).bind(buyer.buyerId, company.show_name).first<{ sheet_id: string }>();
      if (sheet?.sheet_id) {
        const token = await getServiceAccountToken(env);
        await updateSupplierVoiceNote(sheet.sheet_id, company.sheet_row, aggregated, token);
      }
    } catch (e) {
      console.error('[sourcebot] sheet voice update failed:', e);
    }
  }

  // Reset step but keep activeCompanyId so the user can chain another voice/product
  await setSession(chatId, { step: 'idle', activeCompanyId: session.activeCompanyId }, env);

  // Build a confirmation that surfaces what we extracted
  const extras: string[] = [];
  if (extracted.price)     extras.push(`💰 ${extracted.price}`);
  if (extracted.moq)       extras.push(`📊 MOQ ${extracted.moq}`);
  if (extracted.lead_time) extras.push(`⏱ ${extracted.lead_time}`);
  if (extracted.tone)      extras.push(`🎭 ${extracted.tone}`);

  await sendButtons(chatId,
    `✅ Voice note saved for *${company.name}*\n\n` +
    `_"${extracted.transcript.slice(0, 280)}${extracted.transcript.length > 280 ? '…' : ''}"_` +
    (extras.length ? `\n\n${extras.join(' · ')}` : ''),
    [
      [{ text: '📦 Add product', callback_data: `add_product:${session.activeCompanyId}` },
       { text: '💬 More details', callback_data: `add_voice:${session.activeCompanyId}` }],
      [{ text: '✅ Done', callback_data: 'done_capturing' }],
    ],
    env, true);
}

interface VoiceExtraction {
  transcript: string;
  language:   string;
  price:      string;
  moq:        string;
  lead_time:  string;
  tone:       string;
}

// Same shape as transcribeAndExtract, but for typed text replies. Stored as a
// "voice note" with no audio so it shows up alongside spoken notes in the sheet.
async function handleDetailsText(
  chatId: number,
  text: string,
  session: SourceBotSession,
  buyer: { buyerId: string },
  env: Env,
): Promise<void> {
  if (!session.activeCompanyId) {
    await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, `Lost track of which supplier this is for. Please rescan the card.`, env);
    return;
  }

  const company = await env.DB.prepare(
    `SELECT name, show_name, sheet_row FROM sb_companies WHERE id = ?`
  ).bind(session.activeCompanyId).first<{ name: string; show_name: string; sheet_row: number | null }>();
  if (!company) { await setSession(chatId, { step: 'idle' }, env); return; }

  // Pull price/MOQ/lead-time/tone from the typed text (best-effort)
  let extras: { price: string; moq: string; lead_time: string; tone: string };
  try {
    extras = await extractFromDetailsText(text, env);
  } catch {
    extras = { price: '', moq: '', lead_time: '', tone: '' };
  }

  await env.DB.prepare(
    `INSERT INTO sb_voice_notes
       (company_id, buyer_id, show_name, transcript, language, duration_seconds,
        extracted_price, extracted_moq, extracted_lead_time, extracted_tone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    session.activeCompanyId, buyer.buyerId, company.show_name,
    text, null, null,
    extras.price || null, extras.moq || null, extras.lead_time || null, extras.tone || null,
  ).run();

  if (company.sheet_row) {
    try {
      const all = await env.DB.prepare(
        `SELECT transcript, created_at FROM sb_voice_notes WHERE company_id = ? ORDER BY created_at`
      ).bind(session.activeCompanyId).all<{ transcript: string; created_at: string }>();
      const aggregated = all.results.map(v => `[${v.created_at}] ${v.transcript}`).join('\n\n');
      const sheet = await env.DB.prepare(
        `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
      ).bind(buyer.buyerId, company.show_name).first<{ sheet_id: string }>();
      if (sheet?.sheet_id) {
        const tok = await getServiceAccountToken(env);
        await updateSupplierVoiceNote(sheet.sheet_id, company.sheet_row, aggregated, tok);
      }
    } catch (e) { console.error('[sourcebot] sheet text-detail update failed:', e); }
  }

  // Stay in product-photo mode so the user can keep snapping after adding a note
  await setSession(chatId, { step: 'awaiting_product_photo', activeCompanyId: session.activeCompanyId }, env);

  const summary: string[] = [];
  if (extras.price)     summary.push(`💰 ${extras.price}`);
  if (extras.moq)       summary.push(`📊 MOQ ${extras.moq}`);
  if (extras.lead_time) summary.push(`⏱ ${extras.lead_time}`);
  if (extras.tone)      summary.push(`🎭 ${extras.tone}`);

  await sendButtons(chatId,
    `✅ Note saved for *${company.name}*` +
    (summary.length ? `\n\n${summary.join(' · ')}` : '') +
    `\n\n📸 Send a product photo, or tap below.`,
    [
      [{ text: '💬 More details',       callback_data: `add_voice:${session.activeCompanyId}` }],
      [{ text: '📷 New supplier card',  callback_data: 'new_supplier' }],
      [{ text: '✅ Done',                callback_data: 'done_capturing' }],
    ],
    env, true);
}

// Apply a typed reply to the active product (price/MOQ/lead-time/notes).
async function handleProductDetailsText(
  chatId: number,
  text: string,
  session: SourceBotSession,
  buyer: { buyerId: string },
  env: Env,
): Promise<void> {
  if (!session.activeProductId || !session.activeCompanyId) return;
  let extras: { price: string; moq: string; lead_time: string; tone: string };
  try { extras = await extractFromDetailsText(text, env); } catch { extras = { price: '', moq: '', lead_time: '', tone: '' }; }
  await applyProductDetails(session.activeProductId, session.activeCompanyId, buyer, text, extras, env);
  await sendProductDetailsConfirmation(chatId, session.activeProductId, extras, text, env);
}

// Same for a voice reply: transcribe via Gemini, then apply.
async function handleProductDetailsVoice(
  chatId: number,
  voice: TgVoice,
  session: SourceBotSession,
  buyer: { buyerId: string },
  env: Env,
): Promise<void> {
  if (!session.activeProductId || !session.activeCompanyId) return;
  await send(chatId, `🎤 Transcribing…`, env);

  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/getFile?file_id=${voice.file_id}`);
  const fileData = await fileRes.json() as { result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) { await send(chatId, `❌ Couldn't fetch the voice note. Try again.`, env); return; }
  const audioRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/${filePath}`);
  const audioBuffer = await audioRes.arrayBuffer();
  const base64 = arrayBufferToBase64(audioBuffer);

  let extracted: VoiceExtraction;
  try { extracted = await transcribeAndExtract(base64, env); }
  catch (e) {
    console.error('[sourcebot] product voice transcribe failed:', e);
    await send(chatId, `⚠️ Couldn't transcribe. Try again with a clearer recording.`, env);
    return;
  }
  const transcript = (extracted.transcript || '').trim();
  if (!transcript) { await send(chatId, `⚠️ I couldn't make out any speech.`, env); return; }

  await applyProductDetails(session.activeProductId, session.activeCompanyId, buyer, transcript, extracted, env);
  await sendProductDetailsConfirmation(chatId, session.activeProductId, extracted, transcript, env);
}

// Get-or-create the per-supplier folder named "{Company} — {Month YYYY}" inside the
// buyer's show folder. Caches the id on sb_companies.cards_folder_id.
async function getOrCreateSupplierFolder(
  companyId: string,
  companyName: string,
  showFolderId: string,
  env: Env,
): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT cards_folder_id FROM sb_companies WHERE id = ?`
  ).bind(companyId).first<{ cards_folder_id: string | null }>();
  if (row?.cards_folder_id) return row.cards_folder_id;

  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const folderName = `${companyName} — ${month}`;
  const tok = await getServiceAccountToken(env);
  const folder = await createDriveFolder(folderName, showFolderId, tok);
  await env.DB.prepare(
    `UPDATE sb_companies SET cards_folder_id = ? WHERE id = ?`
  ).bind(folder.id, companyId).run();
  return folder.id;
}

// Same, but resolves the show folder id from the company id (used by handleProductPhoto).
async function getOrCreateSupplierFolderById(
  companyId: string,
  env: Env,
  showName: string,
  buyer: { buyerId: string },
): Promise<string | undefined> {
  const c = await env.DB.prepare(
    `SELECT cards_folder_id, name FROM sb_companies WHERE id = ?`
  ).bind(companyId).first<{ cards_folder_id: string | null; name: string }>();
  if (c?.cards_folder_id) return c.cards_folder_id;
  if (!c?.name) return undefined;

  const pass = await env.DB.prepare(
    `SELECT drive_folder_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
  ).bind(buyer.buyerId, showName).first<{ drive_folder_id: string | null }>();
  if (!pass?.drive_folder_id) return undefined;

  return getOrCreateSupplierFolder(companyId, c.name, pass.drive_folder_id, env);
}

async function applyProductDetails(
  productId: string,
  companyId: string,
  buyer: { buyerId: string },
  notesText: string,
  extras: { price: string; moq: string; lead_time: string; tone: string },
  env: Env,
): Promise<void> {
  // Append the user's note to description (cumulative — keeps the photo-extracted
  // type AND every voice/text reply, so colors/materials/sizes mentioned but not
  // captured by the structured fields aren't lost).
  await env.DB.prepare(
    `UPDATE sb_products
        SET price     = COALESCE(NULLIF(?, ''), price),
            moq       = COALESCE(NULLIF(?, ''), moq),
            lead_time = COALESCE(NULLIF(?, ''), lead_time),
            description = CASE
              WHEN description IS NULL OR description = '' THEN ?
              ELSE description || char(10) || ?
            END
      WHERE id = ?`
  ).bind(extras.price ?? '', extras.moq ?? '', extras.lead_time ?? '', notesText, notesText, productId).run();

  // Update the dedicated per-product row on the Products tab. Also refresh the
  // supplier-row aggregate (column P) so the at-a-glance summary stays current.
  const company = await env.DB.prepare(
    `SELECT show_name, sheet_row FROM sb_companies WHERE id = ?`
  ).bind(companyId).first<{ show_name: string; sheet_row: number | null }>();
  if (!company) return;

  const product = await env.DB.prepare(
    `SELECT sheet_row, name, description, price, moq, lead_time FROM sb_products WHERE id = ?`
  ).bind(productId).first<{ sheet_row: number | null; name: string; description: string | null; price: string | null; moq: string | null; lead_time: string | null }>();

  try {
    const sheet = await env.DB.prepare(
      `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
    ).bind(buyer.buyerId, company.show_name).first<{ sheet_id: string }>();
    if (!sheet?.sheet_id) return;

    const tok = await getServiceAccountToken(env);

    // Write per-product row (Products tab)
    if (product?.sheet_row) {
      await updateProductRow(sheet.sheet_id, product.sheet_row, {
        description: product.description ?? '',
        price:       product.price       ?? '',
        moq:         product.moq         ?? '',
        leadTime:    product.lead_time   ?? '',
        tone:        extras.tone         ?? '',
        notes:       '',
      }, tok);
    }

    // Refresh supplier row's aggregate column P / Q / R
    if (company.sheet_row) {
      const all = await env.DB.prepare(
        `SELECT name, price, moq, lead_time FROM sb_products WHERE company_id = ? ORDER BY created_at`
      ).bind(companyId).all<{ name: string; price: string | null; moq: string | null; lead_time: string | null }>();
      const productsText = all.results
        .map(p => {
          return `• ${p.name ?? '—'}` +
            (p.price     ? ` — ${p.price}`     : '') +
            (p.moq       ? ` · MOQ ${p.moq}`   : '') +
            (p.lead_time ? ` · ${p.lead_time}` : '');
        })
        .join('\n');
      const prices = all.results.map(p => p.price).filter(Boolean) as string[];
      const priceRange = prices.length === 0 ? '' : prices.length === 1 ? prices[0] : `${prices[0]} – ${prices[prices.length - 1]}`;
      const leads = all.results.map(p => p.lead_time).filter(Boolean) as string[];
      const avgLeadTime = leads[0] ?? '';
      await updateSupplierProducts(sheet.sheet_id, company.sheet_row, { productsText, priceRange, avgLeadTime }, tok);
    }
  } catch (e) { console.error('[sourcebot] product detail sheet update failed:', e); }
}

async function sendProductDetailsConfirmation(
  chatId: number,
  productId: string,
  extras: { price: string; moq: string; lead_time: string; tone: string },
  notesText: string,
  env: Env,
): Promise<void> {
  const product = await env.DB.prepare(
    `SELECT name FROM sb_products WHERE id = ?`
  ).bind(productId).first<{ name: string }>();

  const summary: string[] = [];
  if (extras.price)     summary.push(`💰 ${extras.price}`);
  if (extras.moq)       summary.push(`📊 MOQ ${extras.moq}`);
  if (extras.lead_time) summary.push(`⏱ ${extras.lead_time}`);
  if (extras.tone)      summary.push(`🎭 ${extras.tone}`);

  const trimmed = notesText.trim();
  const transcriptLine = trimmed
    ? `\n📝 _"${trimmed.slice(0, 280)}${trimmed.length > 280 ? '…' : ''}"_`
    : '';

  await send(chatId,
    `✅ Updated *${product?.name ?? 'product'}*` +
    (summary.length ? `\n${summary.join(' · ')}` : '') +
    transcriptLine +
    `\n\n📸 Send the next product photo, or /done.`,
    env, true);
}

async function extractFromDetailsText(text: string, env: Env): Promise<{ price: string; moq: string; lead_time: string; tone: string }> {
  const prompt =
    `Read the following note a buyer wrote about a supplier at a trade show. ` +
    `Pull out: price, minimum order quantity (MOQ), lead time, and overall tone. ` +
    `Return ONLY JSON with these fields:\n` +
    `- price (NORMALIZED to standard money format with currency symbol and decimals — e.g. "$5.20" not "$5 and 20 cents", "€12.50" not "twelve fifty euros". Empty if not mentioned.)\n` +
    `- moq (number with units, e.g. "5,000 pcs", "1 pallet". Empty if not mentioned.)\n` +
    `- lead_time (e.g. "30 days", "4 weeks". Empty if not mentioned.)\n` +
    `- tone (one of: positive, neutral, negative, enthusiastic, skeptical; empty if unclear)\n\n` +
    `NOTE:\n${text}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  if (!data.candidates?.length) return { price: '', moq: '', lead_time: '', tone: '' };
  const raw = data.candidates[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as Partial<{ price: string; moq: string; lead_time: string; tone: string }>;
  return { price: parsed.price ?? '', moq: parsed.moq ?? '', lead_time: parsed.lead_time ?? '', tone: parsed.tone ?? '' };
}

// Single Gemini 2.5 Flash call: takes audio bytes, returns verbatim transcript
// + parsed price/MOQ/lead-time/tone keywords. Audio is OGG/Opus from Telegram.
async function transcribeAndExtract(base64: string, env: Env): Promise<VoiceExtraction> {
  const prompt =
    `You are processing a voice memo a buyer recorded about a supplier at a trade show. ` +
    `Transcribe the audio verbatim in the original language (do not translate). Then scan the ` +
    `transcript for price, minimum order quantity, lead time, and overall tone. ` +
    `Return ONLY a JSON object with these exact fields:\n` +
    `- transcript (verbatim, full)\n` +
    `- language (best-effort 2-letter code, e.g. "en", "zh", "es"; empty if unsure)\n` +
    `- price (NORMALIZED to standard money format with currency symbol and decimals — e.g. "$5.20" not "$5 and 20 cents", "€12.50" not "twelve fifty euros". Empty if no price mentioned.)\n` +
    `- moq (number with units, e.g. "5,000 pcs", "1 pallet". Empty if not mentioned.)\n` +
    `- lead_time (e.g. "30 days", "4 weeks". Empty if not mentioned.)\n` +
    `- tone (one of: positive, neutral, negative, enthusiastic, skeptical; empty if unclear)`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'audio/ogg', data: base64 } },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (!data.candidates?.length) throw new Error(`Gemini voice failed: ${data.error?.message ?? JSON.stringify(data)}`);

  const raw = data.candidates[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as Partial<VoiceExtraction>;
  return {
    transcript: parsed.transcript ?? '',
    language:   parsed.language   ?? '',
    price:      parsed.price      ?? '',
    moq:        parsed.moq        ?? '',
    lead_time:  parsed.lead_time  ?? '',
    tone:       parsed.tone       ?? '',
  };
}

// Best-effort: ask Gemini to extract product name + short description from a product photo.
async function extractProductFromImage(base64: string, mimeType: string, env: Env): Promise<{ type: 'business_card' | 'product'; name: string; description: string }> {
  const prompt =
    `You are looking at a photo a sourcing buyer just took at a trade show. ` +
    `Decide which kind of photo it is: ` +
    `(a) "business_card" — a printed business/contact card (rectangular card, contact details, company logo with email/phone). ` +
    `(b) "product" — a physical product, SKU, sample, or packaging on a booth. ` +
    `Return ONLY JSON: {type: "business_card" | "product", name: string, description: string}. ` +
    `If type is "product", name = short product name (1-6 words), description = one-line description. ` +
    `If type is "business_card", set name and description to empty strings. ` +
    `When unsure between the two, prefer "business_card" only when the photo clearly shows a small rectangular card with multiple lines of contact-like text.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  if (!data.candidates?.length) return { type: 'product', name: '', description: '' };
  const raw = data.candidates[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as { type?: string; name?: string; description?: string };
  const type = parsed.type === 'business_card' ? 'business_card' : 'product';
  return { type, name: parsed.name ?? '', description: parsed.description ?? '' };
}

// ── Local shape used by handleSupplierCard (sourced via shared extract.ts) ──

interface ExtractedContactLocal {
  name:     string;
  title:    string;
  company:  string;
  email:    string;
  phone:    string;
  website:  string;
  linkedin: string;
  address:  string;
  country:  string;
}


// ── Drive upload (single file, public URL) ────────────────────────────────────

async function uploadCardImage(
  buffer: ArrayBuffer,
  contactName: string,
  company: string,
  parentFolderId: string,
  token: string,
): Promise<string> {
  const safe = (s: string) => s.replace(/[^a-z0-9]/gi, '_').slice(0, 60);
  const fileName = `${safe(contactName) || 'card'}${company ? `_${safe(company)}` : ''}.jpg`;

  const boundary = `----dagama_${crypto.randomUUID()}`;
  const meta = JSON.stringify({ name: fileName, mimeType: 'image/jpeg', parents: [parentFolderId] });

  const enc = new TextEncoder();
  const preamble = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  const epilogue = enc.encode(`\r\n--${boundary}--`);
  const bytes = new Uint8Array(buffer);
  const body = new Uint8Array(preamble.length + bytes.length + epilogue.length);
  body.set(preamble, 0);
  body.set(bytes, preamble.length);
  body.set(epilogue, preamble.length + bytes.length);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: body.buffer,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { id?: string };
  if (!data.id) throw new Error('Drive upload returned no id');

  // Make readable by anyone with the link, so =IMAGE() in Sheets works
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions?supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  return `https://lh3.googleusercontent.com/d/${data.id}`;
}

// ── DB + Telegram helpers ────────────────────────────────────────────────────

async function getBuyerForChat(chatId: number, env: Env): Promise<{ buyerId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT buyer_id FROM sb_buyers_telegram WHERE telegram_chat_id = ?`
  ).bind(chatId).first<{ buyer_id: string }>();
  return row ? { buyerId: row.buyer_id } : null;
}

async function send(chatId: number, text: string, env: Env, markdown = false): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: markdown ? 'Markdown' : undefined }),
  });
}

// Send a message that triggers Telegram's "reply to this message" UI on the
// user's keyboard — they can then type or hold-to-record a voice note and the
// app submits it as a reply automatically.
async function sendForceReply(chatId: number, text: string, env: Env, markdown = false): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: markdown ? 'Markdown' : undefined,
      reply_markup: { force_reply: true, input_field_placeholder: 'Type details or hold 🎤 for a voice note' },
    }),
  });
}

// Send a photo back with a caption + force_reply UI, so the reply preview shows
// the photo and the user knows exactly which item they're describing.
async function sendPhotoForceReply(chatId: number, photoFileId: string, caption: string, env: Env, markdown = false): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoFileId,
      caption,
      parse_mode: markdown ? 'Markdown' : undefined,
      reply_markup: { force_reply: true, input_field_placeholder: 'Type details or hold 🎤 for a voice note' },
    }),
  });
}

async function sendButtons(
  chatId: number,
  text: string,
  buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
  env: Env,
  markdown = false,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: markdown ? 'Markdown' : undefined,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
}

async function getSession(chatId: number, env: Env): Promise<SourceBotSession> {
  const row = await env.DB.prepare(
    `SELECT session FROM sb_buyers_telegram WHERE telegram_chat_id = ?`
  ).bind(chatId).first<{ session: string | null }>();
  try {
    return row?.session ? JSON.parse(row.session) as SourceBotSession : { step: 'idle' };
  } catch {
    return { step: 'idle' };
  }
}

async function setSession(chatId: number, session: SourceBotSession, env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE sb_buyers_telegram SET session = ? WHERE telegram_chat_id = ?`
  ).bind(JSON.stringify(session), chatId).run();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
  }
  return btoa(binary);
}

// ── Show pass cron sweep (sb_buyer_shows analog of telegram.ts handleShowPassCron) ──

const SOURCEBOT_WARNING_BEFORE_SEC = 6 * 3600;

export async function handleSourceBotShowPassCron(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN_SOURCE) return; // bot not configured yet

  const now = Math.floor(Date.now() / 1000);

  // 1. Warn buyers approaching expiry
  const toWarn = await env.DB.prepare(
    `SELECT bs.id, bs.buyer_id, bs.show_name, bs.pass_expires_at
     FROM sb_buyer_shows bs
     WHERE bs.status = 'active' AND bs.warning_sent = 0
       AND bs.pass_expires_at - ? <= ? AND bs.pass_expires_at > ?`
  ).bind(now, SOURCEBOT_WARNING_BEFORE_SEC, now)
   .all<{ id: string; buyer_id: string; show_name: string; pass_expires_at: number }>();

  for (const p of toWarn.results) {
    const chatId = await chatIdForBuyer(p.buyer_id, env);
    if (chatId) {
      const hoursLeft = Math.floor((p.pass_expires_at - now) / 3600);
      await send(chatId,
        `⏰ Your Show Pass for *${p.show_name}* ends in ${hoursLeft} hours. ` +
        `Wrap up any final supplier captures — your data stays in your sheet either way.`,
        env, true);
    }
    await env.DB.prepare(`UPDATE sb_buyer_shows SET warning_sent = 1 WHERE id = ?`).bind(p.id).run();
  }

  // 2. active → grace
  const toGrace = await env.DB.prepare(
    `SELECT id, buyer_id, show_name FROM sb_buyer_shows
     WHERE status = 'active' AND pass_expires_at <= ? AND grace_msg_sent = 0`
  ).bind(now).all<{ id: string; buyer_id: string; show_name: string }>();

  for (const p of toGrace.results) {
    await env.DB.prepare(
      `UPDATE sb_buyer_shows SET status = 'grace', updated_at = datetime('now') WHERE id = ?`
    ).bind(p.id).run();
    const chatId = await chatIdForBuyer(p.buyer_id, env);
    if (chatId) {
      await send(chatId,
        `Your Show Pass for *${p.show_name}* has ended. ` +
        `You have a short window to finish any captures in progress.`,
        env, true);
    }
    await env.DB.prepare(`UPDATE sb_buyer_shows SET grace_msg_sent = 1 WHERE id = ?`).bind(p.id).run();
  }

  // 3. grace → readonly
  const toLock = await env.DB.prepare(
    `SELECT id, buyer_id, show_name FROM sb_buyer_shows
     WHERE status = 'grace' AND grace_period_end <= ? AND lock_msg_sent = 0`
  ).bind(now).all<{ id: string; buyer_id: string; show_name: string }>();

  for (const p of toLock.results) {
    await env.DB.prepare(
      `UPDATE sb_buyer_shows SET status = 'readonly', updated_at = datetime('now') WHERE id = ?`
    ).bind(p.id).run();
    const chatId = await chatIdForBuyer(p.buyer_id, env);
    if (chatId) {
      await send(chatId,
        `🔒 Capturing is now closed for *${p.show_name}*. All your suppliers are saved in your sheet.`,
        env, true);
    }
    await env.DB.prepare(`UPDATE sb_buyer_shows SET lock_msg_sent = 1 WHERE id = ?`).bind(p.id).run();
  }
}

async function chatIdForBuyer(buyerId: string, env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT telegram_chat_id FROM sb_buyers_telegram WHERE buyer_id = ? LIMIT 1`
  ).bind(buyerId).first<{ telegram_chat_id: number }>();
  return row?.telegram_chat_id ?? null;
}

// ── Webhook setup helper (call once: POST /api/sourcebot/setup with {url}) ───

export async function handleSourceBotSetupWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.TELEGRAM_BOT_TOKEN_SOURCE) return new Response(JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN_SOURCE not set' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

  let body: { url?: string };
  try { body = await request.json() as typeof body; } catch { return new Response('Bad request', { status: 400 }); }
  if (!body.url) return new Response(JSON.stringify({ error: 'url is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${body.url}/api/sourcebot/webhook`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
    }),
  });
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}

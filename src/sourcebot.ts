/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { consumeOnboardingToken } from './onboarding';
import { getServiceAccountToken, createDriveFolder } from './google';
import { scheduleFunnelOnFirstScan, trackEvent } from './funnel';
import { generateSupplierPdf, generateShowPdf } from './pdf';
import { appendSupplierRow, updateSupplierProducts, updateSupplierVoiceNote, updateSupplierEmailStatus, appendProductRow, updateProductRow, ensureProductsTab, updateSupplierCardBack, updateSupplierPerson } from './sb_sheets';
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

// ── SourceBot session ────────────────────────────────────────────────────────

type SourceBotStep =
  | 'idle'
  | 'awaiting_product_photo'
  | 'awaiting_product_name'
  | 'awaiting_product_price'
  | 'awaiting_product_moq'
  | 'awaiting_product_lead_time'
  | 'awaiting_voice_note'
  | 'awaiting_card_back'
  | 'awaiting_person_photo';

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
  if (text === '/pending')   { await cmdPending(chatId, buyer, env); return; }
  if (text === '/followups') { await cmdFollowups(chatId, buyer, env); return; }
  if (text === '/supplier' || text.startsWith('/supplier ')) {
    await cmdSupplier(chatId, text.slice('/supplier'.length).trim(), buyer, env);
    return;
  }
  if (text === '/products' || text.startsWith('/products ')) {
    await cmdProducts(chatId, text.slice('/products'.length).trim(), buyer, env);
    return;
  }
  if (text === '/shows')                                  { await cmdShows(chatId, buyer, env); return; }
  if (text === '/switch' || text.startsWith('/switch '))  { await cmdSwitch(chatId, text.slice('/switch'.length).trim(), buyer, env); return; }
  if (text === '/allshows')                               { await cmdAllShows(chatId, buyer, env); return; }
  if (text === '/upgrade' || text === '/pay')             { await cmdUpgrade(chatId, buyer, env); return; }
  if (text === '/newshow' || text.startsWith('/newshow ')) { await cmdNewShow(chatId, text.slice('/newshow'.length).trim(), buyer, env); return; }
  if (text === '/pdf' || text.startsWith('/pdf '))         { await cmdPdf(chatId, text.slice('/pdf'.length).trim(), buyer, env); return; }
  if (text === '/pdfshow')                                 { await cmdPdfShow(chatId, buyer, env); return; }
  if (text === '/blast')                                   { await cmdBlast(chatId, buyer, env); return; }
  if (text === '/clear')                                   { await cmdClear(chatId, env); return; }
  if (text === '/tutorial')                                { await cmdTutorial(chatId, env); return; }
  if (text === '/language' || text.startsWith('/language ')) {
    await cmdLanguage(chatId, text.slice('/language'.length).trim(), buyer, env);
    return;
  }
  if (text === '/share')                                   { await cmdShare(chatId, buyer, env); return; }

  // ── Reply-to-message corrections ──
  // If the user is replying to a confirmation message we previously sent, look
  // up which row owns that message_id and treat the reply as a correction.
  if (msg.reply_to_message && text) {
    const handled = await handleCorrectionReply(chatId, msg.reply_to_message.message_id, text, buyer, env);
    if (handled) return;
  }

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
  if (session.step === 'awaiting_card_back') {
    if (msg.photo && msg.photo.length > 0) {
      await handleCardBack(chatId, msg.photo, session, buyer, env);
      return;
    }
    await send(chatId, `📷 Please send the *back of the card* photo, or /cancel.`, env, true);
    return;
  }
  if (session.step === 'awaiting_person_photo') {
    if (msg.photo && msg.photo.length > 0) {
      await handlePersonPhoto(chatId, msg.photo, session, buyer, env);
      return;
    }
    await send(chatId, `👤 Please send a *photo of the person*, or /cancel.`, env, true);
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
  if (data.startsWith('card_back:')) {
    const companyId = data.slice('card_back:'.length);
    await setSession(chatId, { step: 'awaiting_card_back', activeCompanyId: companyId }, env);
    await send(chatId, `📷 Send the *back* of the business card.`, env, true);
    return;
  }
  if (data.startsWith('person_photo:')) {
    const companyId = data.slice('person_photo:'.length);
    await setSession(chatId, { step: 'awaiting_person_photo', activeCompanyId: companyId }, env);
    await send(chatId, `👤 Send a *photo of the person* (e.g. them at the booth). I'll attach it to this contact.`, env, true);
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
  if (data.startsWith('blast_send:')) {
    const showName = data.slice('blast_send:'.length);
    const buyer = await getBuyerForChat(chatId, env);
    if (buyer) await runBlast(chatId, showName, buyer, env);
    return;
  }
  if (data === 'blast_cancel') {
    await send(chatId, `❌ Bulk send cancelled.`, env);
    return;
  }
}

async function runBlast(chatId: number, showName: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  const targets = await env.DB.prepare(
    `SELECT c.id, c.name, MIN(co.email) AS email
       FROM sb_companies c JOIN sb_contacts co ON co.company_id = c.id
       LEFT JOIN sb_emails_sent es ON es.company_id = c.id AND es.status = 'sent'
      WHERE c.buyer_id = ? AND c.show_name = ?
        AND co.email IS NOT NULL AND co.email != ''
        AND es.id IS NULL
      GROUP BY c.id, c.name
      LIMIT 50`
  ).bind(buyer.buyerId, showName).all<{ id: string; name: string; email: string }>();

  if (!targets.results.length) {
    await send(chatId, `Nothing to send.`, env);
    return;
  }
  await send(chatId, `✉️ Sending follow-ups to ${targets.results.length} supplier${targets.results.length === 1 ? '' : 's'}…`, env);

  let ok = 0, failed = 0;
  for (const t of targets.results) {
    try {
      await blastSendOne(chatId, t.id, t.name, t.email, buyer, env);
      ok++;
    } catch (e) {
      console.error('[blast] one failed:', e);
      failed++;
    }
  }
  await send(chatId,
    `✅ *Bulk follow-up complete*\n\nSent: ${ok}${failed ? ` · Failed: ${failed}` : ''}`,
    env, true);
  await trackEvent(env, { buyerId: buyer.buyerId, eventName: 'blast_complete', properties: { ok, failed, show: showName } });
}

async function blastSendOne(chatId: number, companyId: string, supplierName: string, _email: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  // Reuse the /email pipeline: cmdEmail builds + sends a draft. We invoke its
  // internals here by passing the supplier name. The existing implementation
  // already handles confirm+send via callback, but for bulk we want unattended
  // send — fall back to a streamlined path that drafts + sends inline.
  await cmdEmail(chatId, supplierName, buyer, env);
  // Auto-send: pull the latest draft from the session and send it
  const sess = await getSession(chatId, env);
  if (sess.activeEmailDraft) {
    await sendDraftedEmail(chatId, sess.activeEmailDraft.draftId, buyer, env);
  } else {
    // Fall back: insert a row into sb_emails_sent so /pending stops listing it
    await env.DB.prepare(
      `INSERT INTO sb_emails_sent (company_id, buyer_id, show_name, recipient_email, status, error_msg) VALUES (?, ?, '', ?, 'failed', ?)`
    ).bind(companyId, buyer.buyerId, _email, 'No draft generated').run();
  }
}

function toastFor(data: string): string {
  if (data.startsWith('add_product:')) return '📦 Add product';
  if (data.startsWith('add_voice:'))   return '💬 Add details';
  if (data.startsWith('email_send:'))  return '📧 Sending…';
  if (data === 'email_discard')        return '🗑 Discarded';
  if (data === 'done_capturing')       return '✅ Done';
  if (data === 'new_supplier')         return '📷 New supplier';
  if (data.startsWith('card_back:'))    return '📷 Card back';
  if (data.startsWith('person_photo:')) return '👤 Person';
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
    `📸 *Send a business card photo* → supplier saved\n` +
    `📦 *Send product photos* → captured under that supplier\n` +
    `💬 *Reply to any photo* with text or voice → details extracted (price, MOQ, lead time, colors)\n` +
    `✏️ *Reply to a confirmation* with corrections → fields fixed automatically\n\n` +
    `*Lookup commands*\n` +
    `/supplier [query] — list captured suppliers\n` +
    `/products [query] — list captured products\n` +
    `/find <query> — search across suppliers, products, voice notes\n` +
    `/compare <product> — AI ranking across your suppliers\n` +
    `/summary — AI summary of this show\n\n` +
    `*Action commands*\n` +
    `/pending — products missing price or MOQ\n` +
    `/followups — suppliers with email but no follow-up sent\n` +
    `/email <supplier> — draft + send a follow-up email\n` +
    `/blast — bulk send follow-ups to all uncontacted suppliers\n` +
    `/pdf <supplier> — one-pager PDF for a supplier\n` +
    `/pdfshow — PDF recap of the whole show\n` +
    `/connectgmail — connect your Gmail (sends from your address)\n\n` +
    `*Shows + billing*\n` +
    `/shows — list your shows · /switch <name> — change active show\n` +
    `/newshow <name> [days] — register another show\n` +
    `/allshows — cross-show summary\n` +
    `/upgrade — unlock unlimited scans (Stripe)\n\n` +
    `*Account*\n` +
    `/share — your referral link · /tutorial — quick walkthrough\n` +
    `/language [code] — set your language preference\n` +
    `/done · /cancel · /clear — exit current step`,
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

// ── /pending — products missing price or MOQ (per spec) ─────────────────────

async function cmdPending(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  const pass = await env.DB.prepare(
    `SELECT show_name FROM sb_buyer_shows
       WHERE buyer_id = ? AND status IN ('active','grace')
       ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string }>();
  if (!pass) { await send(chatId, `No active show found.`, env); return; }

  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.price, p.moq, p.lead_time, c.name AS supplier
       FROM sb_products p
       JOIN sb_companies c ON c.id = p.company_id
      WHERE p.buyer_id = ? AND p.show_name = ?
        AND ((p.price IS NULL OR p.price = '') OR (p.moq IS NULL OR p.moq = ''))
      ORDER BY p.created_at DESC
      LIMIT 30`
  ).bind(buyer.buyerId, pass.show_name).all<{ id: string; name: string; price: string | null; moq: string | null; lead_time: string | null; supplier: string }>();

  if (!rows.results.length) {
    await send(chatId, `🎉 *${pass.show_name}* — every product has price + MOQ recorded.`, env, true);
    return;
  }

  const lines = rows.results.map(r => {
    const missing: string[] = [];
    if (!r.price) missing.push('price');
    if (!r.moq)   missing.push('MOQ');
    return `• *${r.name}* (${r.supplier}) — missing: ${missing.join(', ')}`;
  }).join('\n');
  await send(chatId,
    `📋 *${rows.results.length} product${rows.results.length === 1 ? '' : 's'} missing details for ${pass.show_name}:*\n\n${lines}\n\n` +
    `Send a voice note or text reply to a product photo to fill in price/MOQ/lead time.`,
    env, true);
}

// ── /followups — suppliers with email but no follow-up sent yet ─────────────

async function cmdFollowups(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  const pass = await env.DB.prepare(
    `SELECT show_name FROM sb_buyer_shows
       WHERE buyer_id = ? AND status IN ('active','grace')
       ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string }>();
  if (!pass) { await send(chatId, `No active show found.`, env); return; }

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
    await send(chatId, `🎉 No pending follow-ups for *${pass.show_name}*.`, env, true);
    return;
  }
  const lines = rows.results.map(r => `• *${r.name}* — ${r.email}`).join('\n');
  await send(chatId,
    `📬 *${rows.results.length} supplier${rows.results.length === 1 ? '' : 's'} pending follow-up:*\n\n${lines}\n\n` +
    `Use \`/email <name>\` to draft and send.`,
    env, true);
}

// ── /supplier — list captured suppliers + counts in active show ─────────────

async function cmdSupplier(chatId: number, query: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  const pass = await env.DB.prepare(
    `SELECT show_name, sheet_url FROM sb_buyer_shows
       WHERE buyer_id = ? AND status IN ('active','grace')
       ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string; sheet_url: string }>();
  if (!pass) { await send(chatId, `No active show found.`, env); return; }

  const where = query
    ? `c.buyer_id = ? AND c.show_name = ? AND lower(c.name) LIKE lower(?)`
    : `c.buyer_id = ? AND c.show_name = ?`;
  const binds: (string | number)[] = query
    ? [buyer.buyerId, pass.show_name, `%${query}%`]
    : [buyer.buyerId, pass.show_name];

  const rows = await env.DB.prepare(
    `SELECT c.id, c.name,
            (SELECT COUNT(*) FROM sb_products p WHERE p.company_id = c.id) AS product_count,
            (SELECT MIN(co.email) FROM sb_contacts co WHERE co.company_id = c.id) AS email
       FROM sb_companies c
      WHERE ${where}
      ORDER BY c.created_at DESC
      LIMIT 30`
  ).bind(...binds).all<{ id: string; name: string; product_count: number; email: string | null }>();

  if (!rows.results.length) {
    await send(chatId, query
      ? `No suppliers matching "${query}" in *${pass.show_name}*.`
      : `No suppliers captured yet in *${pass.show_name}*. Send a card photo to start.`,
      env, true);
    return;
  }

  const lines = rows.results.map(r =>
    `• *${r.name}* — ${r.product_count} product${r.product_count === 1 ? '' : 's'}` +
    (r.email ? ` · ${r.email}` : '')
  ).join('\n');
  await send(chatId,
    `🏢 *${rows.results.length} supplier${rows.results.length === 1 ? '' : 's'} in ${pass.show_name}:*\n\n${lines}\n\n` +
    `📊 [Open Sheet](${pass.sheet_url})`,
    env, true);
}

// ── /products — list products in active show, optional filter ────────────────

async function cmdProducts(chatId: number, query: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  const pass = await env.DB.prepare(
    `SELECT show_name FROM sb_buyer_shows
       WHERE buyer_id = ? AND status IN ('active','grace')
       ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string }>();
  if (!pass) { await send(chatId, `No active show found.`, env); return; }

  const where = query
    ? `p.buyer_id = ? AND p.show_name = ? AND (lower(p.name) LIKE lower(?) OR lower(c.name) LIKE lower(?))`
    : `p.buyer_id = ? AND p.show_name = ?`;
  const binds: string[] = query
    ? [buyer.buyerId, pass.show_name, `%${query}%`, `%${query}%`]
    : [buyer.buyerId, pass.show_name];

  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.price, p.moq, p.lead_time, c.name AS supplier
       FROM sb_products p
       JOIN sb_companies c ON c.id = p.company_id
      WHERE ${where}
      ORDER BY p.created_at DESC
      LIMIT 30`
  ).bind(...binds).all<{ id: string; name: string; price: string | null; moq: string | null; lead_time: string | null; supplier: string }>();

  if (!rows.results.length) {
    await send(chatId, query
      ? `No products matching "${query}" in *${pass.show_name}*.`
      : `No products captured yet. Send a card → photo to start.`,
      env, true);
    return;
  }

  const lines = rows.results.map(r =>
    `• *${r.name}* (${r.supplier})` +
    (r.price     ? ` — ${r.price}`     : '') +
    (r.moq       ? ` · MOQ ${r.moq}`   : '') +
    (r.lead_time ? ` · ${r.lead_time}` : '')
  ).join('\n');
  await send(chatId,
    `📦 *${rows.results.length} product${rows.results.length === 1 ? '' : 's'} in ${pass.show_name}:*\n\n${lines}`,
    env, true);
}

// ── /shows · /switch · /allshows · /newshow · /upgrade ──────────────────────

async function cmdShows(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, show_name, status, duration_days, paid_plan, total_captures, created_at
       FROM sb_buyer_shows
      WHERE buyer_id = ?
      ORDER BY (status = 'active') DESC, created_at DESC`
  ).bind(buyer.buyerId).all<{ id: string; show_name: string; status: string; duration_days: number; paid_plan: string | null; total_captures: number; created_at: string }>();

  if (!rows.results.length) {
    await send(chatId, `No shows yet. Use /newshow <name> [days] to register one.`, env);
    return;
  }

  const buyerRow = await env.DB.prepare(`SELECT current_show_id FROM sb_buyers WHERE id = ?`).bind(buyer.buyerId).first<{ current_show_id: string | null }>();
  const lines = rows.results.map(r => {
    const active = (buyerRow?.current_show_id === r.id) || (!buyerRow?.current_show_id && r.status === 'active');
    const paid = r.paid_plan ? ` · 💳 ${r.paid_plan}` : ' · 🆓 free';
    return `${active ? '✅' : '  '} *${r.show_name}* — ${r.duration_days}d · ${r.total_captures} capture${r.total_captures === 1 ? '' : 's'} · ${r.status}${paid}`;
  }).join('\n');

  await send(chatId,
    `🗓 *Your shows:*\n\n${lines}\n\nUse \`/switch <name>\` to change the active show.`,
    env, true);
}

async function cmdSwitch(chatId: number, query: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!query) {
    await send(chatId, `Usage: \`/switch <show name>\``, env, true);
    return;
  }
  const target = await env.DB.prepare(
    `SELECT id, show_name FROM sb_buyer_shows
      WHERE buyer_id = ? AND lower(show_name) LIKE lower(?)
      ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId, `%${query}%`).first<{ id: string; show_name: string }>();
  if (!target) {
    await send(chatId, `No show matching "${query}". Use /shows to see your list.`, env);
    return;
  }
  await env.DB.prepare(`UPDATE sb_buyers SET current_show_id = ? WHERE id = ?`).bind(target.id, buyer.buyerId).run();
  await send(chatId, `🔁 Active show is now *${target.show_name}*.`, env, true);
}

async function cmdAllShows(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT
        bs.show_name,
        bs.duration_days,
        bs.status,
        (SELECT COUNT(*) FROM sb_companies c  WHERE c.buyer_id = bs.buyer_id AND c.show_name  = bs.show_name) AS suppliers,
        (SELECT COUNT(*) FROM sb_products  p  WHERE p.buyer_id = bs.buyer_id AND p.show_name  = bs.show_name) AS products,
        (SELECT COUNT(*) FROM sb_emails_sent e WHERE e.buyer_id = bs.buyer_id AND e.show_name = bs.show_name AND e.status = 'sent') AS emails
       FROM sb_buyer_shows bs
      WHERE bs.buyer_id = ?
      ORDER BY bs.created_at DESC`
  ).bind(buyer.buyerId).all<{ show_name: string; duration_days: number; status: string; suppliers: number; products: number; emails: number }>();

  if (!rows.results.length) {
    await send(chatId, `No shows yet.`, env);
    return;
  }

  const totals = rows.results.reduce((acc, r) => ({ s: acc.s + r.suppliers, p: acc.p + r.products, e: acc.e + r.emails }), { s: 0, p: 0, e: 0 });
  const lines = rows.results.map(r =>
    `*${r.show_name}* (${r.duration_days}d · ${r.status}) — ${r.suppliers} suppliers · ${r.products} products · ${r.emails} emails`
  ).join('\n');

  await send(chatId,
    `📊 *Cross-show summary:*\n\n${lines}\n\n*Totals:* ${totals.s} suppliers · ${totals.p} products · ${totals.e} emails sent`,
    env, true);
}

async function cmdNewShow(chatId: number, query: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!query) {
    await send(chatId, `Usage: \`/newshow <name> [duration_days]\` — e.g. \`/newshow Canton Fair 5\``, env, true);
    return;
  }
  // Parse optional trailing number for duration_days
  const m = query.match(/^(.+?)\s+(\d+)$/);
  const showName     = (m ? m[1] : query).trim();
  const durationDays = m ? parseInt(m[2], 10) : 3;

  const now = Math.floor(Date.now() / 1000);
  const SHOW_PASS_DURATION_SEC = 96 * 3600;
  const GRACE_PERIOD_SEC       = 2 * 3600;
  const passExpiresAt  = now + SHOW_PASS_DURATION_SEC;
  const gracePeriodEnd = passExpiresAt + GRACE_PERIOD_SEC;

  // Get the existing buyer's first show (for sheet/folder reuse) — minimum viable: reuse the same sheet+folder
  const existingShow = await env.DB.prepare(
    `SELECT sheet_id, sheet_url, drive_folder_id, drive_folder_url FROM sb_buyer_shows WHERE buyer_id = ? ORDER BY created_at LIMIT 1`
  ).bind(buyer.buyerId).first<{ sheet_id: string; sheet_url: string; drive_folder_id: string | null; drive_folder_url: string | null }>();

  if (!existingShow) {
    await send(chatId, `Can't add a show without an existing one. Onboard first via the website.`, env);
    return;
  }

  const ins = await env.DB.prepare(
    `INSERT INTO sb_buyer_shows
       (buyer_id, show_name, status, sheet_id, sheet_url, drive_folder_id, drive_folder_url,
        pass_expires_at, grace_period_end, duration_days,
        free_scans_limit)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  ).bind(
    buyer.buyerId, showName,
    existingShow.sheet_id, existingShow.sheet_url,
    existingShow.drive_folder_id, existingShow.drive_folder_url,
    passExpiresAt, gracePeriodEnd, durationDays,
    durationDays === 2 ? 10 : null,
  ).first<{ id: string }>();

  await env.DB.prepare(`UPDATE sb_buyers SET current_show_id = ? WHERE id = ?`).bind(ins?.id, buyer.buyerId).run();

  const passNote = durationDays === 2
    ? '10 scans on Day 1 · then upgrade to keep going'
    : '24h unlimited from your first scan · then upgrade to keep going';
  await send(chatId,
    `✅ Show *${showName}* registered (${durationDays} days).\n\n🆓 Free tier: ${passNote}\n\nIt's now your active show — start sending cards!`,
    env, true);
}

async function cmdUpgrade(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  const pass = await getActivePass(buyer.buyerId, env);
  if (!pass) { await send(chatId, `No active show to upgrade.`, env); return; }

  if (pass.paid_plan) {
    await send(chatId, `✅ *${pass.show_name}* is already on the *${pass.paid_plan}* plan.`, env, true);
    return;
  }

  // Build a Stripe Checkout session for event_49 (single-show pass).
  const priceId = env.STRIPE_PRICE_SINGLE_SHOW;
  if (!priceId || priceId.startsWith('price_placeholder')) {
    await send(chatId,
      `💳 *Upgrade to keep capturing*\n\n` +
      `Plans:\n` +
      `• *event_49* — $49, unlimited scans for this show\n` +
      `• *event_199* — $199, 5-show pack (coming soon)\n` +
      `• *team_79* — $79/mo, team plan (coming soon)\n\n` +
      `_Stripe is not yet configured for SourceBot. Contact support._`,
      env, true);
    return;
  }

  const buyerRow = await env.DB.prepare(`SELECT email, name FROM sb_buyers WHERE id = ?`).bind(buyer.buyerId).first<{ email: string; name: string }>();
  if (!buyerRow) { await send(chatId, `Buyer not found.`, env); return; }

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  params.set('customer_email', buyerRow.email);
  params.set('success_url', `${env.ORIGIN}/upgrade-success?show=${encodeURIComponent(pass.show_name)}`);
  params.set('cancel_url',  `${env.ORIGIN}/upgrade-cancel`);
  params.set('metadata[bot]',          'sourcebot');
  params.set('metadata[buyer_id]',     buyer.buyerId);
  params.set('metadata[show_id]',      pass.id);
  params.set('metadata[show_name]',    pass.show_name);
  params.set('metadata[plan]',         'event_49');
  params.set('allow_promotion_codes',  'true');

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const d = await r.json() as { url?: string; id?: string; error?: { message: string } };
  if (!r.ok || !d.url) {
    console.error('[sourcebot] stripe checkout failed:', d);
    await send(chatId, `❌ Couldn't create checkout: ${d.error?.message ?? 'unknown'}`, env);
    return;
  }

  if (d.id) {
    await env.DB.prepare(`UPDATE sb_buyer_shows SET stripe_session_id = ? WHERE id = ?`).bind(d.id, pass.id).run();
  }

  await send(chatId,
    `💳 *Upgrade ${pass.show_name} — $49*\n\nUnlimited scans for this show + post-show retargeting.\n\n[Pay securely with Stripe](${d.url})`,
    env, true);
  await trackEvent(env, { buyerId: buyer.buyerId, showId: pass.id, eventName: 'upgrade_clicked', properties: { plan: 'event_49' } });
}

// Look up the buyer's active show, honoring an explicit /switch override.
interface ActivePass {
  id: string;
  show_name: string;
  status: string;
  duration_days: number;
  first_scan_at: number | null;
  free_window_ends_at: number | null;
  free_scans_limit: number | null;
  free_scans_used: number;
  paid_plan: string | null;
  sheet_id: string | null;
  sheet_url: string | null;
  drive_folder_id: string | null;
}

async function getActivePass(buyerId: string, env: Env): Promise<ActivePass | null> {
  const buyerRow = await env.DB.prepare(`SELECT current_show_id FROM sb_buyers WHERE id = ?`).bind(buyerId).first<{ current_show_id: string | null }>();
  if (buyerRow?.current_show_id) {
    const r = await env.DB.prepare(
      `SELECT id, show_name, status, duration_days, first_scan_at, free_window_ends_at,
              free_scans_limit, free_scans_used, paid_plan, sheet_id, sheet_url, drive_folder_id
         FROM sb_buyer_shows WHERE id = ?`
    ).bind(buyerRow.current_show_id).first<ActivePass>();
    if (r) return r;
  }
  return env.DB.prepare(
    `SELECT id, show_name, status, duration_days, first_scan_at, free_window_ends_at,
            free_scans_limit, free_scans_used, paid_plan, sheet_id, sheet_url, drive_folder_id
       FROM sb_buyer_shows
      WHERE buyer_id = ? AND status IN ('active','grace')
      ORDER BY created_at DESC LIMIT 1`
  ).bind(buyerId).first<ActivePass>();
}

// Plan rules (per spec):
//   - Paid plan → unlimited
//   - First scan: trigger free window → 24h unlimited (3+ day shows) OR 10 scans (2-day shows)
//   - Subsequent scans: enforce window/cap
// Returns { allowed: true } or { allowed: false, reason }
interface ScanCheck { allowed: boolean; reason?: string; }

async function checkAndConsumeScan(pass: ActivePass, env: Env): Promise<ScanCheck> {
  const now = Math.floor(Date.now() / 1000);

  if (pass.paid_plan) {
    await env.DB.prepare(
      `UPDATE sb_buyer_shows SET total_captures = total_captures + 1, last_capture_at = ? WHERE id = ?`
    ).bind(now, pass.id).run();
    return { allowed: true };
  }

  // First scan — set the free window AND schedule the funnel emails.
  if (!pass.first_scan_at) {
    const isShortShow = pass.duration_days === 2;
    const windowEnd = isShortShow ? null : now + 24 * 3600;
    const limit     = isShortShow ? 10   : null;
    await env.DB.prepare(
      `UPDATE sb_buyer_shows
          SET first_scan_at = ?, free_window_ends_at = ?, free_scans_limit = ?,
              free_scans_used = 1, total_captures = total_captures + 1, last_capture_at = ?
        WHERE id = ?`
    ).bind(now, windowEnd, limit, now, pass.id).run();

    // Pull buyer for funnel scheduling
    const buyerRow = await env.DB.prepare(`SELECT b.id AS buyer_id FROM sb_buyers b JOIN sb_buyer_shows s ON s.buyer_id = b.id WHERE s.id = ?`).bind(pass.id).first<{ buyer_id: string }>();
    if (buyerRow) {
      await scheduleFunnelOnFirstScan({
        buyerId:      buyerRow.buyer_id,
        showId:       pass.id,
        firstScanAt:  now,
        durationDays: pass.duration_days,
      }, env);
      await trackEvent(env, { buyerId: buyerRow.buyer_id, showId: pass.id, eventName: 'show_first_scan', properties: { duration_days: pass.duration_days } });
    }
    return { allowed: true };
  }

  // Time-window expired (3+ day shows)
  if (pass.free_window_ends_at && now > pass.free_window_ends_at) {
    return { allowed: false, reason: `🆓 Your 24h free window for *${pass.show_name}* ended. Tap /upgrade for unlimited scans + post-show retargeting.` };
  }

  // Scan-count exceeded (2-day shows)
  if (pass.free_scans_limit !== null && pass.free_scans_used >= pass.free_scans_limit) {
    return { allowed: false, reason: `🆓 You've used all ${pass.free_scans_limit} free scans for *${pass.show_name}*. Tap /upgrade for unlimited.` };
  }

  // Allowed — increment counters
  await env.DB.prepare(
    `UPDATE sb_buyer_shows
        SET free_scans_used = free_scans_used + 1,
            total_captures  = total_captures + 1,
            last_capture_at = ?
      WHERE id = ?`
  ).bind(now, pass.id).run();
  return { allowed: true };
}

// ── /pdf · /pdfshow · /blast · /clear ───────────────────────────────────────

async function cmdPdf(chatId: number, query: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  if (!query) {
    await send(chatId, `Usage: \`/pdf <supplier name>\` — generates a one-pager PDF with all photos + products.`, env, true);
    return;
  }
  const pass = await env.DB.prepare(
    `SELECT show_name FROM sb_buyer_shows WHERE buyer_id = ? AND status IN ('active','grace') ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string }>();
  if (!pass) { await send(chatId, `No active show found.`, env); return; }

  const company = await env.DB.prepare(
    `SELECT id, name FROM sb_companies WHERE buyer_id = ? AND show_name = ? AND lower(name) LIKE lower(?) ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId, pass.show_name, `%${query}%`).first<{ id: string; name: string }>();
  if (!company) { await send(chatId, `No supplier matching "${query}".`, env); return; }

  await send(chatId, `📄 Generating PDF for *${company.name}*… (a few seconds)`, env, true);
  try {
    const result = await generateSupplierPdf(company.id, env);
    if (!result) { await send(chatId, `❌ Couldn't generate PDF (folder not provisioned yet?).`, env); return; }
    await send(chatId,
      `✅ *${company.name}* PDF ready:\n\n📄 [Download PDF](${result.pdfUrl})\n📝 [Open as Doc](${result.docUrl})`,
      env, true);
    await trackEvent(env, { buyerId: buyer.buyerId, eventName: 'pdf_supplier', properties: { company: company.name } });
  } catch (e) {
    console.error('[sourcebot] /pdf failed:', e);
    await send(chatId, `❌ PDF generation failed.`, env);
  }
}

async function cmdPdfShow(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  const pass = await env.DB.prepare(
    `SELECT show_name FROM sb_buyer_shows WHERE buyer_id = ? AND status IN ('active','grace') ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string }>();
  if (!pass) { await send(chatId, `No active show found.`, env); return; }

  await send(chatId, `📄 Generating *${pass.show_name}* recap PDF… (this may take a minute for many suppliers)`, env, true);
  try {
    const result = await generateShowPdf(buyer.buyerId, pass.show_name, env);
    if (!result) { await send(chatId, `❌ Couldn't generate PDF.`, env); return; }
    await send(chatId,
      `✅ *${pass.show_name}* recap ready:\n\n📄 [Download PDF](${result.pdfUrl})\n📝 [Open as Doc](${result.docUrl})`,
      env, true);
    await trackEvent(env, { buyerId: buyer.buyerId, eventName: 'pdf_show', properties: { show: pass.show_name } });
  } catch (e) {
    console.error('[sourcebot] /pdfshow failed:', e);
    await send(chatId, `❌ PDF generation failed.`, env);
  }
}

async function cmdBlast(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  const pass = await env.DB.prepare(
    `SELECT show_name FROM sb_buyer_shows WHERE buyer_id = ? AND status IN ('active','grace') ORDER BY created_at DESC LIMIT 1`
  ).bind(buyer.buyerId).first<{ show_name: string }>();
  if (!pass) { await send(chatId, `No active show found.`, env); return; }

  // Pick suppliers with email + no follow-up sent yet
  const targets = await env.DB.prepare(
    `SELECT c.id, c.name, MIN(co.email) AS email
       FROM sb_companies c
       JOIN sb_contacts co ON co.company_id = c.id
       LEFT JOIN sb_emails_sent es ON es.company_id = c.id AND es.status = 'sent'
      WHERE c.buyer_id = ? AND c.show_name = ?
        AND co.email IS NOT NULL AND co.email != ''
        AND es.id IS NULL
      GROUP BY c.id, c.name
      ORDER BY c.created_at DESC
      LIMIT 50`
  ).bind(buyer.buyerId, pass.show_name).all<{ id: string; name: string; email: string }>();

  if (!targets.results.length) {
    await send(chatId, `🎉 No suppliers pending follow-up in *${pass.show_name}*.`, env, true);
    return;
  }

  await sendButtons(chatId,
    `📧 *Bulk follow-up — ${pass.show_name}*\n\n` +
    `${targets.results.length} supplier${targets.results.length === 1 ? '' : 's'} have an email but no follow-up sent yet:\n\n` +
    targets.results.slice(0, 10).map(t => `• ${t.name} — ${t.email}`).join('\n') +
    (targets.results.length > 10 ? `\n…and ${targets.results.length - 10} more.\n` : '\n') +
    `\nThis will draft + send a personalized follow-up to each.`,
    [
      [{ text: '✉️ Send all', callback_data: `blast_send:${pass.show_name}` }],
      [{ text: '❌ Cancel', callback_data: 'blast_cancel' }],
    ],
    env, true);
}

async function cmdClear(chatId: number, env: Env): Promise<void> {
  await setSession(chatId, { step: 'idle' }, env);
  await send(chatId, `✅ Cleared current state. Send a card photo to start.`, env);
}

async function cmdTutorial(chatId: number, env: Env): Promise<void> {
  await send(chatId,
    `🎓 *DaGama SourceBot in 60 seconds*\n\n` +
    `*1.* Snap a supplier's business card → I'll OCR it and save them to your sheet.\n\n` +
    `*2.* Snap product photos one after another → each becomes a row on the *Products* tab with the photo embedded.\n\n` +
    `*3.* *Reply* (text or voice 🎤) to any product photo → I extract price, MOQ, lead time, colors, materials.\n\n` +
    `*4.* *Reply* to a supplier confirmation if I got something wrong (e.g. "name: Uriel Aziz") → I fix the row.\n\n` +
    `*5.* End of day, you'll get an email digest. Next morning, a recap. Three days later, a follow-up summary.\n\n` +
    `*6.* When you want to email a supplier: \`/email <name>\`. Or \`/blast\` to send to everyone uncontacted.\n\n` +
    `Other shortcuts: \`/supplier\`, \`/products\`, \`/pending\`, \`/pdf <name>\`, \`/pdfshow\`, \`/share\`.\n\n` +
    `Type /help for the full command list.`,
    env, true);
}

async function cmdLanguage(chatId: number, code: string, buyer: { buyerId: string }, env: Env): Promise<void> {
  const supported: Record<string, string> = {
    en: 'English', es: 'Español', zh: '中文', fr: 'Français', de: 'Deutsch',
    pt: 'Português', it: 'Italiano', ar: 'العربية', he: 'עברית', ja: '日本語',
  };
  if (!code) {
    const lines = Object.entries(supported).map(([k, v]) => `\`/language ${k}\` — ${v}`).join('\n');
    await send(chatId, `🌐 *Pick a language:*\n\n${lines}\n\n_Bot interface is currently English; this preference is stored for upcoming localization._`, env, true);
    return;
  }
  if (!supported[code]) {
    await send(chatId, `Unknown code "${code}". Use /language to see options.`, env);
    return;
  }
  await env.DB.prepare(`UPDATE sb_buyers SET language = ? WHERE id = ?`).bind(code, buyer.buyerId).run();
  await send(chatId, `✅ Language preference set to *${supported[code]}*.`, env, true);
}

async function cmdShare(chatId: number, buyer: { buyerId: string }, env: Env): Promise<void> {
  const row = await env.DB.prepare(`SELECT referral_code, name FROM sb_buyers WHERE id = ?`).bind(buyer.buyerId).first<{ referral_code: string | null; name: string }>();
  if (!row?.referral_code) {
    // Backfill if missing
    const code = (crypto.randomUUID() as string).split('-')[0];
    await env.DB.prepare(`UPDATE sb_buyers SET referral_code = ? WHERE id = ?`).bind(code, buyer.buyerId).run();
    if (row) row.referral_code = code;
  }
  const code = row?.referral_code ?? '';
  const link = `${env.ORIGIN}/?ref=${code}`;
  await send(chatId,
    `🎁 *Refer a friend, both get rewarded*\n\n` +
    `Share this link with a buyer headed to a trade show:\n${link}\n\n` +
    `When they sign up and capture their first show, you both get a free show pass.`,
    env, true);
  await trackEvent(env, { buyerId: buyer.buyerId, eventName: 'referral_link_viewed' });
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

  // Find the buyer's active show pass (sheet location + plan state)
  const pass = await getActivePass(buyer.buyerId, env);
  if (!pass?.sheet_id) {
    await send(chatId, `⚠️ I couldn't find an active show for your account. Use /shows or contact support.`, env);
    return;
  }

  // Plan rules: paid → unlimited; free 3+ day shows → 24h from first scan;
  // free 2-day shows → 10 scans Day 1. Block + prompt /upgrade if exceeded.
  const check = await checkAndConsumeScan(pass, env);
  if (!check.allowed) {
    await send(chatId, check.reason ?? `Free tier exhausted. Tap /upgrade to keep capturing.`, env, true);
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

  // 3b. Per-supplier folder set: "{Company} — {Month YYYY}" / Cards / Products
  let folders: SupplierFolders | undefined;
  if (pass.drive_folder_id) {
    try {
      folders = await getOrCreateSupplierFolders(companyId, companyName, pass.drive_folder_id, env);
    } catch (e) {
      console.error('[sourcebot] supplier folder create failed:', e);
    }
  }

  // 3c. Upload card front to Cards/ subfolder (or fall back to the show folder).
  let cardUrl: string | undefined;
  try {
    const parent = folders?.cards ?? pass.drive_folder_id;
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
    `\n_Reply to this message to fix any field._\n` +
    `\n📦 *Send product photos* to attach them to this supplier — or tap below.`;

  const { messageId } = await sendButtons(chatId,
    preview,
    [
      [{ text: '📷 Scan back of card',  callback_data: `card_back:${companyId}` },
       { text: '👤 Person photo',       callback_data: `person_photo:${companyId}` }],
      [{ text: '💬 Add details',         callback_data: `add_voice:${companyId}` }],
      [{ text: '📷 New supplier card',  callback_data: 'new_supplier' }],
      [{ text: '✅ Done',                callback_data: 'done_capturing' }],
    ],
    env, true);

  // Remember this message_id so reply-to-corrections can route back to this row.
  if (messageId) {
    await env.DB.prepare(`UPDATE sb_companies SET confirmation_message_id = ? WHERE id = ?`).bind(messageId, companyId).run();
    await env.DB.prepare(
      `UPDATE sb_contacts SET confirmation_message_id = ?
        WHERE id = (SELECT id FROM sb_contacts WHERE company_id = ? ORDER BY created_at DESC LIMIT 1)`
    ).bind(messageId, companyId).run();
  }

  await trackEvent(env, { buyerId: buyer.buyerId, eventName: 'supplier_captured', properties: { company: companyName, has_email: !!extracted.email } });
}

// ── Reply-to-confirmation correction handler ───────────────────────────────

// Returns true if we recognized the reply as a correction we could route.
async function handleCorrectionReply(
  chatId: number,
  repliedToMsgId: number,
  text: string,
  buyer: { buyerId: string },
  env: Env,
): Promise<boolean> {
  // Try contact (most common — user fixes a name/email/phone typo on the supplier card)
  const contact = await env.DB.prepare(
    `SELECT c.id, c.company_id, c.name, c.title, c.email, c.phone, c.linkedin_url, c.address,
            co.show_name, co.sheet_row, co.name AS company_name
       FROM sb_contacts c JOIN sb_companies co ON co.id = c.company_id
      WHERE c.confirmation_message_id = ? AND c.buyer_id = ?`
  ).bind(repliedToMsgId, buyer.buyerId).first<{
    id: string; company_id: string; name: string | null; title: string | null;
    email: string | null; phone: string | null; linkedin_url: string | null; address: string | null;
    show_name: string; sheet_row: number | null; company_name: string;
  }>();

  if (contact) {
    return applyContactCorrection(chatId, text, contact, buyer, env);
  }

  // Try product
  const product = await env.DB.prepare(
    `SELECT p.id, p.company_id, p.name, p.description, p.price, p.moq, p.lead_time, p.sheet_row,
            co.show_name
       FROM sb_products p JOIN sb_companies co ON co.id = p.company_id
      WHERE p.confirmation_message_id = ? AND p.buyer_id = ?`
  ).bind(repliedToMsgId, buyer.buyerId).first<{
    id: string; company_id: string; name: string; description: string | null;
    price: string | null; moq: string | null; lead_time: string | null; sheet_row: number | null;
    show_name: string;
  }>();

  if (product) {
    return applyProductCorrection(chatId, text, product, buyer, env);
  }

  return false;
}

interface ContactCorrectionRow {
  id: string; company_id: string; name: string | null; title: string | null;
  email: string | null; phone: string | null; linkedin_url: string | null; address: string | null;
  show_name: string; sheet_row: number | null; company_name: string;
}

async function applyContactCorrection(
  chatId: number,
  text: string,
  c: ContactCorrectionRow,
  buyer: { buyerId: string },
  env: Env,
): Promise<boolean> {
  const prompt =
    `A buyer is correcting a previously-extracted business card. Original fields:\n` +
    `name: ${c.name ?? ''}\ntitle: ${c.title ?? ''}\nemail: ${c.email ?? ''}\n` +
    `phone: ${c.phone ?? ''}\nlinkedin: ${c.linkedin_url ?? ''}\naddress: ${c.address ?? ''}\n` +
    `company: ${c.company_name}\n\n` +
    `BUYER'S CORRECTION (free text):\n${text}\n\n` +
    `Return ONLY a JSON object with the fields the buyer is updating. Use these exact keys: ` +
    `name, title, email, phone, linkedin, address, company. Omit fields the buyer didn't mention.`;
  let updates: Record<string, string> = {};
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    const d = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = d.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    updates = JSON.parse(raw.replace(/```json|```/g, '').trim()) as Record<string, string>;
  } catch (e) {
    console.error('[sourcebot] correction parse failed:', e);
    await send(chatId, `⚠️ I couldn't understand that correction. Try: "name: Uriel Aziz" or "fix email to uriel@dazzle.com.hk".`, env);
    return true;
  }

  // Apply to D1
  if (Object.keys(updates).length === 0) {
    await send(chatId, `🤔 I couldn't find a field to update in that reply. Try naming the field, e.g. "name: Uriel Aziz".`, env);
    return true;
  }

  const setParts: string[] = [];
  const binds: (string | null)[] = [];
  if ('name'    in updates) { setParts.push('name = ?');         binds.push(updates.name    || null); }
  if ('title'   in updates) { setParts.push('title = ?');        binds.push(updates.title   || null); }
  if ('email'   in updates) { setParts.push('email = ?');        binds.push(updates.email   || null); }
  if ('phone'   in updates) { setParts.push('phone = ?');        binds.push(updates.phone   || null); }
  if ('linkedin' in updates){ setParts.push('linkedin_url = ?'); binds.push(updates.linkedin|| null); }
  if ('address' in updates) { setParts.push('address = ?');      binds.push(updates.address || null); }
  if (setParts.length) {
    await env.DB.prepare(`UPDATE sb_contacts SET ${setParts.join(', ')} WHERE id = ?`).bind(...binds, c.id).run();
  }

  // Company name is on sb_companies, not sb_contacts
  let companyChanged = false;
  if ('company' in updates && updates.company && updates.company !== c.company_name) {
    await env.DB.prepare(`UPDATE sb_companies SET name = ? WHERE id = ?`).bind(updates.company, c.company_id).run();
    companyChanged = true;
  }

  // Push to the sheet (Suppliers tab columns C–I + B for company)
  if (c.sheet_row) {
    try {
      const sheet = await env.DB.prepare(`SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`).bind(buyer.buyerId, c.show_name).first<{ sheet_id: string }>();
      if (sheet?.sheet_id) {
        const tok = await getServiceAccountToken(env);
        // Re-fetch the corrected contact + company
        const fresh = await env.DB.prepare(
          `SELECT c.name, c.title, c.email, c.phone, c.linkedin_url, c.address, co.name AS company_name
             FROM sb_contacts c JOIN sb_companies co ON co.id = c.company_id WHERE c.id = ?`
        ).bind(c.id).first<{ name: string | null; title: string | null; email: string | null; phone: string | null; linkedin_url: string | null; address: string | null; company_name: string }>();
        if (fresh) {
          // B=Company, C=Name, D=Title, E=Email, F=Phone, I=LinkedIn (and address goes nowhere on the supplier row currently)
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.sheet_id}/values/B${c.sheet_row}:I${c.sheet_row}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              values: [[
                fresh.company_name,
                fresh.name ?? '',
                fresh.title ?? '',
                fresh.email ?? '',
                fresh.phone ?? '',
                '', // G phone country
                '', // H website unchanged
                fresh.linkedin_url ?? '',
              ]],
            }),
          });
        }
      }
    } catch (e) { console.error('[sourcebot] correction sheet update failed:', e); }
  }

  const updatedFields = Object.keys(updates).filter(k => updates[k]);
  await send(chatId, `✅ Updated: ${updatedFields.join(', ')}${companyChanged ? ' (company name changed)' : ''}.`, env);
  return true;
}

interface ProductCorrectionRow {
  id: string; company_id: string; name: string; description: string | null;
  price: string | null; moq: string | null; lead_time: string | null; sheet_row: number | null;
  show_name: string;
}

async function applyProductCorrection(
  chatId: number,
  text: string,
  p: ProductCorrectionRow,
  buyer: { buyerId: string },
  env: Env,
): Promise<boolean> {
  const prompt =
    `A buyer is correcting a previously-saved product. Original fields:\n` +
    `name: ${p.name}\nprice: ${p.price ?? ''}\nmoq: ${p.moq ?? ''}\nlead_time: ${p.lead_time ?? ''}\n` +
    `description: ${p.description ?? ''}\n\n` +
    `BUYER'S CORRECTION:\n${text}\n\n` +
    `Return ONLY JSON with the fields being updated. Keys: name, price (normalized e.g. "$5.20"), ` +
    `moq, lead_time, description. Omit fields not mentioned.`;
  let updates: Record<string, string> = {};
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    const d = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = d.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    updates = JSON.parse(raw.replace(/```json|```/g, '').trim()) as Record<string, string>;
  } catch (e) {
    console.error('[sourcebot] product correction parse failed:', e);
    await send(chatId, `⚠️ Couldn't parse that correction.`, env);
    return true;
  }

  if (Object.keys(updates).length === 0) {
    await send(chatId, `🤔 No field to update in that reply.`, env);
    return true;
  }

  const setParts: string[] = [];
  const binds: (string | null)[] = [];
  if ('name' in updates)        { setParts.push('name = ?');        binds.push(updates.name        || null); }
  if ('price' in updates)       { setParts.push('price = ?');       binds.push(updates.price       || null); }
  if ('moq' in updates)         { setParts.push('moq = ?');         binds.push(updates.moq         || null); }
  if ('lead_time' in updates)   { setParts.push('lead_time = ?');   binds.push(updates.lead_time   || null); }
  if ('description' in updates) { setParts.push('description = ?'); binds.push(updates.description || null); }
  if (setParts.length) {
    await env.DB.prepare(`UPDATE sb_products SET ${setParts.join(', ')} WHERE id = ?`).bind(...binds, p.id).run();
  }

  // Push to Products tab row
  if (p.sheet_row) {
    try {
      const sheet = await env.DB.prepare(`SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`).bind(buyer.buyerId, p.show_name).first<{ sheet_id: string }>();
      if (sheet?.sheet_id) {
        const tok = await getServiceAccountToken(env);
        const fresh = await env.DB.prepare(
          `SELECT name, description, price, moq, lead_time FROM sb_products WHERE id = ?`
        ).bind(p.id).first<{ name: string; description: string | null; price: string | null; moq: string | null; lead_time: string | null }>();
        if (fresh) {
          // Update C (name) and E:K (description, price, moq, lead time, tone, notes, last updated)
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.sheet_id}/values/Products!C${p.sheet_row}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [[fresh.name]] }),
          });
          await updateProductRow(sheet.sheet_id, p.sheet_row, {
            description: fresh.description ?? '',
            price:       fresh.price       ?? '',
            moq:         fresh.moq         ?? '',
            leadTime:    fresh.lead_time   ?? '',
            tone:        '',
            notes:       '',
          }, tok);
        }
      }
    } catch (e) { console.error('[sourcebot] product correction sheet update failed:', e); }
  }

  const updatedFields = Object.keys(updates).filter(k => updates[k]);
  await send(chatId, `✅ Updated *${p.name}*: ${updatedFields.join(', ')}.`, env, true);
  return true;
}

// ── Card back / person photo flows ──────────────────────────────────────────

async function handleCardBack(
  chatId: number,
  photos: TgPhotoSize[],
  session: SourceBotSession,
  buyer: { buyerId: string },
  env: Env,
): Promise<void> {
  if (!session.activeCompanyId) {
    await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, `Lost the supplier context. Rescan the front first.`, env);
    return;
  }

  const photo = photos.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a);

  // Download
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/getFile?file_id=${photo.file_id}`);
  const fileData = await fileRes.json() as { result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) { await send(chatId, `❌ Couldn't fetch the photo.`, env); return; }
  const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/${filePath}`);
  const rawBuffer = await imgRes.arrayBuffer();

  const company = await env.DB.prepare(
    `SELECT show_name, sheet_row, name FROM sb_companies WHERE id = ?`
  ).bind(session.activeCompanyId).first<{ show_name: string; sheet_row: number | null; name: string }>();
  if (!company) { await setSession(chatId, { step: 'idle' }, env); return; }

  // Upload to Cards/ subfolder
  let cardBackUrl: string | undefined;
  try {
    const folders = await getSupplierFoldersById(session.activeCompanyId, env, company.show_name, buyer);
    if (folders) {
      const tok = await getServiceAccountToken(env);
      cardBackUrl = await uploadCardImage(rawBuffer, `${company.name}_back`, '', folders.cards, tok);
    }
  } catch (e) { console.error('[sourcebot] card back upload failed:', e); }

  // Save to D1 (latest contact for this company)
  if (cardBackUrl) {
    await env.DB.prepare(
      `UPDATE sb_contacts SET card_back_url = ?
        WHERE id = (SELECT id FROM sb_contacts WHERE company_id = ? ORDER BY created_at DESC LIMIT 1)`
    ).bind(cardBackUrl, session.activeCompanyId).run();
  }

  // Sheet column O
  if (cardBackUrl && company.sheet_row) {
    try {
      const sheet = await env.DB.prepare(`SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`).bind(buyer.buyerId, company.show_name).first<{ sheet_id: string }>();
      if (sheet?.sheet_id) {
        const tok = await getServiceAccountToken(env);
        await updateSupplierCardBack(sheet.sheet_id, company.sheet_row, cardBackUrl, tok);
      }
    } catch (e) { console.error('[sourcebot] sheet card back update failed:', e); }
  }

  // Resume product-photo mode
  await setSession(chatId, { step: 'awaiting_product_photo', activeCompanyId: session.activeCompanyId }, env);
  await send(chatId, `✅ Card back saved.\n\n📦 Send product photos, or tap below.`, env);
}

async function handlePersonPhoto(
  chatId: number,
  photos: TgPhotoSize[],
  session: SourceBotSession,
  buyer: { buyerId: string },
  env: Env,
): Promise<void> {
  if (!session.activeCompanyId) {
    await setSession(chatId, { step: 'idle' }, env);
    await send(chatId, `Lost the supplier context. Rescan the front first.`, env);
    return;
  }

  const photo = photos.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a);

  // Download
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/getFile?file_id=${photo.file_id}`);
  const fileData = await fileRes.json() as { result?: { file_path?: string } };
  const filePath = fileData.result?.file_path;
  if (!filePath) { await send(chatId, `❌ Couldn't fetch the photo.`, env); return; }
  const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/${filePath}`);
  const rawBuffer = await imgRes.arrayBuffer();
  const base64 = arrayBufferToBase64(rawBuffer);

  const company = await env.DB.prepare(
    `SELECT show_name, sheet_row, name FROM sb_companies WHERE id = ?`
  ).bind(session.activeCompanyId).first<{ show_name: string; sheet_row: number | null; name: string }>();
  if (!company) { await setSession(chatId, { step: 'idle' }, env); return; }

  // Best-effort: ask Gemini for a one-liner description
  let personDescription = '';
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: 'Describe this person in ONE short line (e.g. "Tall man in blue suit, glasses, holding a sample"). Return only the description, no preface.' },
          { inline_data: { mime_type: filePath.endsWith('.png') ? 'image/png' : 'image/jpeg', data: base64 } },
        ] }],
      }),
    });
    const d = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    personDescription = (d.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim().split('\n')[0] ?? '';
  } catch (e) { console.error('[sourcebot] person description failed:', e); }

  // Upload to Cards/ subfolder
  let personUrl: string | undefined;
  try {
    const folders = await getSupplierFoldersById(session.activeCompanyId, env, company.show_name, buyer);
    if (folders) {
      const tok = await getServiceAccountToken(env);
      personUrl = await uploadCardImage(rawBuffer, `${company.name}_person`, '', folders.cards, tok);
    }
  } catch (e) { console.error('[sourcebot] person upload failed:', e); }

  if (personUrl) {
    await env.DB.prepare(
      `UPDATE sb_contacts SET person_photo_url = ?, person_description = ?
        WHERE id = (SELECT id FROM sb_contacts WHERE company_id = ? ORDER BY created_at DESC LIMIT 1)`
    ).bind(personUrl, personDescription || null, session.activeCompanyId).run();

    if (company.sheet_row) {
      try {
        const sheet = await env.DB.prepare(`SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`).bind(buyer.buyerId, company.show_name).first<{ sheet_id: string }>();
        if (sheet?.sheet_id) {
          const tok = await getServiceAccountToken(env);
          await updateSupplierPerson(sheet.sheet_id, company.sheet_row, { personPhotoUrl: personUrl, personDescription }, tok);
        }
      } catch (e) { console.error('[sourcebot] sheet person update failed:', e); }
    }
  }

  // Resume product-photo mode
  await setSession(chatId, { step: 'awaiting_product_photo', activeCompanyId: session.activeCompanyId }, env);
  await send(chatId,
    `✅ Person photo saved.` + (personDescription ? `\n_${personDescription}_` : '') +
    `\n\n📦 Send product photos, or tap below.`, env, true);
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

  // Upload product photo to the supplier's Products/ subfolder.
  let imageUrl: string | undefined;
  try {
    const folders = await getSupplierFoldersById(session.activeCompanyId, env, company.show_name, buyer);
    if (folders) {
      const token = await getServiceAccountToken(env);
      imageUrl = await uploadCardImage(rawBuffer, productName, '', folders.products, token);
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
  let messageId: number | null = null;
  try {
    ({ messageId } = await sendPhotoForceReply(chatId, photo.file_id, caption, env, true));
  } catch (e) {
    console.error('[sourcebot] sendPhotoForceReply failed, falling back to text:', e);
    await sendForceReply(chatId, caption, env, true);
  }
  if (messageId) {
    await env.DB.prepare(`UPDATE sb_products SET confirmation_message_id = ? WHERE id = ?`).bind(messageId, product.id).run();
  }

  await trackEvent(env, { buyerId: buyer.buyerId, eventName: 'product_captured', properties: { product: productName, show: company.show_name } });
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

interface SupplierFolders {
  parent:   string;  // The "{Company} — {Month YYYY}" folder
  cards:    string;  // Cards subfolder (front + back of business card, person photo)
  products: string;  // Products subfolder (every product photo)
}

// Get-or-create the per-supplier folder named "{Company} — {Month YYYY}" inside
// the buyer's show folder, plus its Cards/ and Products/ subfolders. Caches all
// three ids on sb_companies. Spec layout: …/{Company}/Cards/ and …/{Company}/Products/
async function getOrCreateSupplierFolders(
  companyId: string,
  companyName: string,
  showFolderId: string,
  env: Env,
): Promise<SupplierFolders> {
  const row = await env.DB.prepare(
    `SELECT cards_folder_id, cards_subfolder_id, products_subfolder_id FROM sb_companies WHERE id = ?`
  ).bind(companyId).first<{ cards_folder_id: string | null; cards_subfolder_id: string | null; products_subfolder_id: string | null }>();

  let parent   = row?.cards_folder_id   ?? '';
  let cards    = row?.cards_subfolder_id    ?? '';
  let products = row?.products_subfolder_id ?? '';

  const tok = await getServiceAccountToken(env);

  if (!parent) {
    const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const folder = await createDriveFolder(`${companyName} — ${month}`, showFolderId, tok);
    parent = folder.id;
  }
  if (!cards) {
    const f = await createDriveFolder('Cards', parent, tok);
    cards = f.id;
  }
  if (!products) {
    const f = await createDriveFolder('Products', parent, tok);
    products = f.id;
  }

  await env.DB.prepare(
    `UPDATE sb_companies SET cards_folder_id = ?, cards_subfolder_id = ?, products_subfolder_id = ? WHERE id = ?`
  ).bind(parent, cards, products, companyId).run();

  return { parent, cards, products };
}

// Resolves the supplier's folder set by company id (used by handleProductPhoto and
// the Card Back / Person Photo flows). Returns undefined if we can't resolve the
// buyer's show folder.
async function getSupplierFoldersById(
  companyId: string,
  env: Env,
  showName: string,
  buyer: { buyerId: string },
): Promise<SupplierFolders | undefined> {
  const c = await env.DB.prepare(
    `SELECT name, cards_folder_id, cards_subfolder_id, products_subfolder_id FROM sb_companies WHERE id = ?`
  ).bind(companyId).first<{ name: string; cards_folder_id: string | null; cards_subfolder_id: string | null; products_subfolder_id: string | null }>();
  if (!c?.name) return undefined;

  if (c.cards_folder_id && c.cards_subfolder_id && c.products_subfolder_id) {
    return { parent: c.cards_folder_id, cards: c.cards_subfolder_id, products: c.products_subfolder_id };
  }

  const pass = await env.DB.prepare(
    `SELECT drive_folder_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
  ).bind(buyer.buyerId, showName).first<{ drive_folder_id: string | null }>();
  if (!pass?.drive_folder_id) return undefined;

  return getOrCreateSupplierFolders(companyId, c.name, pass.drive_folder_id, env);
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
async function sendPhotoForceReply(chatId: number, photoFileId: string, caption: string, env: Env, markdown = false): Promise<{ messageId: number | null }> {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/sendPhoto`, {
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
  try {
    const d = await r.json() as { result?: { message_id?: number } };
    return { messageId: d.result?.message_id ?? null };
  } catch { return { messageId: null }; }
}

async function sendButtons(
  chatId: number,
  text: string,
  buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
  env: Env,
  markdown = false,
): Promise<{ messageId: number | null }> {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_SOURCE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: markdown ? 'Markdown' : undefined,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  try {
    const d = await r.json() as { result?: { message_id?: number } };
    return { messageId: d.result?.message_id ?? null };
  } catch { return { messageId: null }; }
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

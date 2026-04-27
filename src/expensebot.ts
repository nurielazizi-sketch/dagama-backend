/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import {
  extractExpense,
  formatMoney,
  toMinorUnits,
  type ExpenseContext,
  type SupportedCurrency,
} from './expensebot_core';

// ─────────────────────────────────────────────────────────────────────────────
// ExpenseBot — Telegram handler. v0.1 scope: text-only natural-language
// expense capture. Receipt OCR + FX conversion + /summary, /today, /list, /undo
// reports land in v0.2.
//
// Auth flow (self-serve, email-lookup):
//   /start            → ask for the email used at heydagama.com signup
//   <email-input>     → look up users.email; if found, bind chat_id → user_id;
//                       if not, prompt to register on web first
//
// Capture flow (post-auth):
//   <free-text>       → Gemini extracts {amount, currency, description, ...}
//                     → INSERT into expenses (channel='telegram', context per
//                       chat default or LLM hint)
//                     → reply with formatted confirmation
//
// Dedup: expenses.source_message_id is UNIQUE; we INSERT OR IGNORE with a key
// of 'telegram:<chat_id>:<message_id>' — Telegram retries are idempotent.
// ─────────────────────────────────────────────────────────────────────────────

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
}
interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id:      number;
  message?:       TgMessage;
  callback_query?: TgCallbackQuery;
}

// Controlled vocabulary for the category picker. Mirrors the prompt in
// expensebot_core. Order is the keyboard tab order.
const CATEGORIES = [
  'food', 'transport', 'lodging', 'supplies',
  'communication', 'entertainment', 'fees', 'other',
] as const;
type Category = typeof CATEGORIES[number];

function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s);
}

// ── Webhook entry ────────────────────────────────────────────────────────────

export async function handleExpenseBotWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

  if (!env.TELEGRAM_BOT_TOKEN_EXPENSE) {
    console.error('[expensebot] TELEGRAM_BOT_TOKEN_EXPENSE not set');
    return new Response('Bot not configured', { status: 503 });
  }

  let update: TgUpdate;
  try { update = await request.json() as TgUpdate; }
  catch { return new Response('Bad request', { status: 400 }); }

  if (update.message) {
    try { await handleMessage(update.message, env); }
    catch (e) { console.error('[expensebot] handleMessage failed:', e); }
  } else if (update.callback_query) {
    try { await handleCallback(update.callback_query, env); }
    catch (e) { console.error('[expensebot] handleCallback failed:', e); }
  }
  return new Response('OK', { status: 200 });
}

export async function handleExpenseBotSetupWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN_EXPENSE) return new Response('TELEGRAM_BOT_TOKEN_EXPENSE not set', { status: 503 });
  const url = `${new URL(request.url).origin}/api/expensebot/webhook`;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_EXPENSE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: env.WEBHOOK_SECRET, drop_pending_updates: true }),
  });
  return new Response(await r.text(), { status: r.status });
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

interface BoundUser {
  user_id:         string;
  default_context: ExpenseContext;
}

async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();
  const tgUsername = msg.from?.username ?? null;

  // /start — three modes:
  //   /start <token>  → dashboard "Connect ExpenseBot" deeplink: redeem the
  //                     short-lived token and bind chat_id↔user_id directly.
  //   /start (plain)  → email-lookup auth (the old self-serve path).
  //   /start (already-linked) → friendly reminder of usage.
  if (text === '/start' || text.startsWith('/start ')) {
    await env.DB.prepare(`DELETE FROM expensebot_pending_auth WHERE chat_id = ?`).bind(chatId).run();
    const arg = text.length > '/start '.length ? text.slice('/start '.length).trim() : '';
    if (arg) {
      const linked = await consumeLinkToken(arg, chatId, tgUsername, env);
      if (linked === 'ok')        { await send(chatId, `Linked to your DaGama account ✅\n\nDefault context: *expedition*. Flip with /context basecamp.\n\nNow just type an expense — e.g. "45 USD coffee at the booth".`, env, true); return; }
      if (linked === 'expired')   { await send(chatId, `That setup link has expired. Open the dashboard and tap *Connect ExpenseBot* again to get a fresh link.`, env, true); return; }
      if (linked === 'used')      { await send(chatId, `That setup link was already used. Open the dashboard and tap *Connect ExpenseBot* again for a fresh link.`, env, true); return; }
      // 'unknown' falls through to email-lookup as a graceful degrade.
    }
    const bound = await loadBoundUser(chatId, env);
    if (bound) {
      await send(chatId, `You're already linked.\n\nJust send me an expense like:\n• "45 USD coffee at the booth"\n• "1200 HKD hotel night 2"\n• "€8 metro ticket"\n\nUse /context to switch between expedition (work) and basecamp (personal).\n/help for the full list.`, env);
      return;
    }
    await env.DB.prepare(
      `INSERT INTO expensebot_pending_auth (chat_id, tg_username, created_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET tg_username = excluded.tg_username, created_at = excluded.created_at`
    ).bind(chatId, tgUsername).run();
    await send(chatId, `Welcome to ExpenseBot — DaGama's expense logger.\n\nI'll need to link this chat to your DaGama account. Reply with the email you used at heydagama.com.\n\n(Don't have an account yet? Register at heydagama.com first, then come back.)`, env);
    return;
  }

  if (text === '/help') {
    await send(chatId, helpText(), env);
    return;
  }

  // Pending email-lookup auth: any non-command text is treated as the email.
  const pending = await env.DB.prepare(
    `SELECT chat_id FROM expensebot_pending_auth WHERE chat_id = ?`
  ).bind(chatId).first<{ chat_id: number }>();
  if (pending && !text.startsWith('/')) {
    await handleEmailLookup(chatId, text, tgUsername, env);
    return;
  }

  // Beyond this point the user must be bound.
  const bound = await loadBoundUser(chatId, env);
  if (!bound) {
    await send(chatId, `I don't recognize this chat yet. Send /start to link it to your DaGama account.`, env);
    return;
  }

  // /context [expedition|basecamp] — read or set the chat's default context.
  if (text === '/context' || text.startsWith('/context ')) {
    await handleContextCommand(chatId, bound, text.slice('/context'.length).trim(), env);
    return;
  }

  // /reset — unlink this chat (admin-style escape hatch; user can re-/start).
  if (text === '/reset') {
    await env.DB.prepare(`DELETE FROM expensebot_users_telegram WHERE chat_id = ?`).bind(chatId).run();
    await env.DB.prepare(`DELETE FROM expensebot_pending_auth   WHERE chat_id = ?`).bind(chatId).run();
    await send(chatId, `Unlinked. Send /start to link this chat to a different account.`, env);
    return;
  }

  if (!text) {
    await send(chatId, `I only handle text messages right now. Receipt photos arrive in v0.2.`, env);
    return;
  }

  if (text.startsWith('/')) {
    await send(chatId, `Unknown command. Try /help.`, env);
    return;
  }

  // Free-text → expense extraction.
  await handleExpenseInput(chatId, msg.message_id, text, bound, env);
}

// ── Auth: email lookup ──────────────────────────────────────────────────────

async function handleEmailLookup(chatId: number, raw: string, tgUsername: string | null, env: Env): Promise<void> {
  const email = raw.trim().toLowerCase();
  if (!email.includes('@') || email.length < 5) {
    await send(chatId, `That doesn't look like an email. Reply with the address you used at heydagama.com.`, env);
    return;
  }
  const user = await env.DB.prepare(
    `SELECT id FROM users WHERE lower(email) = ? LIMIT 1`
  ).bind(email).first<{ id: string }>();
  if (!user) {
    await send(chatId, `No DaGama account found for ${email}.\n\nRegister at heydagama.com first, then send /start here again.`, env);
    return;
  }
  await env.DB.prepare(
    `INSERT INTO expensebot_users_telegram (chat_id, user_id, tg_username, default_context, created_at)
     VALUES (?, ?, ?, 'expedition', datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET
       user_id     = excluded.user_id,
       tg_username = excluded.tg_username,
       created_at  = excluded.created_at`
  ).bind(chatId, user.id, tgUsername).run();
  await env.DB.prepare(`DELETE FROM expensebot_pending_auth WHERE chat_id = ?`).bind(chatId).run();
  await send(chatId, `Linked to ${email}.\n\nDefault context: *expedition* (work / trade-show). Flip with /context basecamp.\n\nNow just send an expense — e.g. "45 USD coffee at the booth".`, env, true);
}

// ── /context ────────────────────────────────────────────────────────────────

async function handleContextCommand(chatId: number, bound: BoundUser, arg: string, env: Env): Promise<void> {
  const target = arg.toLowerCase();
  if (!target) {
    await send(chatId, `Current context: *${bound.default_context}*.\n\nFlip with:\n/context expedition  — work / trade-show expenses\n/context basecamp    — personal / household expenses`, env, true);
    return;
  }
  if (target !== 'expedition' && target !== 'basecamp') {
    await send(chatId, `Pick one: /context expedition  or  /context basecamp.`, env);
    return;
  }
  await env.DB.prepare(
    `UPDATE expensebot_users_telegram SET default_context = ? WHERE chat_id = ?`
  ).bind(target, chatId).run();
  await send(chatId, `Default context set to *${target}*. New expenses without an obvious hint will land here.`, env, true);
}

// ── Capture: free-text → expense ────────────────────────────────────────────

async function handleExpenseInput(
  chatId:    number,
  messageId: number,
  text:      string,
  bound:     BoundUser,
  env:       Env,
): Promise<void> {
  await sendChatAction(chatId, 'typing', env);

  const extracted = await extractExpense(text, {
    apiKey:         env.GEMINI_API_KEY,
    defaultContext: bound.default_context,
  });

  if (!extracted) {
    await send(chatId, `I couldn't read that as an expense. Try a format like "45 USD coffee at the booth" or "€12 metro".`, env);
    return;
  }

  const context: ExpenseContext = extracted.contextHint ?? bound.default_context;
  const amountCents = toMinorUnits(extracted.amount, extracted.currency);
  const sourceMessageId = `telegram:${chatId}:${messageId}`;
  // Normalize the LLM's free-form category to our controlled vocabulary so the
  // picker shows a consistent "current" highlight. Anything unknown → 'other'.
  const initialCategory: Category = extracted.category && isCategory(extracted.category)
    ? extracted.category
    : 'other';
  // Generate the row id at app level so we can reference it in callback_data
  // immediately. crypto.randomUUID is available in Workers; strip dashes to
  // match the schema's `lower(hex(randomblob(16)))` convention.
  const expenseId = crypto.randomUUID().replace(/-/g, '');

  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO expenses (
       id, user_id, channel, context, chat_id, source_message_id,
       category, description, amount_cents, currency,
       extraction_model, extraction_confidence, original_message
     ) VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    expenseId,
    bound.user_id,
    context,
    chatId,
    sourceMessageId,
    initialCategory,
    extracted.description,
    amountCents,
    extracted.currency,
    'gemini-2.0-flash',
    extracted.confidence,
    text,
  ).run();

  if ((insert.meta.changes ?? 0) === 0) {
    // Already inserted — TG retried the update. Stay silent rather than
    // double-confirming the user's expense.
    return;
  }

  const text_ = renderConfirmation({
    amountCents,
    currency:    extracted.currency,
    description: extracted.description || '(no description)',
    category:    initialCategory,
    context,
    confidence:  extracted.confidence,
  });
  await sendButtons(chatId, text_, categoryKeyboard(expenseId, initialCategory), env, true);
}

// ── Callback: category correction ───────────────────────────────────────────

async function handleCallback(cb: TgCallbackQuery, env: Env): Promise<void> {
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const data = cb.data ?? '';
  if (!chatId || !messageId) {
    await answerCallback(cb.id, env);
    return;
  }

  // Format: 'cat:<expense_id>:<new_category>'
  const m = /^cat:([a-f0-9]{32}):([a-z]+)$/.exec(data);
  if (!m) { await answerCallback(cb.id, env); return; }
  const [, expenseId, newCat] = m;
  if (!isCategory(newCat)) { await answerCallback(cb.id, env, 'Unknown category'); return; }

  const bound = await loadBoundUser(chatId, env);
  if (!bound) { await answerCallback(cb.id, env, 'Chat not linked'); return; }

  // Ownership check baked into the WHERE clause — refuses to update someone
  // else's row even if a stale callback id were forged.
  const existing = await env.DB.prepare(
    `SELECT id, amount_cents, currency, description, context, extraction_confidence
       FROM expenses
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(expenseId, bound.user_id).first<{
    id: string;
    amount_cents: number;
    currency: string;
    description: string | null;
    context: string;
    extraction_confidence: number | null;
  }>();
  if (!existing) { await answerCallback(cb.id, env, 'Expense not found'); return; }

  await env.DB.prepare(
    `UPDATE expenses SET category = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(newCat, expenseId).run();

  const text = renderConfirmation({
    amountCents: existing.amount_cents,
    currency:    existing.currency as SupportedCurrency,
    description: existing.description || '(no description)',
    category:    newCat,
    context:     existing.context === 'basecamp' ? 'basecamp' : 'expedition',
    confidence:  existing.extraction_confidence ?? 1,
  });
  await editMessageText(chatId, messageId, text, categoryKeyboard(expenseId, newCat), env);
  await answerCallback(cb.id, env, `Category → ${newCat}`);
}

// ── Confirmation rendering + keyboard ──────────────────────────────────────

interface ConfirmationParts {
  amountCents: number;
  currency:    SupportedCurrency;
  description: string;
  category:    Category;
  context:     ExpenseContext;
  confidence:  number;
}
function renderConfirmation(p: ConfirmationParts): string {
  const formatted = formatMoney(p.amountCents, p.currency);
  const ctxBadge  = p.context === 'expedition' ? '🧭 expedition' : '🏠 basecamp';
  const flag      = p.confidence < 0.7
    ? `\n\n_Low confidence (${p.confidence.toFixed(2)}). Reply /undo to remove if I got it wrong._`
    : '';
  return `Logged ${formatted} — ${p.description}\nCategory: *${p.category}*  (tap to change)\n${ctxBadge}${flag}`;
}

function categoryKeyboard(expenseId: string, current: Category): Array<Array<{ text: string; callback_data: string }>> {
  // Show all categories so the picker is consistent; mark the current with ✓.
  // 4 buttons per row → two rows.
  const buttons = CATEGORIES.map(c => ({
    text:          c === current ? `✓ ${c}` : c,
    callback_data: `cat:${expenseId}:${c}`,
  }));
  return [buttons.slice(0, 4), buttons.slice(4, 8)];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Redeem a dashboard "Connect ExpenseBot" link-token. Single-shot — sets
// used_at on success. Returns 'ok' on the bind, or a reason code so the
// caller can render a meaningful Telegram reply.
async function consumeLinkToken(
  token:      string,
  chatId:     number,
  tgUsername: string | null,
  env:        Env,
): Promise<'ok' | 'expired' | 'used' | 'unknown'> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at, used_at FROM expensebot_link_tokens WHERE token = ? LIMIT 1`
  ).bind(token).first<{ user_id: string; expires_at: number; used_at: number | null }>();
  if (!row) return 'unknown';
  if (row.used_at) return 'used';
  if (row.expires_at < now) return 'expired';

  await env.DB.prepare(
    `INSERT INTO expensebot_users_telegram (chat_id, user_id, tg_username, default_context, created_at)
     VALUES (?, ?, ?, 'expedition', datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET
       user_id     = excluded.user_id,
       tg_username = excluded.tg_username,
       created_at  = excluded.created_at`
  ).bind(chatId, row.user_id, tgUsername).run();

  await env.DB.prepare(
    `UPDATE expensebot_link_tokens SET used_at = ? WHERE token = ?`
  ).bind(now, token).run();

  return 'ok';
}

async function loadBoundUser(chatId: number, env: Env): Promise<BoundUser | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, default_context FROM expensebot_users_telegram WHERE chat_id = ? LIMIT 1`
  ).bind(chatId).first<{ user_id: string; default_context: string }>();
  if (!row) return null;
  const ctx: ExpenseContext = row.default_context === 'basecamp' ? 'basecamp' : 'expedition';
  return { user_id: row.user_id, default_context: ctx };
}

function helpText(): string {
  return [
    'ExpenseBot — log expenses by chat.',
    '',
    'Just type:',
    '  • "45 USD coffee at the booth"',
    '  • "1200 HKD hotel night 2"',
    '  • "€8 metro ticket"',
    '',
    'Commands:',
    '  /start    — link this chat to your DaGama account',
    '  /context  — switch between expedition (work) and basecamp (personal)',
    '  /reset    — unlink this chat',
    '  /help     — this message',
    '',
    'Coming next: receipt photos, /summary, /today, /list, /undo.',
  ].join('\n');
}

async function send(chatId: number, text: string, env: Env, markdown = false): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_EXPENSE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text,
      parse_mode: markdown ? 'Markdown' : undefined,
      disable_web_page_preview: true,
    }),
  });
}

async function sendButtons(
  chatId:  number,
  text:    string,
  buttons: Array<Array<{ text: string; callback_data: string }>>,
  env:     Env,
  markdown = false,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_EXPENSE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId, text,
      parse_mode: markdown ? 'Markdown' : undefined,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
}

async function editMessageText(
  chatId:    number,
  messageId: number,
  text:      string,
  buttons:   Array<Array<{ text: string; callback_data: string }>>,
  env:       Env,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_EXPENSE}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons },
    }),
  });
}

async function answerCallback(callbackQueryId: string, env: Env, text?: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_EXPENSE}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function sendChatAction(chatId: number, action: 'typing', env: Env): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN_EXPENSE}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

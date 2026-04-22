/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

// ── Telegram types ────────────────────────────────────────────────────────────

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// ── Conversation state (stored in D1 as JSON) ─────────────────────────────────
// We store pending lead data in a `sessions` approach using bot_users.session

type SessionStep = 'idle' | 'await_name' | 'await_company' | 'await_email' | 'await_notes' | 'await_show';

interface Session {
  step: SessionStep;
  lead: Partial<Lead>;
}

interface Lead {
  name: string;
  company: string;
  email: string;
  notes: string;
  show_name: string;
}

// ── Main webhook handler ──────────────────────────────────────────────────────

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  // Verify request comes from our registered webhook (secret token header)
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
  }

  return new Response('OK', { status: 200 });
}

async function handleMessage(msg: TgMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Ensure bot_user row exists
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bot_users (chat_id, username) VALUES (?, ?)`
  ).bind(chatId, msg.from?.username ?? null).run();

  const session = await getSession(chatId, env);

  // Global commands always take priority
  if (text === '/start') { await cmdStart(chatId, msg.from?.first_name ?? 'there', env); return; }
  if (text === '/help')  { await cmdHelp(chatId, env); return; }
  if (text === '/leads') { await cmdLeads(chatId, env); return; }
  if (text === '/cancel') { await setSession(chatId, { step: 'idle', lead: {} }, env); await send(chatId, '❌ Cancelled.', env); return; }

  // Start a new lead capture
  if (text === '/newlead') {
    await setSession(chatId, { step: 'await_show', lead: {} }, env);
    await send(chatId, '📋 *New Lead*\n\nWhat trade show or event is this lead from?\n\n_(Type the show name, e.g. "CES 2026")_', env, true);
    return;
  }

  // Conversational lead capture flow
  if (session.step !== 'idle') {
    await handleLeadFlow(chatId, text, session, env);
    return;
  }

  // Default
  await send(chatId, 'Use /newlead to capture a lead, or /help for all commands.', env);
}

async function handleLeadFlow(chatId: number, text: string, session: Session, env: Env): Promise<void> {
  const lead = session.lead;

  switch (session.step) {
    case 'await_show':
      lead.show_name = text;
      await setSession(chatId, { step: 'await_name', lead }, env);
      await send(chatId, `🏢 *${text}*\n\nWhat's the contact's full name?`, env, true);
      break;

    case 'await_name':
      lead.name = text;
      await setSession(chatId, { step: 'await_company', lead }, env);
      await send(chatId, `👤 Got it — *${text}*\n\nWhat company are they from?\n_(Type "skip" to leave blank)_`, env, true);
      break;

    case 'await_company':
      lead.company = text.toLowerCase() === 'skip' ? '' : text;
      await setSession(chatId, { step: 'await_email', lead }, env);
      await send(chatId, `What's their email address?\n_(Type "skip" to leave blank)_`, env);
      break;

    case 'await_email':
      lead.email = text.toLowerCase() === 'skip' ? '' : text;
      await setSession(chatId, { step: 'await_notes', lead }, env);
      await send(chatId, `Any notes about this lead?\n_(Type "skip" to leave blank)_`, env);
      break;

    case 'await_notes':
      lead.notes = text.toLowerCase() === 'skip' ? '' : text;
      await saveLead(chatId, lead as Lead, env);
      await setSession(chatId, { step: 'idle', lead: {} }, env);
      await send(chatId,
        `✅ *Lead saved!*\n\n` +
        `📛 *Name:* ${lead.name}\n` +
        `🏢 *Company:* ${lead.company || '—'}\n` +
        `📧 *Email:* ${lead.email || '—'}\n` +
        `🎪 *Show:* ${lead.show_name}\n` +
        `📝 *Notes:* ${lead.notes || '—'}\n\n` +
        `Use /newlead to add another, or /leads to see all.`,
        env, true
      );
      break;
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStart(chatId: number, firstName: string, env: Env): Promise<void> {
  await setSession(chatId, { step: 'idle', lead: {} }, env);
  await send(chatId,
    `👋 *Welcome to DaGama, ${firstName}!*\n\n` +
    `I help you capture and organize leads at trade shows.\n\n` +
    `*Commands:*\n` +
    `• /newlead — Capture a new lead\n` +
    `• /leads — View your recent leads\n` +
    `• /help — Show this help\n` +
    `• /cancel — Cancel current action`,
    env, true
  );
}

async function cmdHelp(chatId: number, env: Env): Promise<void> {
  await send(chatId,
    `*DaGama Bot Commands*\n\n` +
    `• /newlead — Start capturing a new lead\n` +
    `• /leads — See your last 10 leads\n` +
    `• /cancel — Cancel whatever you're doing\n` +
    `• /help — Show this message`,
    env, true
  );
}

async function cmdLeads(chatId: number, env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT name, company, email, show_name, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10`
  ).bind(chatId).all<{ name: string; company: string; email: string; show_name: string; created_at: string }>();

  if (!rows.results.length) {
    await send(chatId, 'No leads yet. Use /newlead to capture your first one!', env);
    return;
  }

  const lines = rows.results.map((l, i) =>
    `*${i + 1}. ${l.name}*${l.company ? ` — ${l.company}` : ''}\n` +
    `   🎪 ${l.show_name}${l.email ? `  📧 ${l.email}` : ''}`
  ).join('\n\n');

  await send(chatId, `📋 *Your recent leads:*\n\n${lines}`, env, true);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function saveLead(chatId: number, lead: Lead, env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO leads (chat_id, show_name, name, company, email, notes) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(chatId, lead.show_name, lead.name, lead.company || null, lead.email || null, lead.notes || null).run();
}

async function getSession(chatId: number, env: Env): Promise<Session> {
  const row = await env.DB.prepare(
    `SELECT session FROM bot_users WHERE chat_id = ?`
  ).bind(chatId).first<{ session: string | null }>();
  try {
    return row?.session ? JSON.parse(row.session) : { step: 'idle', lead: {} };
  } catch {
    return { step: 'idle', lead: {} };
  }
}

async function setSession(chatId: number, session: Session, env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE bot_users SET session = ? WHERE chat_id = ?`
  ).bind(JSON.stringify(session), chatId).run();
}

// ── Telegram API ──────────────────────────────────────────────────────────────

async function send(chatId: number, text: string, env: Env, markdown = false): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: markdown ? 'Markdown' : undefined,
    }),
  });
}

// ── Webhook registration ──────────────────────────────────────────────────────

export async function handleSetupWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { url?: string };
  try { body = await request.json() as typeof body; } catch { return new Response('Bad request', { status: 400 }); }

  if (!body.url) return new Response(JSON.stringify({ error: 'url is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const webhookUrl = `${body.url}/api/telegram/webhook`;

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message'],
    }),
  });

  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}

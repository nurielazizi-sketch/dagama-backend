/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { ask, buildSummaryPrompt, buildFollowUpPrompt } from './gemini';
import { getOrCreateSheet, appendLeadRow } from './sheets';

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
  if (text === '/start')   { await cmdStart(chatId, msg.from?.first_name ?? 'there', env); return; }
  if (text === '/help')    { await cmdHelp(chatId, env); return; }
  if (text === '/leads')   { await cmdLeads(chatId, env); return; }
  if (text === '/summary') { await cmdSummary(chatId, env); return; }
  if (text === '/cancel')  { await setSession(chatId, { step: 'idle', lead: {} }, env); await send(chatId, '❌ Cancelled.', env); return; }
  if (text === '/sheet')   { await cmdSheet(chatId, env); return; }
  if (text.startsWith('/followup')) { await cmdFollowup(chatId, text, env); return; }

  // Start a new lead capture
  if (text === '/newlead') {
    const hasAccess = await checkSubscription(chatId, env);
    if (!hasAccess) {
      await send(chatId,
        '🔒 *No active plan*\n\nYou need a DaGama plan to capture leads.\n\nVisit heydagama.com to get started — plans start at $49.',
        env, true
      );
      return;
    }
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
        `Use /newlead to add another, /leads to see all, or /followup 1 to draft a follow-up email with AI.`,
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
    `• /sheet — Get your Google Sheet link\n` +
    `• /summary — AI analysis of your leads\n` +
    `• /followup 1 — Draft a follow-up email for lead #1\n` +
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
    `• /sheet — Get your Google Sheet link\n` +
    `• /summary — AI analysis of all your leads\n` +
    `• /followup 1 — AI follow-up email for lead #1\n` +
    `• /cancel — Cancel whatever you're doing\n` +
    `• /help — Show this message`,
    env, true
  );
}

async function cmdSummary(chatId: number, env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT name, company, email, notes, show_name, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(chatId).all<{ name: string; company: string; email: string; notes: string; show_name: string; created_at: string }>();

  if (!rows.results.length) {
    await send(chatId, 'No leads yet. Use /newlead to capture your first one!', env);
    return;
  }

  if (!env.GEMINI_API_KEY || env.GEMINI_API_KEY.startsWith('your_')) {
    await send(chatId, '⚠️ Gemini API key not configured. Add GEMINI_API_KEY to your environment.', env);
    return;
  }

  await send(chatId, '🤖 Analyzing your leads…', env);

  // Group by most recent show
  const showName = rows.results[0].show_name;
  const showLeads = rows.results.filter(l => l.show_name === showName);

  try {
    const prompt = buildSummaryPrompt(showName, showLeads);
    const analysis = await ask(prompt, env.GEMINI_API_KEY);
    await send(chatId, `📊 *AI Analysis — ${showName}*\n\n${analysis}`, env, true);
  } catch (e) {
    await send(chatId, '❌ AI analysis failed. Please try again later.', env);
  }
}

async function cmdFollowup(chatId: number, text: string, env: Env): Promise<void> {
  const parts = text.split(/\s+/);
  const n = parseInt(parts[1] ?? '1', 10);

  if (isNaN(n) || n < 1) {
    await send(chatId, 'Usage: /followup 1  (use the lead number from /leads)', env);
    return;
  }

  const rows = await env.DB.prepare(
    `SELECT name, company, email, notes, show_name, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10`
  ).bind(chatId).all<{ name: string; company: string; email: string; notes: string; show_name: string; created_at: string }>();

  const lead = rows.results[n - 1];
  if (!lead) {
    await send(chatId, `No lead #${n} found. Use /leads to see your leads.`, env);
    return;
  }

  if (!env.GEMINI_API_KEY || env.GEMINI_API_KEY.startsWith('your_')) {
    await send(chatId, '⚠️ Gemini API key not configured. Add GEMINI_API_KEY to your environment.', env);
    return;
  }

  await send(chatId, `✍️ Drafting follow-up email for *${lead.name}*…`, env, true);

  try {
    const prompt = buildFollowUpPrompt(lead, lead.show_name);
    const email = await ask(prompt, env.GEMINI_API_KEY);
    await send(chatId, `📧 *Follow-up for ${lead.name}:*\n\n${email}`, env, true);
  } catch (e) {
    await send(chatId, '❌ Failed to generate email. Please try again later.', env);
  }
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

async function cmdSheet(chatId: number, env: Env): Promise<void> {
  const botUser = await env.DB.prepare(
    `SELECT user_id FROM bot_users WHERE chat_id = ?`
  ).bind(chatId).first<{ user_id: string | null }>();

  if (!botUser?.user_id) {
    await send(chatId, '⚠️ Your Telegram is not linked to a DaGama account yet. Visit heydagama.com to sign up.', env);
    return;
  }

  const sheets = await env.DB.prepare(
    `SELECT show_name, sheet_url FROM google_sheets WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`
  ).bind(botUser.user_id).all<{ show_name: string; sheet_url: string }>();

  if (!sheets.results.length) {
    await send(chatId, '📊 No sheets yet. Use /newlead to capture your first lead — a Google Sheet will be created automatically.', env);
    return;
  }

  const lines = sheets.results.map(s => `📊 *${s.show_name}*\n${s.sheet_url}`).join('\n\n');
  await send(chatId, `*Your Google Sheets:*\n\n${lines}`, env, true);
}

// ── Subscription gate ─────────────────────────────────────────────────────────

async function checkSubscription(chatId: number, env: Env): Promise<boolean> {
  const botUser = await env.DB.prepare(
    `SELECT user_id FROM bot_users WHERE chat_id = ?`
  ).bind(chatId).first<{ user_id: string | null }>();

  if (!botUser?.user_id) return false;

  const sub = await env.DB.prepare(
    `SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1`
  ).bind(botUser.user_id).first();

  return !!sub;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function saveLead(chatId: number, lead: Lead, env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO leads (chat_id, show_name, name, company, email, notes) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(chatId, lead.show_name, lead.name, lead.company || null, lead.email || null, lead.notes || null).run();

  // Append to Google Sheet (best-effort — don't fail lead capture if Sheets is down)
  try {
    const botUser = await env.DB.prepare(
      `SELECT user_id FROM bot_users WHERE chat_id = ?`
    ).bind(chatId).first<{ user_id: string | null }>();

    if (botUser?.user_id) {
      const user = await env.DB.prepare(
        `SELECT email FROM users WHERE id = ?`
      ).bind(botUser.user_id).first<{ email: string }>();

      if (user?.email && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
        const { sheetId } = await getOrCreateSheet(botUser.user_id, user.email, lead.show_name, env);
        await appendLeadRow(sheetId, {
          timestamp: new Date().toISOString(),
          company: lead.company || '',
          name: lead.name,
          email: lead.email || '',
          notes: lead.notes || '',
        }, env);
      }
    }
  } catch {
    // Silent failure — lead is already saved in D1
  }
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

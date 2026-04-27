/// <reference types="@cloudflare/workers-types" />

// Dashboard-facing ExpenseBot endpoints. Both Bearer-JWT-authed.
//
//   POST /api/expensebot/link-token     → mint a one-shot deeplink token
//   GET  /api/me/expensebot-status      → "is this user already connected?"
//
// The deeplink-token path lets a logged-in dashboard user tap "Connect
// ExpenseBot" and land in Telegram already linked, skipping the bot's
// email-lookup auth.

import type { Env } from './types';
import { requireAuth } from './auth';

const LINK_TOKEN_TTL_SEC    = 30 * 60;       // 30 minutes
const EXPENSEBOT_USERNAME   = 'DaGaMaExpenseBot';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleExpenseBotLinkToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const token = crypto.randomUUID().replace(/-/g, '');
  const now   = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO expensebot_link_tokens (token, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(token, auth.userId, now, now + LINK_TOKEN_TTL_SEC).run();

  const deeplink = `https://t.me/${EXPENSEBOT_USERNAME}?start=${token}`;
  return jsonResponse({ deeplink, expires_in: LINK_TOKEN_TTL_SEC });
}

export async function handleExpenseBotStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(
    `SELECT chat_id, default_context, created_at
       FROM expensebot_users_telegram
      WHERE user_id = ?
      LIMIT 1`
  ).bind(auth.userId).first<{ chat_id: number; default_context: string; created_at: string }>();

  if (!row) return jsonResponse({ connected: false });
  return jsonResponse({
    connected:        true,
    default_context:  row.default_context,
    connected_at:     row.created_at,
  });
}

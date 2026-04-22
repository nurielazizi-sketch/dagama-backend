/// <reference types="@cloudflare/workers-types" />

import { hashPassword, verifyPassword, signJwt, verifyJwt } from './crypto';
import { ask, buildSummaryPrompt } from './gemini';
import type { Env } from './types';

interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

const JWT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { email?: string; password?: string; name?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { email, password, name } = body;
  if (!email || !password || !name) {
    return jsonResponse({ error: 'email, password, and name are required' }, 400);
  }
  if (password.length < 8) {
    return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return jsonResponse({ error: 'Email already registered' }, 409);

  const password_hash = await hashPassword(password);
  const result = await env.DB
    .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id, email, name, created_at')
    .bind(email, name, password_hash)
    .first<Pick<User, 'id' | 'email' | 'name' | 'created_at'>>();

  if (!result) return jsonResponse({ error: 'Failed to create user' }, 500);

  const token = await signJwt(
    { sub: result.id, email: result.email, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
    env.WEBHOOK_SECRET
  );

  return jsonResponse({ token, user: { id: result.id, email: result.email, name: result.name } }, 201);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body: { email?: string; password?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { email, password } = body;
  if (!email || !password) return jsonResponse({ error: 'email and password are required' }, 400);

  const user = await env.DB
    .prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<User>();

  if (!user) return jsonResponse({ error: 'Invalid credentials' }, 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return jsonResponse({ error: 'Invalid credentials' }, 401);

  const token = await signJwt(
    { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
    env.WEBHOOK_SECRET
  );

  return jsonResponse({ token, user: { id: user.id, email: user.email, name: user.name } });
}

export async function handleInsights(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  if (!env.GEMINI_API_KEY || env.GEMINI_API_KEY.startsWith('your_')) {
    return jsonResponse({ error: 'Gemini API key not configured' }, 503);
  }

  const bot = await env.DB.prepare(
    `SELECT chat_id FROM bot_users WHERE user_id = ?`
  ).bind(auth.userId).first<{ chat_id: number }>();

  if (!bot) return jsonResponse({ error: 'No Telegram bot connected' }, 404);

  const rows = await env.DB.prepare(
    `SELECT name, company, email, notes, show_name, created_at FROM leads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(bot.chat_id).all<{ name: string; company: string | null; email: string | null; notes: string | null; show_name: string; created_at: string }>();

  if (!rows.results.length) return jsonResponse({ error: 'No leads to analyze' }, 404);

  const showName = rows.results[0].show_name;
  const showLeads = rows.results.filter(l => l.show_name === showName);

  try {
    const analysis = await ask(buildSummaryPrompt(showName, showLeads), env.GEMINI_API_KEY);
    return jsonResponse({ show: showName, lead_count: showLeads.length, analysis });
  } catch (e) {
    return jsonResponse({ error: 'AI analysis failed' }, 502);
  }
}

export async function handleStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const bot = await env.DB.prepare(
    `SELECT chat_id FROM bot_users WHERE user_id = ?`
  ).bind(auth.userId).first<{ chat_id: number }>();

  let leadCount = 0;
  if (bot) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM leads WHERE chat_id = ?`
    ).bind(bot.chat_id).first<{ count: number }>();
    leadCount = row?.count ?? 0;
  }

  return jsonResponse({ leads: leadCount, bot_connected: !!bot });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const user = await env.DB
    .prepare('SELECT id, email, name, created_at FROM users WHERE id = ?')
    .bind(auth.userId)
    .first<Pick<User, 'id' | 'email' | 'name' | 'created_at'>>();

  if (!user) return jsonResponse({ error: 'User not found' }, 404);
  return jsonResponse({ user });
}

export async function requireAuth(request: Request, env: Env): Promise<{ userId: string; email: string } | Response> {
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return jsonResponse({ error: 'Missing authorization header' }, 401);

  const payload = await verifyJwt(token, env.WEBHOOK_SECRET);
  if (!payload) return jsonResponse({ error: 'Invalid or expired token' }, 401);

  return { userId: payload.sub as string, email: payload.email as string };
}

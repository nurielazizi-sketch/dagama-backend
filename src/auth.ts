/// <reference types="@cloudflare/workers-types" />

import { hashPassword, verifyPassword, signJwt, verifyJwt } from './crypto';

interface Env {
  DB: D1Database;
  WEBHOOK_SECRET: string;
}

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

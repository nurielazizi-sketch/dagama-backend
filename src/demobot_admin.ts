/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { trackEvent } from './funnel';

// ─────────────────────────────────────────────────────────────────────────────
// DemoBot admin endpoints
//
//   POST /api/demobot/admin/freelancer-token     — issue Telegram onboarding token
//   POST /api/demobot/admin/conversion           — mark a prospect as converted
//                                                  (triggers freelancer comp + referrer reward)
//   GET  /api/shows-catalog                       — public list of upcoming shows
//   POST /api/shows-catalog                       — admin create
//   PUT  /api/shows-catalog/:id                   — admin update
//   DELETE /api/shows-catalog/:id                 — admin remove
//
// Auth: anything that mutates requires Bearer DEMOBOT_ADMIN_TOKEN. The
// catalog GET is unauthenticated (used by the website show calendar later).
// ─────────────────────────────────────────────────────────────────────────────

function requireAdmin(request: Request, env: Env): boolean {
  if (!env.DEMOBOT_ADMIN_TOKEN) return false;            // unset in dev = locked
  const auth = request.headers.get('Authorization') ?? '';
  const expected = `Bearer ${env.DEMOBOT_ADMIN_TOKEN}`;
  return auth === expected;
}

// ── Freelancer onboarding ─────────────────────────────────────────────────────

export async function handleIssueFreelancerToken(request: Request, env: Env): Promise<Response> {
  if (!requireAdmin(request, env)) return json({ error: 'unauthorized' }, 401);

  let body: { user_id?: string; ttl_seconds?: number };
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body.user_id) return json({ error: 'user_id required' }, 400);

  const u = await env.DB.prepare(`SELECT id, role FROM users WHERE id = ?`).bind(body.user_id).first<{ id: string; role: string }>();
  if (!u) return json({ error: 'user not found' }, 404);
  if (u.role !== 'freelancer') {
    // Auto-promote to freelancer rather than failing — admin already authorized this.
    await env.DB.prepare(`UPDATE users SET role = 'freelancer' WHERE id = ?`).bind(u.id).run();
  }

  const token = crypto.randomUUID();
  const ttl = body.ttl_seconds ?? 24 * 3600;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  await env.DB.prepare(
    `INSERT INTO onboarding_tokens (token, user_id, bot_role, expires_at) VALUES (?, ?, 'demobot', ?)`
  ).bind(token, u.id, expires).run();

  const username = env.TELEGRAM_BOT_USERNAME_DEMO ?? 'DaGaMaDemoBot';
  return json({
    token,
    expires_at: expires,
    deep_link: `https://t.me/${username}?start=${token}`,
  });
}

// ── Conversion attribution ────────────────────────────────────────────────────

export async function handleMarkConversion(request: Request, env: Env): Promise<Response> {
  if (!requireAdmin(request, env)) return json({ error: 'unauthorized' }, 401);

  let body: { prospect_id?: string; buyer_id?: string };
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body.prospect_id || !body.buyer_id) return json({ error: 'prospect_id + buyer_id required' }, 400);

  const p = await env.DB.prepare(
    `SELECT id, freelancer_user_id, scanned_at, referrer_buyer_id FROM demobot_prospects WHERE id = ?`
  ).bind(body.prospect_id).first<{ id: string; freelancer_user_id: string; scanned_at: number; referrer_buyer_id: string | null }>();
  if (!p) return json({ error: 'prospect not found' }, 404);

  const now = Math.floor(Date.now() / 1000);
  const within30d = (now - p.scanned_at) <= 30 * 24 * 3600;

  await env.DB.prepare(
    `UPDATE demobot_prospects SET conversion_buyer_id = ?, converted_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(body.buyer_id, now, p.id).run();

  // Bump the freelancer's per-day rollup for the day they did the demo (not today)
  const demoDay = new Date(p.scanned_at * 1000).toISOString().slice(0, 10);
  if (within30d) {
    await env.DB.prepare(
      `UPDATE demobot_freelancer_demos SET conversions_count = conversions_count + 1, updated_at = datetime('now')
        WHERE freelancer_user_id = ? AND day_local = ?`
    ).bind(p.freelancer_user_id, demoDay).run();
  }

  await trackEvent(env, {
    buyerId: body.buyer_id,
    eventName: 'demobot_conversion',
    properties: { prospect_id: p.id, freelancer_user_id: p.freelancer_user_id, within_30d: within30d, referrer_buyer_id: p.referrer_buyer_id },
  });

  // If the prospect had a referrer, mark the referral as paid so the
  // referrer-side reward logic (in stripe webhook flow) can pay it out.
  if (p.referrer_buyer_id) {
    await env.DB.prepare(
      `UPDATE referrals SET status = 'paid' WHERE referrer_buyer_id = ? AND referred_buyer_id = ?`
    ).bind(p.referrer_buyer_id, body.buyer_id).run().catch(() => undefined);
  }

  return json({ ok: true, within_30d: within30d });
}

// ── shows_catalog CRUD ────────────────────────────────────────────────────────

export async function handleListShows(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, show_name, show_location, start_date, end_date, show_length, industry_focus, website
       FROM shows_catalog ORDER BY start_date DESC`
  ).all();
  return json({ shows: rows.results });
}

export async function handleCreateShow(request: Request, env: Env): Promise<Response> {
  if (!requireAdmin(request, env)) return json({ error: 'unauthorized' }, 401);

  let body: { show_name?: string; show_location?: string; start_date?: string; end_date?: string; industry_focus?: string; website?: string; notes?: string };
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body.show_name || !body.start_date || !body.end_date) {
    return json({ error: 'show_name, start_date, end_date required' }, 400);
  }
  const id = crypto.randomUUID().replace(/-/g, '');
  const length = inferShowLength(body.start_date, body.end_date);

  await env.DB.prepare(
    `INSERT INTO shows_catalog (id, show_name, show_location, start_date, end_date, show_length, industry_focus, website, notes)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, body.show_name, body.show_location ?? null, body.start_date, body.end_date,
         length, body.industry_focus ?? null, body.website ?? null, body.notes ?? null).run();

  return json({ ok: true, id });
}

export async function handleUpdateShow(request: Request, env: Env, id: string): Promise<Response> {
  if (!requireAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

  const allowed = ['show_name', 'show_location', 'start_date', 'end_date', 'industry_focus', 'website', 'notes'] as const;
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      args.push(body[k] ?? null);
    }
  }
  if (sets.length === 0) return json({ error: 'no fields to update' }, 400);

  // Recompute show_length if either date changed.
  if ('start_date' in body || 'end_date' in body) {
    const cur = await env.DB.prepare(`SELECT start_date, end_date FROM shows_catalog WHERE id = ?`).bind(id).first<{ start_date: string; end_date: string }>();
    if (cur) {
      const start = (body.start_date as string | undefined) ?? cur.start_date;
      const end   = (body.end_date as string | undefined)   ?? cur.end_date;
      sets.push(`show_length = ?`);
      args.push(inferShowLength(start, end));
    }
  }
  sets.push(`updated_at = datetime('now')`);
  args.push(id);

  await env.DB.prepare(`UPDATE shows_catalog SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  return json({ ok: true });
}

export async function handleDeleteShow(request: Request, env: Env, id: string): Promise<Response> {
  if (!requireAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  await env.DB.prepare(`DELETE FROM shows_catalog WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function inferShowLength(start: string, end: string): number | null {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  const days = Math.round((e - s) / (24 * 3600 * 1000)) + 1;
  return days > 0 ? days : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

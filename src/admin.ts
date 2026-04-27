/// <reference types="@cloudflare/workers-types" />

// Admin console — `/admin` page + /api/admin/* JSON endpoints.
// Gating: requireAdminUser() = existing user JWT + email on ADMIN_EMAILS list.
// Phase 1 is read-mostly: inventory + integration probes + edit runtime config.
// Secret rotation is deferred to phase 2 (see plan).

import type { Env } from './types';
import { requireAuth } from './auth';
import {
  INTEGRATIONS_MANIFEST,
  INTEGRATION_CARDS,
  ROUTES_MANIFEST,
  ROUTE_CATEGORY_LABELS,
  isSecretPresent,
  type IntegrationCategory,
  type ProbeId,
  type SecretManifestEntry,
} from './admin_manifest';
import { listConfig, setConfig, type ConfigRow } from './app_config';
import { getServiceAccountToken } from './google';
import { isCfAccessConfigured, verifyAccessJwt } from './cloudflare_access';

// ─────────────────────────────────────────────────────────────────────────────
// Auth

interface AdminCtx { userId: string; email: string; via: 'cf_access' | 'user_jwt' }

export async function requireAdminUser(request: Request, env: Env): Promise<AdminCtx | Response> {
  let email: string;
  let userId: string;
  let via: AdminCtx['via'];

  // Preferred path: Cloudflare Access JWT (edge-enforced + Worker-verified).
  // Configured = both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD_TAG are set.
  if (isCfAccessConfigured(env)) {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!jwt) return json({ error: 'cloudflare access required' }, 401);
    const id = await verifyAccessJwt(jwt, env);
    if (!id) return json({ error: 'invalid cloudflare access token' }, 401);
    email = id.email;
    userId = id.sub;
    via = 'cf_access';
  } else {
    // Fallback: user JWT (current /dashboard auth). Used pre-CF-Access setup.
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;
    email = auth.email;
    userId = auth.userId;
    via = 'user_jwt';
  }

  const allowlist = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) {
    return json({ error: 'admin disabled (ADMIN_EMAILS unset)' }, 403);
  }
  if (!allowlist.includes(email.toLowerCase())) {
    return json({ error: 'forbidden' }, 403);
  }
  return { userId, email, via };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// /admin HTML page

export function handleAdminPage(): Response {
  return new Response(ADMIN_PAGE, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/whoami — minimal auth diagnostic (curl-friendly)

export async function handleAdminWhoami(request: Request, env: Env): Promise<Response> {
  const ctx = await requireAdminUser(request, env);
  if (ctx instanceof Response) return ctx;
  return json({
    ok: true,
    email: ctx.email,
    via: ctx.via,
    cf_access_configured: !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD_TAG),
    admin_emails_count: (env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim()).filter(Boolean).length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/inventory — aggregate read

interface InventorySecret {
  name: string;
  category: IntegrationCategory;
  optional: boolean;
  description: string;
  present: boolean;
  binding: boolean;
  probe?: ProbeId;
}

interface InventoryCategory {
  category: IntegrationCategory;
  label: string;
  probe?: ProbeId;
  external_link?: string;
  set: number;
  total: number;
  missing_required: string[];
  secrets: InventorySecret[];
}

interface InventoryResponse {
  integrations: InventoryCategory[];
  config: ConfigRow[];
  routes: { category: string; label: string; routes: typeof ROUTES_MANIFEST }[];
  admin: { email: string; via: 'cf_access' | 'user_jwt' };
}

export async function handleAdminInventory(request: Request, env: Env): Promise<Response> {
  const ctx = await requireAdminUser(request, env);
  if (ctx instanceof Response) return ctx;

  const secrets: InventorySecret[] = INTEGRATIONS_MANIFEST.map((s: SecretManifestEntry) => ({
    name: String(s.name),
    category: s.category,
    optional: s.optional,
    description: s.description,
    present: isSecretPresent(env, s),
    binding: !!s.binding,
    probe: s.probe,
  }));

  const integrations: InventoryCategory[] = INTEGRATION_CARDS.map(card => {
    const grouped = secrets.filter(x => x.category === card.category);
    const set = grouped.filter(x => x.present).length;
    const total = grouped.length;
    const missing_required = grouped.filter(x => !x.present && !x.optional).map(x => x.name);
    return {
      category: card.category,
      label: card.label,
      probe: card.probe,
      external_link: card.external_link,
      set,
      total,
      missing_required,
      secrets: grouped,
    };
  });

  const config = await listConfig(env);

  const routesByCat = new Map<string, typeof ROUTES_MANIFEST>();
  for (const r of ROUTES_MANIFEST) {
    if (!routesByCat.has(r.category)) routesByCat.set(r.category, []);
    routesByCat.get(r.category)!.push(r);
  }
  const routes = Array.from(routesByCat.entries()).map(([category, rs]) => ({
    category,
    label: ROUTE_CATEGORY_LABELS[category as keyof typeof ROUTE_CATEGORY_LABELS] ?? category,
    routes: rs,
  }));

  const body: InventoryResponse = {
    integrations,
    config,
    routes,
    admin: { email: ctx.email, via: ctx.via },
  };
  return json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/config — list + update

export async function handleAdminConfigList(request: Request, env: Env): Promise<Response> {
  const ctx = await requireAdminUser(request, env);
  if (ctx instanceof Response) return ctx;
  const rows = await listConfig(env);
  return json({ config: rows });
}

export async function handleAdminConfigUpdate(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method !== 'PATCH') return json({ error: 'method not allowed' }, 405);
  const ctx = await requireAdminUser(request, env);
  if (ctx instanceof Response) return ctx;

  let body: { value?: unknown };
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (typeof body.value !== 'string') {
    return json({ error: "body.value must be a string (encode booleans as 'true'/'false', numbers as decimal strings)" }, 400);
  }

  const result = await setConfig(env, key, body.value, ctx.email);
  if (!result.ok) return json({ error: result.error ?? 'update failed' }, 400);
  return json({ ok: true, row: result.row });
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/probe/:integration

interface ProbeResult {
  ok: boolean;
  integration: ProbeId;
  latency_ms: number;
  detail?: unknown;
  error?: string;
  cached?: boolean;
}

interface ProbeCacheEntry { result: ProbeResult; expires: number }
const probeCache = new Map<ProbeId, ProbeCacheEntry>();
const PROBE_TTL_MS = 60_000;

export async function handleAdminProbe(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const ctx = await requireAdminUser(request, env);
  if (ctx instanceof Response) return ctx;

  const probeId = id as ProbeId;
  const cached = probeCache.get(probeId);
  const now = Date.now();
  if (cached && cached.expires > now) {
    return json({ ...cached.result, cached: true });
  }

  const start = now;
  let result: ProbeResult;
  try {
    result = await runProbe(probeId, env, start);
  } catch (e) {
    result = {
      ok: false,
      integration: probeId,
      latency_ms: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  probeCache.set(probeId, { result, expires: Date.now() + PROBE_TTL_MS });
  return json({ ...result, cached: false });
}

async function runProbe(id: ProbeId, env: Env, start: number): Promise<ProbeResult> {
  switch (id) {
    case 'gemini':       return await probeGemini(env, start);
    case 'gcv':          return await probeGcv(env, start);
    case 'google_sa':    return await probeGoogleSa(env, start);
    case 'gmail_oauth':  return await probeGmailOauth(env, start);
    case 'whatsapp':     return await probeWhatsApp(env, start);
    case 'telegram':     return await probeTelegram(env, start);
    case 'stripe':       return await probeStripe(env, start);
    case 'resend':       return await probeResend(env, start);
    case 'd1':           return await probeD1(env, start);
    case 'r2':           return await probeR2(env, start);
    default:
      return { ok: false, integration: id, latency_ms: 0, error: `unknown probe '${id}'` };
  }
}

function done(integration: ProbeId, start: number, ok: boolean, detail?: unknown, error?: string): ProbeResult {
  return { ok, integration, latency_ms: Date.now() - start, detail, error };
}

async function probeGemini(env: Env, start: number): Promise<ProbeResult> {
  if (!env.GEMINI_API_KEY) return done('gemini', start, false, undefined, 'GEMINI_API_KEY unset');
  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1, temperature: 0 },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return done('gemini', start, false, undefined, `${res.status} ${text.slice(0, 200)}`);
  }
  return done('gemini', start, true, { model });
}

async function probeGcv(env: Env, start: number): Promise<ProbeResult> {
  if (!env.GCV_API_KEY) return done('gcv', start, false, undefined, 'GCV_API_KEY unset');
  // 1x1 transparent PNG
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${env.GCV_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ image: { content: tinyPng }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return done('gcv', start, false, undefined, `${res.status} ${text.slice(0, 200)}`);
  }
  return done('gcv', start, true);
}

async function probeGoogleSa(env: Env, start: number): Promise<ProbeResult> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return done('google_sa', start, false, undefined, 'service account secrets unset');
  }
  const token = await getServiceAccountToken(env);
  if (!token) return done('google_sa', start, false, undefined, 'token mint failed');
  return done('google_sa', start, true, { service_account: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, token_prefix: token.slice(0, 8) + '…' });
}

async function probeGmailOauth(env: Env, start: number): Promise<ProbeResult> {
  // No outbound call — just count valid token rows.
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM gmail_tokens WHERE refresh_token IS NOT NULL AND refresh_token != ''`
    ).first<{ n: number }>();
    const n = row?.n ?? 0;
    return done('gmail_oauth', start, true, { connected_users: n });
  } catch (e) {
    return done('gmail_oauth', start, false, undefined, e instanceof Error ? e.message : String(e));
  }
}

async function probeWhatsApp(env: Env, start: number): Promise<ProbeResult> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return done('whatsapp', start, false, undefined, 'access token or phone_number_id unset');
  }
  const v = env.WHATSAPP_GRAPH_VERSION ?? 'v21.0';
  const url = `https://graph.facebook.com/${v}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return done('whatsapp', start, false, undefined, `${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return done('whatsapp', start, true, data);
}

interface TelegramBotProbe { name: string; ok: boolean; username?: string; error?: string }

async function probeTelegram(env: Env, start: number): Promise<ProbeResult> {
  const tokens: { name: string; token: string | undefined }[] = [
    { name: 'BoothBot',   token: env.TELEGRAM_BOT_TOKEN },
    { name: 'SourceBot',  token: env.TELEGRAM_BOT_TOKEN_SOURCE },
    { name: 'DemoBot',    token: env.TELEGRAM_BOT_TOKEN_DEMO },
    { name: 'ExpenseBot', token: env.TELEGRAM_BOT_TOKEN_EXPENSE },
  ];
  const results: TelegramBotProbe[] = await Promise.all(tokens.map(async ({ name, token }) => {
    if (!token) return { name, ok: false, error: 'token unset' };
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      if (!r.ok) return { name, ok: false, error: `status ${r.status}` };
      const data = await r.json() as { ok: boolean; result?: { username?: string } };
      return { name, ok: data.ok, username: data.result?.username };
    } catch (e) {
      return { name, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }));
  const allOk = results.every(r => r.ok);
  const anyOk = results.some(r => r.ok);
  return done('telegram', start, anyOk, { bots: results, all_ok: allOk });
}

async function probeStripe(env: Env, start: number): Promise<ProbeResult> {
  if (!env.STRIPE_SECRET_KEY) return done('stripe', start, false, undefined, 'STRIPE_SECRET_KEY unset');
  const res = await fetch('https://api.stripe.com/v1/account', {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return done('stripe', start, false, undefined, `${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  const slim = {
    id: data.id,
    email: data.email,
    charges_enabled: data.charges_enabled,
    livemode: env.STRIPE_SECRET_KEY.startsWith('sk_live_'),
  };
  return done('stripe', start, true, slim);
}

async function probeResend(env: Env, start: number): Promise<ProbeResult> {
  if (!env.RESEND_API_KEY) return done('resend', start, false, undefined, 'RESEND_API_KEY unset (dev fallback active)');
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return done('resend', start, false, undefined, `${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({})) as { data?: { name: string; status: string }[] };
  const domains = (data.data ?? []).map(d => ({ name: d.name, status: d.status }));
  return done('resend', start, true, { domains });
}

async function probeD1(env: Env, start: number): Promise<ProbeResult> {
  try {
    const row = await env.DB.prepare(`SELECT 1 AS ok`).first<{ ok: number }>();
    return done('d1', start, row?.ok === 1);
  } catch (e) {
    return done('d1', start, false, undefined, e instanceof Error ? e.message : String(e));
  }
}

async function probeR2(env: Env, start: number): Promise<ProbeResult> {
  try {
    const list = await env.R2_BUCKET.list({ limit: 1 });
    return done('r2', start, true, { object_count_sample: list.objects.length });
  } catch (e) {
    return done('r2', start, false, undefined, e instanceof Error ? e.message : String(e));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML page

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — DaGama</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --navy: #0F1419; --navy-light: #1a2235; --gold: #D4AF37; --gold-light: #E8C547;
      --slate-300: #CBD5E1; --slate-400: #94A3B8; --slate-500: #64748B;
      --slate-700: #334155; --slate-800: #1E293B; --white: #F5F5F5;
      --green: #4ade80; --red: #f87171; --amber: #fbbf24;
    }
    body { font-family: 'Outfit', sans-serif; background: linear-gradient(135deg, var(--navy) 0%, #1a2844 100%); color: var(--white); min-height: 100vh; }
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.2rem 2rem; border-bottom: 1px solid rgba(212,175,55,0.15);
      background: rgba(15,20,25,0.8); backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 10;
    }
    .logo { font-family: 'Playfair Display', serif; font-size: 1.5rem; background: linear-gradient(135deg, #F5F5F5, #D4AF37); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .logo small { font-family: 'Outfit', sans-serif; font-size: 0.8rem; letter-spacing: 0.2em; color: var(--slate-400); margin-left: 0.6rem; text-transform: uppercase; }
    .nav-right { display: flex; align-items: center; gap: 1rem; }
    .user-badge { background: rgba(212,175,55,0.1); border: 1px solid rgba(212,175,55,0.2); border-radius: 20px; padding: 0.4rem 1rem; font-size: 0.85rem; color: var(--gold); }
    .nav-link { color: var(--slate-400); text-decoration: none; font-size: 0.85rem; padding: 0.4rem 0.8rem; border-radius: 6px; }
    .nav-link:hover { color: var(--gold); background: rgba(212,175,55,0.05); }
    main { max-width: 1200px; margin: 0 auto; padding: 2.5rem 2rem; }
    .tabs { display: flex; gap: 0.5rem; border-bottom: 1px solid rgba(212,175,55,0.15); margin-bottom: 2rem; }
    .tab { padding: 0.75rem 1.25rem; cursor: pointer; color: var(--slate-400); font-weight: 500; border-bottom: 2px solid transparent; transition: all 0.15s; }
    .tab:hover { color: var(--gold-light); }
    .tab.active { color: var(--gold); border-bottom-color: var(--gold); }
    .tab-panel { display: none; animation: fadeIn 0.25s ease; }
    .tab-panel.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .card {
      background: linear-gradient(135deg, rgba(30,41,59,0.85), rgba(30,41,59,0.55));
      border: 1px solid rgba(212,175,55,0.15); border-radius: 14px;
      padding: 1.5rem; margin-bottom: 1.25rem;
    }
    .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem; }
    .card-title { font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: 0.6rem; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.green { background: var(--green); box-shadow: 0 0 8px rgba(74,222,128,0.6); }
    .dot.red   { background: var(--red);   box-shadow: 0 0 8px rgba(248,113,113,0.6); }
    .dot.amber { background: var(--amber); box-shadow: 0 0 8px rgba(251,191,36,0.6); }
    .card-meta { display: flex; gap: 0.6rem; flex-wrap: wrap; }
    .pill { font-size: 0.78rem; padding: 0.25rem 0.65rem; border-radius: 12px; background: rgba(148,163,184,0.1); border: 1px solid rgba(148,163,184,0.2); color: var(--slate-300); }
    .pill.ok { background: rgba(74,222,128,0.1); border-color: rgba(74,222,128,0.25); color: var(--green); }
    .pill.warn { background: rgba(251,191,36,0.1); border-color: rgba(251,191,36,0.25); color: var(--amber); }
    .pill.err  { background: rgba(248,113,113,0.1); border-color: rgba(248,113,113,0.25); color: var(--red); }
    .btn {
      background: linear-gradient(135deg, var(--gold), var(--gold-light)); color: var(--navy);
      border: none; border-radius: 8px; padding: 0.5rem 1rem; font-weight: 600; cursor: pointer;
      font-family: 'Outfit', sans-serif; font-size: 0.85rem; transition: transform 0.15s;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-ghost { background: transparent; color: var(--slate-300); border: 1px solid rgba(212,175,55,0.25); }
    .btn-ghost:hover { color: var(--gold); border-color: var(--gold); }
    .secrets-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
    .secrets-table td { padding: 0.45rem 0.5rem; border-top: 1px solid rgba(148,163,184,0.08); vertical-align: top; }
    .secrets-table td.name { font-family: 'SF Mono', Menlo, monospace; color: var(--gold-light); white-space: nowrap; }
    .secrets-table td.status { white-space: nowrap; width: 90px; }
    .secrets-table td.desc { color: var(--slate-400); font-size: 0.85rem; }
    .check-ok { color: var(--green); }
    .check-missing { color: var(--red); }
    .check-optional { color: var(--slate-500); }
    .config-row {
      display: grid; grid-template-columns: 220px 1fr auto; gap: 1rem; align-items: center;
      padding: 0.75rem 0.5rem; border-top: 1px solid rgba(148,163,184,0.08);
    }
    .config-row:first-child { border-top: none; }
    .config-key { font-family: 'SF Mono', Menlo, monospace; font-size: 0.85rem; color: var(--gold-light); }
    .config-key small { display: block; color: var(--slate-500); font-family: 'Outfit', sans-serif; font-size: 0.72rem; margin-top: 0.1rem; }
    .config-input { width: 100%; padding: 0.5rem 0.7rem; background: rgba(15,20,25,0.6); border: 1px solid rgba(212,175,55,0.18); border-radius: 6px; color: var(--white); font-family: 'SF Mono', Menlo, monospace; font-size: 0.88rem; }
    .config-input:focus { outline: none; border-color: var(--gold); }
    .config-meta { font-size: 0.75rem; color: var(--slate-500); }
    .route-group { margin-bottom: 0.75rem; border: 1px solid rgba(212,175,55,0.1); border-radius: 10px; overflow: hidden; }
    .route-group summary { padding: 0.75rem 1rem; cursor: pointer; background: rgba(30,41,59,0.5); font-weight: 500; }
    .route-group summary:hover { background: rgba(30,41,59,0.7); }
    .route-row { display: grid; grid-template-columns: 70px 1fr auto; gap: 0.75rem; padding: 0.5rem 1rem; border-top: 1px solid rgba(148,163,184,0.06); align-items: center; font-size: 0.85rem; }
    .method { font-family: 'SF Mono', Menlo, monospace; font-weight: 700; font-size: 0.78rem; }
    .method.GET { color: #60a5fa; } .method.POST { color: var(--green); } .method.PUT, .method.PATCH { color: var(--amber); } .method.DELETE { color: var(--red); }
    .path-cell { font-family: 'SF Mono', Menlo, monospace; color: var(--white); font-size: 0.82rem; }
    .path-desc { display: block; color: var(--slate-400); font-family: 'Outfit', sans-serif; font-size: 0.78rem; margin-top: 0.2rem; }
    .copy-btn { background: transparent; border: 1px solid rgba(148,163,184,0.2); color: var(--slate-400); border-radius: 6px; padding: 0.3rem 0.6rem; cursor: pointer; font-size: 0.75rem; }
    .copy-btn:hover { color: var(--gold); border-color: var(--gold); }
    .toast {
      position: fixed; bottom: 1.5rem; right: 1.5rem; padding: 0.85rem 1.4rem;
      border-radius: 10px; font-size: 0.9rem; z-index: 999; display: none;
    }
    .toast.success { background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.3); color: var(--green); }
    .toast.error   { background: rgba(248,113,113,0.15); border: 1px solid rgba(248,113,113,0.3); color: var(--red); }
    .empty { text-align: center; color: var(--slate-400); padding: 2rem; }
    .probe-detail { font-family: 'SF Mono', Menlo, monospace; font-size: 0.78rem; color: var(--slate-300); background: rgba(15,20,25,0.5); padding: 0.6rem 0.8rem; border-radius: 8px; margin-top: 0.6rem; white-space: pre-wrap; word-break: break-word; }
    a.ext { color: var(--slate-400); font-size: 0.78rem; text-decoration: none; }
    a.ext:hover { color: var(--gold); }
  </style>
</head>
<body>
  <nav>
    <span class="logo">DaGama<small>Admin</small></span>
    <div class="nav-right">
      <a class="nav-link" href="/dashboard">Dashboard</a>
      <span class="user-badge" id="user-badge">Loading…</span>
    </div>
  </nav>
  <main>
    <div class="tabs" role="tablist">
      <div class="tab active" data-tab="integrations" role="tab">Integrations</div>
      <div class="tab" data-tab="config" role="tab">Config</div>
      <div class="tab" data-tab="routes" role="tab">Routes</div>
    </div>

    <section id="tab-integrations" class="tab-panel active">
      <div id="integrations-list"><p class="empty">Loading…</p></div>
    </section>

    <section id="tab-config" class="tab-panel">
      <div class="card">
        <div class="card-head"><div class="card-title">Runtime config</div></div>
        <div id="config-list"><p class="empty">Loading…</p></div>
      </div>
    </section>

    <section id="tab-routes" class="tab-panel">
      <div id="routes-list"><p class="empty">Loading…</p></div>
    </section>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    // Auth: prefer Cloudflare Access cookie (sent automatically same-origin),
    // fall back to user-JWT in localStorage. We do NOT redirect when both are
    // missing — let the server respond and show a diagnostic.
    const TOKEN = localStorage.getItem('dagama_token');
    const auth = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
    const fetchOpts = { headers: auth, credentials: 'include' };

    function escape(s) { return String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c])); }
    function toast(msg, kind) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast ' + (kind === 'error' ? 'error' : 'success');
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 2400);
    }

    function fmtTime(unix) {
      if (!unix) return '(default — never edited)';
      try { return new Date(unix * 1000).toLocaleString(); } catch { return String(unix); }
    }

    async function loadInventory() {
      let r;
      try { r = await fetch('/api/admin/inventory', fetchOpts); }
      catch (e) { toast('Network error: ' + e.message, 'error'); return; }
      if (r.status === 401) {
        if (TOKEN) { window.location.href = '/login?next=/admin'; return; }
        document.querySelector('main').innerHTML = '<div class=\"card\"><h2 style=\"color:var(--red)\">Not authenticated</h2><p>This page is gated by Cloudflare Access. If you reached it directly without going through the Cloudflare Access login, that is the problem. Try opening <code>/admin</code> in a fresh tab.</p></div>';
        return;
      }
      if (r.status === 403) {
        document.querySelector('main').innerHTML = '<div class=\"card\"><h2 style=\"color:var(--red)\">Forbidden</h2><p>Your account is not on the admin allowlist (<code>ADMIN_EMAILS</code>).</p></div>';
        return;
      }
      if (!r.ok) { toast('Failed to load inventory', 'error'); return; }
      const data = await r.json();
      const viaTag = data.admin.via === 'cf_access' ? ' • Cloudflare Access' : ' • user JWT';
      document.getElementById('user-badge').textContent = data.admin.email + viaTag;
      renderIntegrations(data.integrations);
      renderConfig(data.config);
      renderRoutes(data.routes);
    }

    function renderIntegrations(list) {
      const root = document.getElementById('integrations-list');
      if (!list || list.length === 0) { root.innerHTML = '<p class=\"empty\">No integrations registered.</p>'; return; }
      root.innerHTML = list.map(card => {
        const dotClass = card.missing_required.length ? 'red' : (card.set < card.total ? 'amber' : 'green');
        const probeBtn = card.probe ? '<button class=\"btn btn-ghost\" data-probe=\"' + escape(card.probe) + '\">Probe</button>' : '';
        const extLink = card.external_link ? '<a class=\"ext\" href=\"' + escape(card.external_link) + '\" target=\"_blank\" rel=\"noopener\">↗ external</a>' : '';
        const rows = card.secrets.map(s => {
          const status = s.binding ? (s.present ? '<span class=\"check-ok\">● bound</span>' : '<span class=\"check-missing\">● unbound</span>')
                                   : (s.present ? '<span class=\"check-ok\">✓ set</span>'
                                                : (s.optional ? '<span class=\"check-optional\">– optional</span>' : '<span class=\"check-missing\">✗ missing</span>'));
          return '<tr><td class=\"name\">' + escape(s.name) + '</td><td class=\"status\">' + status + '</td><td class=\"desc\">' + escape(s.description) + '</td></tr>';
        }).join('');
        return '<div class=\"card\">' +
          '<div class=\"card-head\">' +
            '<div class=\"card-title\"><span class=\"dot ' + dotClass + '\"></span>' + escape(card.label) + '</div>' +
            '<div class=\"card-meta\">' +
              '<span class=\"pill ' + (card.missing_required.length ? 'err' : (card.set === card.total ? 'ok' : 'warn')) + '\">' + card.set + '/' + card.total + ' set</span>' +
              extLink +
              probeBtn +
            '</div>' +
          '</div>' +
          '<table class=\"secrets-table\"><tbody>' + rows + '</tbody></table>' +
          '<div class=\"probe-detail\" id=\"probe-' + escape(card.category) + '\" style=\"display:none\"></div>' +
        '</div>';
      }).join('');

      root.querySelectorAll('button[data-probe]').forEach(btn => {
        btn.addEventListener('click', () => runProbe(btn.getAttribute('data-probe'), btn));
      });
    }

    async function runProbe(probeId, btn) {
      btn.disabled = true; btn.textContent = 'Running…';
      try {
        const r = await fetch('/api/admin/probe/' + encodeURIComponent(probeId), { method: 'POST', headers: auth, credentials: 'include' });
        const data = await r.json();
        const card = btn.closest('.card');
        const detail = card.querySelector('.probe-detail');
        detail.style.display = 'block';
        const head = (data.ok ? '✓ OK' : '✗ FAIL') + '  •  ' + data.latency_ms + 'ms' + (data.cached ? '  •  cached' : '');
        const body = data.error ? ('\\n' + data.error) : (data.detail ? ('\\n' + JSON.stringify(data.detail, null, 2)) : '');
        detail.textContent = head + body;
        toast((data.ok ? 'Probe OK' : 'Probe failed') + ' (' + probeId + ')', data.ok ? 'success' : 'error');
      } catch (e) {
        toast('Probe error: ' + e.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Probe';
      }
    }

    function renderConfig(rows) {
      const root = document.getElementById('config-list');
      if (!rows || rows.length === 0) { root.innerHTML = '<p class=\"empty\">No config rows. Apply migration 029.</p>'; return; }
      root.innerHTML = rows.map(row => {
        const inputId = 'cfg-' + row.key;
        let inputHtml;
        if (row.value_type === 'bool') {
          const checked = row.value === 'true' ? 'checked' : '';
          inputHtml = '<label style=\"display:inline-flex;gap:0.4rem;align-items:center\"><input type=\"checkbox\" id=\"' + inputId + '\" ' + checked + '><span style=\"color:var(--slate-400);font-size:0.85rem\">' + (row.value === 'true' ? 'enabled' : 'disabled') + '</span></label>';
        } else if (row.value_type === 'number') {
          inputHtml = '<input class=\"config-input\" id=\"' + inputId + '\" type=\"number\" value=\"' + escape(row.value) + '\">';
        } else {
          inputHtml = '<input class=\"config-input\" id=\"' + inputId + '\" type=\"text\" value=\"' + escape(row.value) + '\">';
        }
        return '<div class=\"config-row\">' +
          '<div class=\"config-key\">' + escape(row.key) + '<small>' + escape(row.description || row.value_type) + '</small></div>' +
          '<div>' + inputHtml + '<div class=\"config-meta\">type: ' + escape(row.value_type) + ' • last edited: ' + fmtTime(row.updated_at) + (row.updated_by ? ' by ' + escape(row.updated_by) : '') + '</div></div>' +
          '<button class=\"btn\" data-save=\"' + escape(row.key) + '\" data-type=\"' + escape(row.value_type) + '\">Save</button>' +
        '</div>';
      }).join('');

      root.querySelectorAll('button[data-save]').forEach(btn => {
        btn.addEventListener('click', () => saveConfig(btn.getAttribute('data-save'), btn.getAttribute('data-type')));
      });
    }

    async function saveConfig(key, type) {
      const input = document.getElementById('cfg-' + key);
      let value;
      if (type === 'bool') value = input.checked ? 'true' : 'false';
      else value = input.value;
      try {
        const r = await fetch('/api/admin/config/' + encodeURIComponent(key), {
          method: 'PATCH',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
          credentials: 'include',
        });
        const data = await r.json();
        if (!r.ok || !data.ok) { toast(data.error || 'Save failed', 'error'); return; }
        toast('Saved ' + key, 'success');
        loadInventory();
      } catch (e) {
        toast('Save error: ' + e.message, 'error');
      }
    }

    function renderRoutes(groups) {
      const root = document.getElementById('routes-list');
      if (!groups || groups.length === 0) { root.innerHTML = '<p class=\"empty\">No routes.</p>'; return; }
      root.innerHTML = groups.map(g => {
        const rows = g.routes.map(r => {
          const tags = [];
          if (r.requires_admin) tags.push('<span class=\"pill warn\">admin</span>');
          else if (r.requires_auth) tags.push('<span class=\"pill\">auth</span>');
          else tags.push('<span class=\"pill ok\">public</span>');
          return '<div class=\"route-row\">' +
            '<span class=\"method ' + escape(r.method) + '\">' + escape(r.method) + '</span>' +
            '<div><div class=\"path-cell\">' + escape(r.path) + '</div><span class=\"path-desc\">' + escape(r.description) + '</span></div>' +
            '<div style=\"display:flex;gap:0.5rem\">' + tags.join('') + '<button class=\"copy-btn\" data-copy=\"' + escape(r.method + ' ' + r.path) + '\">Copy</button></div>' +
          '</div>';
        }).join('');
        return '<details class=\"route-group\" open><summary>' + escape(g.label) + ' <span style=\"color:var(--slate-400);font-weight:400\">(' + g.routes.length + ')</span></summary>' + rows + '</details>';
      }).join('');

      root.querySelectorAll('button[data-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(btn.getAttribute('data-copy')); toast('Copied'); }
          catch { toast('Copy failed', 'error'); }
        });
      });
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.getAttribute('data-tab')).classList.add('active');
      });
    });

    loadInventory();
  </script>
</body>
</html>`;

/// <reference types="@cloudflare/workers-types" />

import { handleLogin, handleRegister, handleMe, handleStats, handleInsights } from './auth';
import { handleTelegramWebhook, handleSetupWebhook } from './telegram';
import { handleGmailCallback } from './gmail';
import { handleCreateCheckout, handleStripeWebhook, handleBillingPortal, handleSubscriptionStatus } from './stripe';
import { getUserSheets } from './sheets';
import { handleProcessCard, type ProcessCardJob } from './queue';
import { handleShowPassCron } from './telegram';
import { handleOnboard, handleOnboardingStatus } from './onboarding';
import { handleGoogleAuthStart, handleGoogleAuthCallback } from './google_auth';
import { handleSourceBotWebhook, handleSourceBotSetupWebhook, handleSourceBotShowPassCron, handleAdminReset } from './sourcebot';
import { handleDemoBotWebhook, handleDemoBotSetupWebhook, handleDemoBotDailySummaryCron } from './demobot';
import { handleWhatsAppWebhook, isWhatsAppEnabled } from './whatsapp';
import { handleWebUpload, handleListLeads, handleGetLead, handleListSuppliers, handleGetMyRole, handleSupplierExtension, handleSupplierVoice } from './web_capture';
import { processFunnelQueue } from './funnel';
import { processDemobotQueue } from './db_emails';
import { handleListShows, handleCreateShow, handleUpdateShow, handleDeleteShow, handleIssueFreelancerToken, handleMarkConversion } from './demobot_admin';
import type { Env } from './types';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await handleShowPassCron(env);
    await handleSourceBotShowPassCron(env);
    try {
      const result = await processFunnelQueue(env);
      if (result.sent || result.failed || result.skipped) {
        console.log(`[funnel] sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`);
      }
    } catch (e) { console.error('[funnel] cron failed:', e); }
    try {
      const r = await processDemobotQueue(env);
      if (r.sent || r.failed || r.skipped) {
        console.log(`[demobot] queue sent=${r.sent} failed=${r.failed} skipped=${r.skipped}`);
      }
    } catch (e) { console.error('[demobot] queue cron failed:', e); }
    try { await handleDemoBotDailySummaryCron(env); }
    catch (e) { console.error('[demobot] daily summary cron failed:', e); }
  },

  async queue(batch: MessageBatch<ProcessCardJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        if (job.jobType === 'process_card') {
          await handleProcessCard(job, env);
          msg.ack();
        } else {
          msg.ack(); // unknown type — don't retry
        }
      } catch (e) {
        console.error(`Queue job ${job.jobId} failed:`, e);
        msg.retry();
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // API routes
    if (path === '/api/health')        return addCors(await handleHealth(env));
    if (path === '/api/auth/register') return addCors(await handleRegister(request, env));
    if (path === '/api/auth/login')    return addCors(await handleLogin(request, env));
    if (path === '/api/me')                  return addCors(await handleMe(request, env));
    if (path === '/api/stats')               return addCors(await handleStats(request, env));
    if (path === '/api/insights')            return addCors(await handleInsights(request, env));
    if (path === '/api/telegram/webhook')    return handleTelegramWebhook(request, env);
    if (path === '/api/telegram/setup')      return addCors(await handleSetupWebhook(request, env));
    if (path === '/api/stripe/checkout')     return addCors(await handleCreateCheckout(request, env));
    if (path === '/api/stripe/webhook')      return handleStripeWebhook(request, env);
    if (path === '/api/stripe/portal')       return addCors(await handleBillingPortal(request, env));
    if (path === '/api/stripe/status')       return addCors(await handleSubscriptionStatus(request, env));
    if (path === '/api/google/sheets')       return addCors(await handleGetSheets(request, env));
    if (path === '/api/gmail/callback')      return handleGmailCallback(request, env);
    if (path === '/api/onboard')              return addCors(await handleOnboard(request, env));
    if (path === '/api/me/onboarding-status') return addCors(await handleOnboardingStatus(request, env));
    if (path === '/api/auth/google')          return handleGoogleAuthStart(request, env);
    if (path === '/api/auth/google/callback') return handleGoogleAuthCallback(request, env);
    if (path === '/api/sourcebot/webhook')   return handleSourceBotWebhook(request, env);
    if (path === '/api/sourcebot/setup')     return addCors(await handleSourceBotSetupWebhook(request, env));
    if (path === '/api/sourcebot/admin/reset-buyer') return addCors(await handleAdminReset(request, env));

    // ── WhatsApp Cloud API (Meta) ─────────────────────────────────────────────
    // GET = subscribe-handshake (hub.challenge echo). POST = inbound events.
    // Returns 503 until all WHATSAPP_* secrets are set (see isWhatsAppEnabled).
    if (path === '/api/whatsapp/webhook')    return handleWhatsAppWebhook(request, env);

    // ── Web capture (third channel) ───────────────────────────────────────────
    if (path === '/api/upload')              return addCors(await handleWebUpload(request, env));
    if (path === '/api/leads')               return addCors(await handleListLeads(request, env));
    if (path === '/api/suppliers')           return addCors(await handleListSuppliers(request, env));
    if (path === '/api/me/role')             return addCors(await handleGetMyRole(request, env));
    {
      const m = path.match(/^\/api\/leads\/([a-f0-9-]+)$/i);
      if (m) return addCors(await handleGetLead(request, env, m[1]));
    }
    {
      const m = path.match(/^\/api\/suppliers\/([a-f0-9-]+)\/(card-back|person-photo)$/i);
      if (m) {
        const kind = m[2] === 'card-back' ? 'card_back' : 'person_photo';
        return addCors(await handleSupplierExtension(request, env, m[1], kind));
      }
    }
    {
      const m = path.match(/^\/api\/suppliers\/([a-f0-9-]+)\/voice$/i);
      if (m) return addCors(await handleSupplierVoice(request, env, m[1]));
    }

    // ── DemoBot (freelancer-facing @DaGamaShow) ───────────────────────────────
    if (path === '/api/demobot/webhook')                  return handleDemoBotWebhook(request, env);
    if (path === '/api/demobot/setup')                    return addCors(await handleDemoBotSetupWebhook(request, env));
    if (path === '/api/demobot/admin/freelancer-token')   return addCors(await handleIssueFreelancerToken(request, env));
    if (path === '/api/demobot/admin/conversion')         return addCors(await handleMarkConversion(request, env));

    // ── shows_catalog (public read, admin mutations) ──────────────────────────
    if (path === '/api/shows-catalog' && request.method === 'GET')  return addCors(await handleListShows(request, env));
    if (path === '/api/shows-catalog' && request.method === 'POST') return addCors(await handleCreateShow(request, env));
    {
      const m = path.match(/^\/api\/shows-catalog\/([a-z0-9-]+)$/i);
      if (m) {
        if (request.method === 'PUT')    return addCors(await handleUpdateShow(request, env, m[1]));
        if (request.method === 'DELETE') return addCors(await handleDeleteShow(request, env, m[1]));
      }
    }

    // Internal R2 pass-through — used so CF image transforms can fetch objects
    // from our private bucket via a URL on this worker's zone.
    if (path.startsWith('/_r2/')) {
      const key = decodeURIComponent(path.slice(5));
      const obj = await env.R2_BUCKET.get(key);
      if (!obj) return new Response('Not Found', { status: 404 });
      return new Response(obj.body, {
        headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream' },
      });
    }

    // UI routes
    if (path === '/') {
      return new Response(LANDING_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/login') {
      return new Response(LOGIN_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/register') {
      return new Response(REGISTER_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/dashboard') {
      return new Response(DASHBOARD_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (path === '/onboard-complete') {
      return new Response(ONBOARD_COMPLETE_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleHealth(env: Env): Promise<Response> {
  // Cheap pings — confirm bindings are wired up. Keep this fast (used for uptime probes).
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    const row = await env.DB.prepare(`SELECT 1 AS ok`).first<{ ok: number }>();
    checks.d1 = { ok: row?.ok === 1 };
  } catch (e) {
    checks.d1 = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  checks.r2     = { ok: typeof env.R2_BUCKET?.put === 'function' };
  checks.queue  = { ok: typeof env.CARD_QUEUE?.send === 'function' };
  checks.boothbot_token  = { ok: !!env.TELEGRAM_BOT_TOKEN };
  checks.sourcebot_token = { ok: !!env.TELEGRAM_BOT_TOKEN_SOURCE };
  checks.gemini = { ok: !!env.GEMINI_API_KEY };
  checks.gcv    = { ok: !!env.GCV_API_KEY };
  // WhatsApp is optional until Meta approval — report as informational only.
  // (Not factored into overall ok: missing secrets are expected pre-approval.)
  const waEnabled = isWhatsAppEnabled(env);
  checks.whatsapp = { ok: true, detail: waEnabled ? 'enabled' : 'disabled (secrets unset)' };

  const overall = Object.values(checks).every(c => c.ok);
  return new Response(JSON.stringify({
    status: overall ? 'ok' : 'degraded',
    env:    env.ENVIRONMENT,
    time:   new Date().toISOString(),
    checks,
  }, null, 2), {
    status: overall ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleGetSheets(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const { requireAuth } = await import('./auth');
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const sheets = await getUserSheets(auth.userId, env);
  return new Response(JSON.stringify({ sheets }), { headers: { 'Content-Type': 'application/json' } });
}

function addCors(response: Response): Response {
  const res = new Response(response.body, response);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DaGama — Coming Soon</title>
  <meta name="description" content="DaGama — Trade show intelligence. Launching soon.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --navy: #0F1419;
      --navy-light: #1a2235;
      --gold: #D4AF37;
      --gold-light: #E8C547;
      --slate-400: #94A3B8;
      --slate-500: #64748B;
      --white: #F5F5F5;
    }

    html, body { height: 100%; }

    body {
      font-family: 'Outfit', sans-serif;
      background: linear-gradient(135deg, var(--navy) 0%, #1a2844 100%);
      color: var(--white);
      line-height: 1.6;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
    }

    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(circle at 20% 30%, rgba(212, 175, 55, 0.10) 0%, transparent 55%),
        radial-gradient(circle at 80% 80%, rgba(212, 175, 55, 0.05) 0%, transparent 55%);
      pointer-events: none;
      z-index: 0;
    }

    main {
      position: relative;
      z-index: 1;
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 4rem 1.5rem;
      text-align: center;
    }

    .logo {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--gold);
      text-transform: uppercase;
      margin-bottom: 3.5rem;
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
    }

    .logo .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--gold);
      box-shadow: 0 0 16px rgba(212, 175, 55, 0.7);
      animation: pulse 2.4s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.55; transform: scale(0.85); }
    }

    .eyebrow {
      font-size: 0.85rem;
      font-weight: 500;
      letter-spacing: 0.32em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 1.25rem;
      opacity: 0.9;
    }

    h1 {
      font-family: 'Playfair Display', serif;
      font-weight: 900;
      font-size: clamp(2.75rem, 8vw, 5.5rem);
      line-height: 1.05;
      letter-spacing: -0.01em;
      max-width: 18ch;
      background: linear-gradient(135deg, #ffffff 0%, var(--gold-light) 60%, var(--gold) 100%);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 1.5rem;
    }

    p.tagline {
      max-width: 38rem;
      font-size: clamp(1.05rem, 1.6vw, 1.25rem);
      color: var(--slate-400);
      font-weight: 300;
      margin-bottom: 3rem;
    }

    .divider {
      width: 56px;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--gold), transparent);
      margin: 0 auto 2.5rem;
    }

    .contact {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.85rem 1.75rem;
      border: 1px solid rgba(212, 175, 55, 0.35);
      border-radius: 999px;
      color: var(--white);
      font-weight: 500;
      text-decoration: none;
      transition: all 0.25s ease;
      backdrop-filter: blur(10px);
      background: rgba(212, 175, 55, 0.04);
    }

    .contact:hover {
      border-color: var(--gold);
      background: rgba(212, 175, 55, 0.12);
      transform: translateY(-1px);
    }

    .contact svg { width: 16px; height: 16px; stroke: var(--gold); }

    footer {
      position: relative;
      z-index: 1;
      padding: 1.75rem 1.5rem;
      text-align: center;
      color: var(--slate-500);
      font-size: 0.85rem;
      border-top: 1px solid rgba(212, 175, 55, 0.08);
    }

    @media (max-width: 540px) {
      .logo { margin-bottom: 2.5rem; }
      h1 { letter-spacing: -0.005em; }
    }
  </style>
</head>
<body>
  <main>
    <div class="logo"><span class="dot"></span>DaGama</div>
    <div class="eyebrow">Coming Soon</div>
    <h1>Trade show intelligence, reimagined.</h1>
    <p class="tagline">We're building the platform exhibitors and organizers will rely on to capture, qualify, and follow up on every lead. Launching soon.</p>
    <div class="divider"></div>
    <a class="contact" href="mailto:hello@heydagama.com">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16v12H4z"/><path d="m4 7 8 6 8-6"/></svg>
      hello@heydagama.com
    </a>
  </main>
  <footer>&copy; ${new Date().getFullYear()} DaGama. All rights reserved.</footer>
</body>
</html>`;

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Log In — DaGama</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      background: linear-gradient(135deg, #0F1419 0%, #1a2844 100%);
      color: #F5F5F5; 
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { 
      max-width: 420px; 
      width: 100%;
      padding: 2rem; 
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(30, 41, 59, 0.6));
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 16px;
      backdrop-filter: blur(20px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      animation: fadeInUp 0.8s ease-out;
    }
    h1 { 
      font-family: 'Playfair Display', serif;
      font-size: 2.5rem; 
      margin-bottom: 2rem; 
      text-align: center;
      background: linear-gradient(135deg, #F5F5F5, #D4AF37);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    input { 
      width: 100%; 
      padding: 1rem; 
      margin-bottom: 1.2rem; 
      background: rgba(51, 65, 85, 0.5);
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 8px; 
      color: #F5F5F5;
      font-family: 'Outfit', sans-serif;
      transition: all 0.3s ease;
    }
    input:focus {
      outline: none;
      border-color: rgba(212, 175, 55, 0.4);
      background: rgba(51, 65, 85, 0.7);
      box-shadow: 0 0 20px rgba(212, 175, 55, 0.15);
    }
    input::placeholder { color: #94A3B8; }
    button { 
      width: 100%; 
      padding: 1rem; 
      background: linear-gradient(135deg, #D4AF37, #E8C547);
      color: #0F1419; 
      border: none; 
      border-radius: 8px; 
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2);
    }
    button:hover { 
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(212, 175, 55, 0.3);
    }
    p { 
      text-align: center; 
      margin-top: 1.5rem;
      color: #94A3B8;
      font-size: 0.95rem;
    }
    a { 
      color: #D4AF37; 
      text-decoration: none;
      transition: color 0.3s ease;
    }
    a:hover { color: #E8C547; }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Log In</h1>
    <div id="error" style="display:none;color:#f87171;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:0.75rem 1rem;margin-bottom:1.2rem;font-size:0.9rem;"></div>
    <input id="email" type="email" placeholder="Email address" />
    <input id="password" type="password" placeholder="Password" />
    <button id="btn" onclick="doLogin()">Log In</button>
    <p>No account? <a href="/register">Sign up</a></p>
  </div>
  <script>
    async function doLogin() {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const err = document.getElementById('error');
      const btn = document.getElementById('btn');
      err.style.display = 'none';
      if (!email || !password) { err.textContent = 'Please fill in all fields.'; err.style.display = 'block'; return; }
      btn.textContent = 'Logging in…'; btn.disabled = true;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) { err.textContent = data.error || 'Login failed.'; err.style.display = 'block'; return; }
        localStorage.setItem('dagama_token', data.token);
        localStorage.setItem('dagama_user', JSON.stringify(data.user));
        window.location.href = '/dashboard';
      } catch (e) {
        err.textContent = 'Network error. Please try again.'; err.style.display = 'block';
      } finally {
        btn.textContent = 'Log In'; btn.disabled = false;
      }
    }
    document.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  </script>
</body>
</html>`;

const REGISTER_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign Up — DaGama</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      background: linear-gradient(135deg, #0F1419 0%, #1a2844 100%);
      color: #F5F5F5; 
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { 
      max-width: 420px; 
      width: 100%;
      padding: 2rem; 
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(30, 41, 59, 0.6));
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 16px;
      backdrop-filter: blur(20px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      animation: fadeInUp 0.8s ease-out;
    }
    h1 { 
      font-family: 'Playfair Display', serif;
      font-size: 2.5rem; 
      margin-bottom: 2rem; 
      text-align: center;
      background: linear-gradient(135deg, #F5F5F5, #D4AF37);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    input { 
      width: 100%; 
      padding: 1rem; 
      margin-bottom: 1.2rem; 
      background: rgba(51, 65, 85, 0.5);
      border: 1px solid rgba(212, 175, 55, 0.15);
      border-radius: 8px; 
      color: #F5F5F5;
      font-family: 'Outfit', sans-serif;
      transition: all 0.3s ease;
    }
    input:focus {
      outline: none;
      border-color: rgba(212, 175, 55, 0.4);
      background: rgba(51, 65, 85, 0.7);
      box-shadow: 0 0 20px rgba(212, 175, 55, 0.15);
    }
    input::placeholder { color: #94A3B8; }
    button { 
      width: 100%; 
      padding: 1rem; 
      background: linear-gradient(135deg, #D4AF37, #E8C547);
      color: #0F1419; 
      border: none; 
      border-radius: 8px; 
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2);
    }
    button:hover { 
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(212, 175, 55, 0.3);
    }
    p { 
      text-align: center; 
      margin-top: 1.5rem;
      color: #94A3B8;
      font-size: 0.95rem;
    }
    a { 
      color: #D4AF37; 
      text-decoration: none;
      transition: color 0.3s ease;
    }
    a:hover { color: #E8C547; }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Get Started</h1>
    <div id="error" style="display:none;color:#f87171;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:0.75rem 1rem;margin-bottom:1.2rem;font-size:0.9rem;"></div>
    <input id="name" type="text" placeholder="Full name" />
    <input id="email" type="email" placeholder="Email address" />
    <input id="password" type="password" placeholder="Password (min 8 characters)" />
    <button id="btn" onclick="doRegister()">Sign Up</button>
    <p>Already have an account? <a href="/login">Log in</a></p>
  </div>
  <script>
    async function doRegister() {
      const name = document.getElementById('name').value.trim();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const err = document.getElementById('error');
      const btn = document.getElementById('btn');
      err.style.display = 'none';
      if (!name || !email || !password) { err.textContent = 'Please fill in all fields.'; err.style.display = 'block'; return; }
      if (password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display = 'block'; return; }
      btn.textContent = 'Creating account…'; btn.disabled = true;
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password })
        });
        const data = await res.json();
        if (!res.ok) { err.textContent = data.error || 'Registration failed.'; err.style.display = 'block'; return; }
        localStorage.setItem('dagama_token', data.token);
        localStorage.setItem('dagama_user', JSON.stringify(data.user));
        window.location.href = '/dashboard';
      } catch (e) {
        err.textContent = 'Network error. Please try again.'; err.style.display = 'block';
      } finally {
        btn.textContent = 'Sign Up'; btn.disabled = false;
      }
    }
    document.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  </script>
</body>
</html>`;

const DASHBOARD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — DaGama</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --navy: #0F1419; --navy-light: #1a2235; --gold: #D4AF37; --gold-light: #E8C547;
      --slate-400: #94A3B8; --slate-700: #334155; --slate-800: #1E293B; --white: #F5F5F5;
    }
    body { font-family: 'Outfit', sans-serif; background: linear-gradient(135deg, var(--navy) 0%, #1a2844 100%); color: var(--white); min-height: 100vh; }
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.2rem 2rem; border-bottom: 1px solid rgba(212,175,55,0.15);
      background: rgba(15,20,25,0.8); backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 10;
    }
    .logo { font-family: 'Playfair Display', serif; font-size: 1.5rem; background: linear-gradient(135deg, #F5F5F5, #D4AF37); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .nav-right { display: flex; align-items: center; gap: 1rem; }
    .user-badge { background: rgba(212,175,55,0.1); border: 1px solid rgba(212,175,55,0.2); border-radius: 20px; padding: 0.4rem 1rem; font-size: 0.85rem; color: var(--gold); }
    .logout-btn { background: transparent; border: 1px solid rgba(212,175,55,0.3); color: var(--slate-400); border-radius: 8px; padding: 0.4rem 1rem; cursor: pointer; font-family: 'Outfit', sans-serif; font-size: 0.85rem; transition: all 0.2s; }
    .logout-btn:hover { border-color: var(--gold); color: var(--gold); }
    main { max-width: 1100px; margin: 0 auto; padding: 3rem 2rem; }
    .welcome { margin-bottom: 2.5rem; }
    .welcome h1 { font-family: 'Playfair Display', serif; font-size: 2rem; margin-bottom: 0.5rem; }
    .welcome p { color: var(--slate-400); }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; margin-bottom: 3rem; }
    .stat-card {
      background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(30,41,59,0.6));
      border: 1px solid rgba(212,175,55,0.15); border-radius: 16px; padding: 1.5rem;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .stat-card:hover { transform: translateY(-4px); box-shadow: 0 8px 30px rgba(212,175,55,0.1); }
    .stat-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--slate-400); margin-bottom: 0.5rem; }
    .stat-value { font-size: 2.2rem; font-weight: 700; color: var(--gold); }
    .stat-sub { font-size: 0.85rem; color: var(--slate-400); margin-top: 0.3rem; }
    .section-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 1.2rem; color: var(--white); }
    .empty-state {
      background: linear-gradient(135deg, rgba(30,41,59,0.6), rgba(30,41,59,0.3));
      border: 1px dashed rgba(212,175,55,0.2); border-radius: 16px; padding: 3rem;
      text-align: center; color: var(--slate-400);
    }
    .empty-state .icon { font-size: 2.5rem; margin-bottom: 1rem; }
    .empty-state p { font-size: 0.95rem; line-height: 1.6; }
    .badge { display: inline-block; border-radius: 12px; padding: 0.25rem 0.75rem; font-size: 0.75rem; font-weight: 600; margin-left: 0.5rem; vertical-align: middle; }
    .badge-gold { background: rgba(212,175,55,0.1); border: 1px solid rgba(212,175,55,0.2); color: var(--gold); }
    .badge-green { background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.2); color: #4ade80; }
    .badge-red { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.2); color: #f87171; }
    /* Upgrade section */
    .upgrade-section {
      background: linear-gradient(135deg, rgba(212,175,55,0.08), rgba(212,175,55,0.03));
      border: 1px solid rgba(212,175,55,0.25); border-radius: 16px; padding: 2rem; margin-bottom: 3rem;
    }
    .upgrade-section h2 { font-family: 'Playfair Display', serif; font-size: 1.5rem; margin-bottom: 0.5rem; }
    .upgrade-section p { color: var(--slate-400); margin-bottom: 1.5rem; font-size: 0.95rem; }
    .plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
    .plan-card {
      background: rgba(30,41,59,0.8); border: 1px solid rgba(212,175,55,0.15); border-radius: 12px;
      padding: 1.5rem; text-align: center; transition: all 0.3s;
    }
    .plan-card:hover { border-color: rgba(212,175,55,0.4); transform: translateY(-4px); }
    .plan-name { font-weight: 600; margin-bottom: 0.3rem; }
    .plan-price { font-size: 1.8rem; font-weight: 700; color: var(--gold); margin-bottom: 0.3rem; }
    .plan-desc { font-size: 0.8rem; color: var(--slate-400); margin-bottom: 1rem; }
    .plan-btn {
      width: 100%; padding: 0.65rem; background: linear-gradient(135deg, #D4AF37, #E8C547);
      color: #0F1419; border: none; border-radius: 8px; font-family: 'Outfit', sans-serif;
      font-weight: 600; cursor: pointer; transition: all 0.2s; font-size: 0.9rem;
    }
    .plan-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(212,175,55,0.3); }
    .plan-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    /* Active plan banner */
    .plan-banner {
      background: linear-gradient(135deg, rgba(74,222,128,0.08), rgba(74,222,128,0.03));
      border: 1px solid rgba(74,222,128,0.2); border-radius: 12px; padding: 1rem 1.5rem;
      display: flex; align-items: center; justify-content: space-between; margin-bottom: 3rem; flex-wrap: gap;
    }
    .plan-banner-info { display: flex; align-items: center; gap: 1rem; }
    .plan-banner-label { font-weight: 600; color: #4ade80; }
    .plan-banner-sub { font-size: 0.85rem; color: var(--slate-400); }
    .portal-btn {
      background: transparent; border: 1px solid rgba(74,222,128,0.3); color: #4ade80;
      border-radius: 8px; padding: 0.5rem 1rem; font-family: 'Outfit', sans-serif;
      font-size: 0.85rem; cursor: pointer; transition: all 0.2s;
    }
    .portal-btn:hover { background: rgba(74,222,128,0.1); }
    .action-btn {
      background: linear-gradient(135deg, #D4AF37, #E8C547); color: #0F1419; border: none;
      border-radius: 8px; padding: 0.75rem 1.5rem; font-family: 'Outfit', sans-serif;
      font-weight: 600; cursor: pointer; transition: all 0.2s; margin-top: 1rem;
    }
    .action-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(212,175,55,0.3); }
    .action-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    /* Toast */
    .toast {
      position: fixed; bottom: 2rem; right: 2rem; padding: 1rem 1.5rem;
      border-radius: 10px; font-size: 0.9rem; font-weight: 500; z-index: 999;
      animation: slideIn 0.3s ease; display: none;
    }
    .toast.success { background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.3); color: #4ade80; }
    .toast.error { background: rgba(248,113,113,0.15); border: 1px solid rgba(248,113,113,0.3); color: #f87171; }
    @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    main { animation: fadeIn 0.6s ease-out; }
  </style>
</head>
<body>
  <nav>
    <span class="logo">DaGama</span>
    <div class="nav-right">
      <span class="user-badge" id="user-badge">Loading…</span>
      <button class="logout-btn" onclick="logout()">Log out</button>
    </div>
  </nav>
  <main>
    <div class="welcome">
      <h1 id="welcome-msg">Welcome back</h1>
      <p>Your trade show intelligence hub</p>
    </div>

    <!-- Subscription status (injected by JS) -->
    <div id="sub-section"></div>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Plan</div>
        <div class="stat-value" id="stat-plan" style="font-size:1.1rem;padding-top:0.4rem;">—</div>
        <div class="stat-sub" id="stat-plan-sub">Loading…</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Leads Captured</div>
        <div class="stat-value" id="stat-leads">—</div>
        <div class="stat-sub">Via Telegram bot</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">AI Insights</div>
        <div class="stat-value" id="stat-ai">0</div>
        <div class="stat-sub">Powered by Gemini</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Telegram Bot</div>
        <div class="stat-value" id="stat-bot" style="font-size:1rem;padding-top:0.5rem;">—</div>
        <div class="stat-sub">Connect via /api/telegram/setup</div>
      </div>
    </div>

    <div class="section-title" data-capture-title>Capture a card <span class="badge badge-gold">Web</span></div>
    <div id="capture-box" style="background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(30,41,59,0.6)); border: 1px solid rgba(212,175,55,0.15); border-radius: 16px; padding: 1.5rem; margin-bottom: 1rem;">
      <div style="display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center;">
        <input id="capture-show" type="text" placeholder="Show name (auto-filled)" style="flex:1;min-width:180px;padding:0.75rem;background:rgba(51,65,85,0.5);border:1px solid rgba(212,175,55,0.15);border-radius:8px;color:#F5F5F5;font-family:'Outfit',sans-serif;" />
        <label class="action-btn" for="capture-input" style="margin-top:0;cursor:pointer;display:inline-block;">📷 Take / pick photo</label>
        <input id="capture-input" type="file" accept="image/*" capture="environment" style="display:none;" />
      </div>
      <div id="capture-status" style="margin-top:1rem;font-size:0.9rem;color:#94A3B8;display:none;"></div>
      <div id="capture-result" style="margin-top:1rem;display:none;"></div>
    </div>

    <div class="section-title" style="margin-top:2rem;" data-list-title>Recent leads <span class="badge badge-green" id="leads-count">0</span></div>
    <div id="leads-box" class="empty-state">
      <div class="icon">📇</div>
      <p>No leads yet.<br>Use the camera button above, the Telegram bot, or WhatsApp once approved.</p>
    </div>

    <div class="section-title" style="margin-top:2rem;">AI Insights <span class="badge badge-gold">Gemini</span></div>
    <div id="insights-box" class="empty-state">
      <div class="icon">🤖</div>
      <p>No insights yet.<br>Capture leads via the Telegram bot, then click below for AI analysis.</p>
    </div>
    <button id="insights-btn" class="action-btn" onclick="loadInsights()">✨ Generate AI Insights</button>

    <div class="section-title" style="margin-top:3rem;">Google Sheets <span class="badge badge-green">Live</span></div>
    <div id="sheets-box" class="empty-state">
      <div class="icon">📊</div>
      <p>No sheets yet.<br>Capture your first lead via the Telegram bot — a Google Sheet is created automatically and shared to your email.</p>
    </div>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    const token = localStorage.getItem('dagama_token');
    if (!token) { window.location.href = '/login'; }
    const user = JSON.parse(localStorage.getItem('dagama_user') || '{}');
    if (user.name) {
      document.getElementById('welcome-msg').textContent = 'Welcome back, ' + user.name.split(' ')[0];
      document.getElementById('user-badge').textContent = user.email;
    }

    // Check for payment return
    const params = new URLSearchParams(location.search);
    if (params.get('payment') === 'success') {
      showToast('Payment successful! Your plan is now active.', 'success');
      history.replaceState({}, '', '/dashboard');
    }
    if (params.get('payment') === 'canceled') {
      showToast('Payment canceled.', 'error');
      history.replaceState({}, '', '/dashboard');
    }

    // Load stats + subscription in parallel
    Promise.all([
      fetch('/api/stats', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json()),
      fetch('/api/stripe/status', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json()),
    ]).then(([stats, sub]) => {
      // Stats
      document.getElementById('stat-leads').textContent = stats.leads ?? 0;
      document.getElementById('stat-bot').textContent = stats.bot_connected ? 'Connected' : 'Not connected';
      if (stats.bot_connected) document.getElementById('stat-bot').style.color = '#4ade80';

      // Subscription
      if (sub.active) {
        const remaining = sub.shows_remaining != null ? sub.shows_remaining + ' shows left' : 'Unlimited shows';
        document.getElementById('stat-plan').textContent = sub.label;
        document.getElementById('stat-plan').style.color = '#4ade80';
        document.getElementById('stat-plan-sub').textContent = remaining;

        document.getElementById('sub-section').innerHTML =
          '<div class="plan-banner">' +
            '<div class="plan-banner-info">' +
              '<span style="font-size:1.5rem">✅</span>' +
              '<div><div class="plan-banner-label">' + sub.label + ' — Active</div>' +
              '<div class="plan-banner-sub">' + remaining + '</div></div>' +
            '</div>' +
            '<button class="portal-btn" onclick="openPortal()">Manage Billing →</button>' +
          '</div>';
      } else {
        document.getElementById('stat-plan').textContent = 'No plan';
        document.getElementById('stat-plan-sub').textContent = 'Upgrade to start capturing leads';
        renderUpgradeSection();
      }
    }).catch(() => {
      renderUpgradeSection();
    });

    function renderUpgradeSection() {
      document.getElementById('sub-section').innerHTML =
        '<div class="upgrade-section">' +
          '<h2>Choose Your Plan</h2>' +
          '<p>Select a plan to activate your Telegram bot and start capturing leads.</p>' +
          '<div class="plan-grid">' +
            '<div class="plan-card">' +
              '<div class="plan-name">Single Show</div>' +
              '<div class="plan-price">$49</div>' +
              '<div class="plan-desc">One-time · 1 show</div>' +
              '<button class="plan-btn" onclick="checkout(this, \'single_show\')">Get Started</button>' +
            '</div>' +
            '<div class="plan-card" style="border-color:rgba(212,175,55,0.35)">' +
              '<div class="plan-name">3-Show Pack</div>' +
              '<div class="plan-price">$129</div>' +
              '<div class="plan-desc">One-time · Save $18</div>' +
              '<button class="plan-btn" onclick="checkout(this, \'3_show_pack\')">Get Started</button>' +
            '</div>' +
            '<div class="plan-card">' +
              '<div class="plan-name">Team Plan</div>' +
              '<div class="plan-price">$79</div>' +
              '<div class="plan-desc">Per month · Unlimited</div>' +
              '<button class="plan-btn" onclick="checkout(this, \'team_plan\')">Get Started</button>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    async function checkout(btn, plan) {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const res = await fetch('/api/stripe/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ plan }),
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Failed to start checkout', 'error'); return; }
        window.location.href = data.url;
      } catch (e) {
        showToast('Network error. Please try again.', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Get Started';
      }
    }

    async function openPortal() {
      try {
        const res = await fetch('/api/stripe/portal', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Failed to open portal', 'error'); return; }
        window.location.href = data.url;
      } catch (e) {
        showToast('Network error.', 'error');
      }
    }

    // ── Web capture (BoothBot leads or SourceBot suppliers via /api/upload) ──
    const captureInput  = document.getElementById('capture-input');
    const captureStatus = document.getElementById('capture-status');
    const captureResult = document.getElementById('capture-result');
    const captureShow   = document.getElementById('capture-show');

    // Detect role once on load and re-label the capture/list sections.
    let userRole = 'boothbot';
    fetch('/api/me/role', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json())
      .then(d => {
        userRole = (d && d.role) || 'boothbot';
        if (userRole === 'sourcebot') {
          // SourceBot users capture suppliers, not leads.
          const captureTitle = document.querySelector('[data-capture-title]');
          if (captureTitle) captureTitle.textContent = 'Capture a supplier';
          const listTitle = document.querySelector('[data-list-title]');
          if (listTitle) listTitle.textContent = 'Recent suppliers';
          const empty = document.getElementById('leads-box');
          if (empty) {
            empty.innerHTML = '<div class="icon">🏭</div><p>No suppliers yet.<br>Use the camera button above, the Telegram bot, or WhatsApp once approved.</p>';
          }
          // SourceBot doesn't pick a per-show sheet from the web — show is
          // implicit from the buyer's active pass. Hide the show input.
          if (captureShow) captureShow.style.display = 'none';
        }
        loadList();
      })
      .catch(() => loadList());

    captureInput.addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      ev.target.value = ''; // allow re-selecting the same file
      await uploadCard(file);
    });

    async function uploadCard(file) {
      captureStatus.style.display = 'block';
      captureStatus.textContent = '📤 Uploading ' + file.name + '…';
      captureResult.style.display = 'none';
      captureResult.innerHTML = '';

      const fd = new FormData();
      fd.append('photo', file);
      const showName = (captureShow.value || '').trim();
      if (showName) fd.append('show', showName);

      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) {
          captureStatus.textContent = '⚠️ ' + (data.error || 'Upload failed.');
          return;
        }

        captureStatus.textContent = '🤖 Extracting card details…';
        renderCaptureResult(data);

        if (data.botRole === 'sourcebot') {
          // SourceBot core does Phase 1 + 2 inline (DB + Drive + Sheet append),
          // so a 'success' status is already terminal — no polling needed.
          finalizeStatus(data.status === 'success' ? 'complete' : data.status);
          loadList();
        } else if (data.leadId && data.status !== 'complete' && data.status !== 'image_failed') {
          pollLead(data.leadId);
        } else {
          finalizeStatus(data.status);
          loadList();
        }
      } catch (e) {
        captureStatus.textContent = '⚠️ Network error. Please try again.';
      }
    }

    function renderCaptureResult(data) {
      const c = data.contact || {};
      // For SourceBot the headline is the company; the contact name is secondary.
      const isSourceBot = data.botRole === 'sourcebot';
      const headline = isSourceBot ? (c.company || c.name || 'Unknown') : (c.name || 'Unknown');
      const sub      = isSourceBot ? (c.name && c.name !== headline ? c.name + (c.title ? ' · ' + c.title : '') : (c.title || '')) : ((c.title || '') + (c.title && c.company ? ' · ' : '') + (c.company || ''));
      captureResult.style.display = 'block';
      captureResult.innerHTML =
        '<div style="background:rgba(15,20,25,0.5);border:1px solid rgba(212,175,55,0.15);border-radius:8px;padding:1rem;">' +
          '<div style="font-weight:600;font-size:1.05rem;color:#F5F5F5;margin-bottom:0.4rem;">' + headline + '</div>' +
          (sub       ? '<div style="color:#94A3B8;font-size:0.9rem;">' + sub + '</div>' : '') +
          (c.email   ? '<div style="color:#D4AF37;font-size:0.9rem;margin-top:0.4rem;">📧 ' + c.email + '</div>' : '') +
          (c.phone   ? '<div style="color:#D4AF37;font-size:0.9rem;">📞 ' + c.phone + '</div>' : '') +
          (data.sheetUrl ? '<a href="' + data.sheetUrl + '" target="_blank" style="display:inline-block;margin-top:0.75rem;color:#4ade80;font-size:0.85rem;">Open sheet →</a>' : '') +
        '</div>';
    }

    async function pollLead(leadId) {
      const start = Date.now();
      const tick = async () => {
        if (Date.now() - start > 30000) { finalizeStatus('timeout'); return; }
        try {
          const res = await fetch('/api/leads/' + leadId, { headers: { Authorization: 'Bearer ' + token } });
          const data = await res.json();
          const s = data.lead && data.lead.status;
          if (s === 'complete' || s === 'image_failed') { finalizeStatus(s); loadList(); return; }
        } catch {}
        setTimeout(tick, 1500);
      };
      setTimeout(tick, 1500);
    }

    function finalizeStatus(status) {
      if (status === 'complete')          captureStatus.textContent = '✅ Saved to Google Sheet.';
      else if (status === 'image_failed') captureStatus.textContent = '⚠️ Saved, but Sheet append failed — retry on the row.';
      else if (status === 'timeout')      captureStatus.textContent = '⏳ Still processing — your sheet will update shortly.';
      else                                 captureStatus.textContent = '✅ Saved.';
    }

    async function loadList() {
      const url = userRole === 'sourcebot' ? '/api/suppliers?limit=10' : '/api/leads?limit=10';
      try {
        const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return;
        const data = await res.json();
        const rows = (userRole === 'sourcebot' ? (data.suppliers || []) : (data.leads || []));
        document.getElementById('leads-count').textContent = rows.length;
        document.getElementById('stat-leads').textContent = rows.length;
        const box = document.getElementById('leads-box');
        if (!rows.length) return;
        box.classList.remove('empty-state');
        box.style.textAlign = 'left';
        box.style.padding = '0';
        box.style.border = '1px solid rgba(212,175,55,0.15)';
        box.style.background = 'linear-gradient(135deg, rgba(30,41,59,0.9), rgba(30,41,59,0.6))';
        box.style.borderRadius = '16px';
        box.innerHTML = rows.map(r => userRole === 'sourcebot' ? renderSupplierRow(r) : renderLeadRow(r)).join('');
      } catch {}
    }

    function renderLeadRow(l) {
      const colour = l.status === 'complete' ? '#4ade80' : l.status === 'image_failed' ? '#f87171' : '#D4AF37';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.85rem 1.25rem;border-bottom:1px solid rgba(255,255,255,0.05);">' +
        '<div>' +
          '<div style="font-weight:600;color:#F5F5F5;">' + (l.name || 'Unknown') + (l.company ? ' <span style="color:#94A3B8;font-weight:400">· ' + l.company + '</span>' : '') + '</div>' +
          '<div style="font-size:0.8rem;color:#94A3B8;margin-top:0.15rem;">' + (l.show_name || '') + ' · ' + new Date(l.created_at).toLocaleString() + '</div>' +
        '</div>' +
        '<span style="font-size:0.75rem;color:' + colour + ';text-transform:uppercase;letter-spacing:0.05em;">' + (l.status || '—') + '</span>' +
      '</div>';
    }

    function renderSupplierRow(s) {
      const folderUrl = s.cards_folder_id ? 'https://drive.google.com/drive/folders/' + s.cards_folder_id : null;
      const btnStyle = 'background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.2);color:#D4AF37;border-radius:8px;padding:0.35rem 0.7rem;font-size:0.75rem;font-family:inherit;cursor:pointer;display:inline-block;';
      return '<div style="padding:0.85rem 1.25rem;border-bottom:1px solid rgba(255,255,255,0.05);">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;">' +
          '<div>' +
            '<div style="font-weight:600;color:#F5F5F5;">' + (s.company || 'Unknown') + (s.contact_name ? ' <span style="color:#94A3B8;font-weight:400">· ' + s.contact_name + '</span>' : '') + '</div>' +
            '<div style="font-size:0.8rem;color:#94A3B8;margin-top:0.15rem;">' + (s.show_name || '') + ' · ' + new Date(s.created_at).toLocaleString() + (s.email ? ' · ' + s.email : '') + '</div>' +
          '</div>' +
          (folderUrl ? '<a href="' + folderUrl + '" target="_blank" style="font-size:0.75rem;color:#4ade80;text-transform:uppercase;letter-spacing:0.05em;text-decoration:none;white-space:nowrap;">Folder →</a>' : '') +
        '</div>' +
        '<div style="margin-top:0.65rem;display:flex;gap:0.5rem;flex-wrap:wrap;">' +
          '<label style="' + btnStyle + '">📷 Card back<input type="file" accept="image/*" capture="environment" style="display:none;" onchange="uploadExtension(\'' + s.id + '\', \'card-back\', this)" /></label>' +
          '<label style="' + btnStyle + '">👤 Person photo<input type="file" accept="image/*" capture="environment" style="display:none;" onchange="uploadExtension(\'' + s.id + '\', \'person-photo\', this)" /></label>' +
          '<button type="button" style="' + btnStyle + '" id="voice-btn-' + s.id + '" onclick="toggleVoice(\'' + s.id + '\')">💬 Voice note</button>' +
        '</div>' +
      '</div>';
    }

    // Per-supplier MediaRecorder state. Click to start, click again to stop +
    // upload. Browsers default to webm/opus which Gemini transcribes fine.
    const voiceState = {};
    async function toggleVoice(companyId) {
      const btn = document.getElementById('voice-btn-' + companyId);
      const state = voiceState[companyId];
      if (state && state.recorder && state.recorder.state === 'recording') {
        state.recorder.stop();   // upload happens in onstop handler
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        captureStatus.style.display = 'block';
        captureStatus.textContent = '⚠️ Your browser doesn\\'t support mic recording.';
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        const startTs = Date.now();
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          btn.textContent = '💬 Voice note';
          btn.style.background = 'rgba(212,175,55,0.08)';
          delete voiceState[companyId];
          if (chunks.length === 0) return;
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const duration = (Date.now() - startTs) / 1000;
          await uploadVoice(companyId, blob, duration);
        };
        recorder.start();
        voiceState[companyId] = { recorder, chunks };
        btn.textContent = '⏹ Stop recording';
        btn.style.background = 'rgba(248,113,113,0.15)';
      } catch (e) {
        captureStatus.style.display = 'block';
        captureStatus.textContent = '⚠️ Couldn\\'t start the mic. ' + (e && e.message ? e.message : '');
      }
    }

    async function uploadVoice(companyId, blob, durationSec) {
      captureStatus.style.display = 'block';
      captureStatus.textContent = '📤 Uploading voice note…';
      const fd = new FormData();
      fd.append('audio', blob, 'voice.webm');
      if (Number.isFinite(durationSec)) fd.append('duration', String(Math.round(durationSec)));
      try {
        const res = await fetch('/api/suppliers/' + companyId + '/voice', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) {
          captureStatus.textContent = '⚠️ ' + (data.error || 'Voice upload failed.');
          return;
        }
        const tail = [data.price, data.moq && 'MOQ ' + data.moq, data.leadTime, data.tone].filter(Boolean).join(' · ');
        captureStatus.textContent = '✅ Voice note saved' + (tail ? ' — ' + tail : '');
        loadList();
      } catch (e) {
        captureStatus.textContent = '⚠️ Network error.';
      }
    }

    async function uploadExtension(companyId, kind, inputEl) {
      const file = inputEl.files && inputEl.files[0];
      if (!file) return;
      inputEl.value = '';
      captureStatus.style.display = 'block';
      captureStatus.textContent = '📤 Uploading ' + (kind === 'card-back' ? 'card back' : 'person photo') + '…';
      const fd = new FormData();
      fd.append('photo', file);
      try {
        const res = await fetch('/api/suppliers/' + companyId + '/' + kind, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) {
          captureStatus.textContent = '⚠️ ' + (data.error || 'Upload failed.');
          return;
        }
        captureStatus.textContent = kind === 'person-photo' && data.description
          ? '✅ Saved — ' + data.description
          : '✅ Saved.';
        loadList();
      } catch (e) {
        captureStatus.textContent = '⚠️ Network error.';
      }
    }

    async function loadInsights() {
      const btn = document.getElementById('insights-btn');
      const box = document.getElementById('insights-box');
      btn.textContent = '🤖 Analyzing…'; btn.disabled = true;
      try {
        const res = await fetch('/api/insights', { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json();
        if (!res.ok) {
          box.innerHTML = '<div class="icon">⚠️</div><p>' + (data.error || 'Could not load insights.') + '</p>';
        } else {
          box.style.textAlign = 'left';
          box.innerHTML = '<div style="font-size:0.8rem;text-transform:uppercase;letter-spacing:0.1em;color:#94A3B8;margin-bottom:0.75rem;">📊 ' + data.show + ' — ' + data.lead_count + ' leads</div>' +
            '<p style="color:#F5F5F5;line-height:1.7;white-space:pre-wrap;">' + data.analysis + '</p>';
          document.getElementById('stat-ai').textContent = '1';
        }
      } catch (e) {
        box.innerHTML = '<div class="icon">❌</div><p>Network error. Please try again.</p>';
      } finally {
        btn.textContent = '✨ Generate AI Insights'; btn.disabled = false;
      }
    }

    // Load Google Sheets
    fetch('/api/google/sheets', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json())
      .then(data => {
        if (!data.sheets || !data.sheets.length) return;
        // Pre-fill the capture form's show field with the most recent sheet's show.
        if (captureShow && !captureShow.value) captureShow.value = data.sheets[0].show_name;
        const box = document.getElementById('sheets-box');
        box.style.textAlign = 'left';
        box.style.border = '1px solid rgba(74,222,128,0.2)';
        box.innerHTML = data.sheets.map(s =>
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 0;border-bottom:1px solid rgba(255,255,255,0.05)">' +
            '<div>' +
              '<div style="font-weight:600;color:#F5F5F5">' + s.show_name + '</div>' +
              '<div style="font-size:0.8rem;color:#94A3B8;margin-top:0.15rem">Created ' + new Date(s.created_at).toLocaleDateString() + '</div>' +
            '</div>' +
            '<a href="' + s.sheet_url + '" target="_blank" style="background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);color:#4ade80;border-radius:8px;padding:0.4rem 1rem;font-size:0.85rem;text-decoration:none;font-family:\'Outfit\',sans-serif;font-weight:600">Open Sheet →</a>' +
          '</div>'
        ).join('');
      })
      .catch(() => {});

    function showToast(msg, type) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast ' + type;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 4000);
    }

    function logout() {
      localStorage.removeItem('dagama_token');
      localStorage.removeItem('dagama_user');
      window.location.href = '/';
    }
  </script>
</body>
</html>`;

const ONBOARD_COMPLETE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Complete Setup — DaGama</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: linear-gradient(135deg, #0F1419 0%, #1a2844 100%); color: #F5F5F5; font-family: 'Outfit', sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .container { max-width: 540px; width: 100%; padding: 2.5rem; background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(30,41,59,0.6)); border: 1px solid rgba(212,175,55,0.15); border-radius: 16px; backdrop-filter: blur(20px); box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    h1 { font-family: 'Playfair Display', serif; font-size: 2rem; margin-bottom: 0.5rem; background: linear-gradient(135deg, #F5F5F5, #D4AF37); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; text-align: center; }
    .subtitle { text-align: center; color: #94A3B8; margin-bottom: 2rem; font-size: 0.95rem; }
    .role-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }
    .role { padding: 1.2rem; background: rgba(51,65,85,0.4); border: 1px solid rgba(212,175,55,0.15); border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center; }
    .role:hover { border-color: rgba(212,175,55,0.4); }
    .role.selected { border-color: #D4AF37; background: rgba(212,175,55,0.1); }
    .role-icon { font-size: 2rem; margin-bottom: 0.4rem; }
    .role-name { font-weight: 600; margin-bottom: 0.2rem; }
    .role-desc { font-size: 0.8rem; color: #94A3B8; line-height: 1.4; }
    label { display: block; color: #94A3B8; font-size: 0.85rem; font-weight: 500; margin-bottom: 0.5rem; }
    input { width: 100%; padding: 0.9rem; margin-bottom: 1.5rem; background: rgba(51,65,85,0.5); border: 1px solid rgba(212,175,55,0.15); border-radius: 8px; color: #F5F5F5; font-family: 'Outfit', sans-serif; font-size: 1rem; }
    input:focus { outline: none; border-color: rgba(212,175,55,0.4); }
    button { width: 100%; padding: 1rem; background: linear-gradient(135deg, #D4AF37, #E8C547); color: #0F1419; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.3s ease; font-size: 1rem; }
    button:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(212,175,55,0.3); }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .error { display:none; color:#f87171; background:rgba(248,113,113,0.1); border:1px solid rgba(248,113,113,0.3); border-radius:8px; padding:0.75rem 1rem; margin-bottom:1rem; font-size:0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>One last step</h1>
    <div class="subtitle">Tell us how you'll use DaGama and we'll set up your sheet.</div>
    <div id="error" class="error"></div>

    <label>Which side are you on?</label>
    <div class="role-row">
      <div class="role" data-role="boothbot" onclick="pickRole(this)">
        <div class="role-icon">🎤</div>
        <div class="role-name">BoothBot</div>
        <div class="role-desc">I'm exhibiting — capture buyers at my booth.</div>
      </div>
      <div class="role" data-role="sourcebot" onclick="pickRole(this)">
        <div class="role-icon">📦</div>
        <div class="role-name">SourceBot</div>
        <div class="role-desc">I'm sourcing — capture suppliers and products.</div>
      </div>
    </div>

    <label for="show">Show or event you're attending</label>
    <input id="show" type="text" placeholder='e.g. "Canton Fair 2026"' />

    <button id="btn" onclick="submitForm()">Set up my sheet</button>
  </div>

  <script>
    const token = localStorage.getItem('dagama_token');
    const user  = JSON.parse(localStorage.getItem('dagama_user') || '{}');
    if (!token || !user.id) { window.location.replace('/login'); }

    let selectedRole = null;
    function pickRole(el) {
      document.querySelectorAll('.role').forEach(r => r.classList.remove('selected'));
      el.classList.add('selected');
      selectedRole = el.dataset.role;
    }

    // If the user is already onboarded, skip straight to the dashboard.
    fetch('/api/me/onboarding-status', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json())
      .then(d => { if (d.onboarded) window.location.replace('/dashboard'); })
      .catch(() => {});

    function showError(msg) {
      const e = document.getElementById('error');
      e.textContent = msg; e.style.display = 'block';
    }

    async function submitForm() {
      const show = document.getElementById('show').value.trim();
      const btn = document.getElementById('btn');
      document.getElementById('error').style.display = 'none';
      if (!selectedRole) { showError('Please pick BoothBot or SourceBot.'); return; }
      if (!show) { showError('Please enter your show name.'); return; }

      btn.disabled = true; btn.textContent = 'Setting up…';
      try {
        const res = await fetch('/api/onboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            user_id: user.id,
            email:   user.email,
            name:    user.name,
            role:    selectedRole,
            show_name: show,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          showError(data.error || 'Setup failed. Please try again.');
          btn.disabled = false; btn.textContent = 'Set up my sheet';
          return;
        }
        window.location.replace('/dashboard');
      } catch (e) {
        showError('Network error. Please try again.');
        btn.disabled = false; btn.textContent = 'Set up my sheet';
      }
    }

    document.addEventListener('keydown', e => { if (e.key === 'Enter') submitForm(); });
  </script>
</body>
</html>`;
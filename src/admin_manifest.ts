/// <reference types="@cloudflare/workers-types" />

// Static manifests rendered by the /admin console. Source of truth for:
//   - which env vars / bindings the worker depends on (presence checks)
//   - which HTTP routes the worker exposes (inventory + curl click-through)
//
// When a new secret or route is added elsewhere in the codebase, add it here
// too. The dashboard derives all of its inventory from these constants.

import type { Env } from './types';

export type IntegrationCategory =
  | 'whatsapp'
  | 'telegram'
  | 'google'
  | 'gmail_oauth'
  | 'gemini'
  | 'gcv'
  | 'stripe'
  | 'resend'
  | 'admin'
  | 'runtime'
  | 'bindings';

export interface SecretManifestEntry {
  name: keyof Env | string;        // string fallback for legacy/placeholder vars
  category: IntegrationCategory;
  optional: boolean;
  description: string;
  /**
   * Probe id this secret is part of. Probes are run per integration, not per
   * secret — a probe needs every secret in its group present.
   */
  probe?: ProbeId;
  /** True if this is a binding (D1/R2/Queue), not an env var. */
  binding?: boolean;
}

export type ProbeId =
  | 'gemini'
  | 'gcv'
  | 'google_sa'
  | 'gmail_oauth'
  | 'whatsapp'
  | 'telegram'
  | 'stripe'
  | 'resend'
  | 'd1'
  | 'r2';

export const INTEGRATIONS_MANIFEST: SecretManifestEntry[] = [
  // ── WhatsApp Cloud API (Meta) ──────────────────────────────────────────────
  { name: 'WHATSAPP_VERIFY_TOKEN',      category: 'whatsapp', optional: true,  probe: 'whatsapp', description: 'Webhook subscribe handshake — arbitrary string, echoed during Meta verification' },
  { name: 'WHATSAPP_APP_SECRET',        category: 'whatsapp', optional: true,  probe: 'whatsapp', description: 'Meta App Secret — verifies inbound X-Hub-Signature-256' },
  { name: 'WHATSAPP_ACCESS_TOKEN',      category: 'whatsapp', optional: true,  probe: 'whatsapp', description: 'System User long-lived token for graph.facebook.com' },
  { name: 'WHATSAPP_PHONE_NUMBER_ID',   category: 'whatsapp', optional: true,  probe: 'whatsapp', description: 'Graph API path segment for outbound /messages' },
  { name: 'WHATSAPP_BUSINESS_ACCOUNT_ID', category: 'whatsapp', optional: true, probe: 'whatsapp', description: 'WABA ID for template management + status callbacks' },
  { name: 'WHATSAPP_GRAPH_VERSION',     category: 'whatsapp', optional: true,  description: 'Override Graph API version (default v21.0)' },
  { name: 'WHATSAPP_BOT_NUMBER',        category: 'whatsapp', optional: true,  description: 'Display-only number rendered on the marketing page' },

  // ── Telegram (4 bots) ──────────────────────────────────────────────────────
  { name: 'TELEGRAM_BOT_TOKEN',         category: 'telegram', optional: false, probe: 'telegram', description: 'BoothBot — primary card capture' },
  { name: 'TELEGRAM_BOT_TOKEN_SOURCE',  category: 'telegram', optional: true,  probe: 'telegram', description: 'SourceBot — supplier capture' },
  { name: 'TELEGRAM_BOT_TOKEN_DEMO',    category: 'telegram', optional: true,  probe: 'telegram', description: 'DemoBot — freelancer-facing @DaGamaShow' },
  { name: 'TELEGRAM_BOT_TOKEN_EXPENSE', category: 'telegram', optional: true,  probe: 'telegram', description: 'ExpenseBot — Expedition→Basecamp bridge' },
  { name: 'TELEGRAM_BOT_USERNAME_BOOTH',   category: 'telegram', optional: true, description: 'Deep-link username for BoothBot' },
  { name: 'TELEGRAM_BOT_USERNAME_SOURCE',  category: 'telegram', optional: true, description: 'Deep-link username for SourceBot' },
  { name: 'TELEGRAM_BOT_USERNAME_DEMO',    category: 'telegram', optional: true, description: 'Deep-link username for DemoBot' },
  { name: 'TELEGRAM_BOT_USERNAME_EXPENSE', category: 'telegram', optional: true, description: 'Deep-link username for ExpenseBot' },

  // ── Google service account / Drive / Sheets ────────────────────────────────
  { name: 'GOOGLE_SERVICE_ACCOUNT_EMAIL',        category: 'google', optional: false, probe: 'google_sa', description: 'Service account email used for Drive + Sheets' },
  { name: 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',  category: 'google', optional: false, probe: 'google_sa', description: 'Service account private key (PEM, \\n-escaped)' },
  { name: 'SHARED_DRIVE_ID',                     category: 'google', optional: false, description: 'Shared Drive that owns service-account-created files' },

  // ── Gmail OAuth (per-buyer connection) ─────────────────────────────────────
  { name: 'GMAIL_CLIENT_ID',                category: 'gmail_oauth', optional: false, probe: 'gmail_oauth', description: 'GCP OAuth 2.0 Client ID' },
  { name: 'GMAIL_CLIENT_SECRET',            category: 'gmail_oauth', optional: false, probe: 'gmail_oauth', description: 'GCP OAuth 2.0 Client Secret' },
  { name: 'DAGAMA_NOREPLY_REFRESH_TOKEN',   category: 'gmail_oauth', optional: true,  description: 'Legacy: refresh token for noreply@ transactional sender' },
  { name: 'DAGAMA_NOREPLY_FROM_EMAIL',      category: 'gmail_oauth', optional: true,  description: 'Legacy: from-address for noreply transactional mail' },

  // ── AI / vision ────────────────────────────────────────────────────────────
  { name: 'GEMINI_API_KEY', category: 'gemini', optional: false, probe: 'gemini', description: 'Google Gemini API key (OCR + extraction)' },
  { name: 'GCV_API_KEY',    category: 'gcv',    optional: false, probe: 'gcv',    description: 'Google Cloud Vision API key (DOCUMENT_TEXT_DETECTION)' },

  // ── Stripe ─────────────────────────────────────────────────────────────────
  { name: 'STRIPE_SECRET_KEY',          category: 'stripe', optional: false, probe: 'stripe', description: 'Stripe secret key (sk_live_… or sk_test_…)' },
  { name: 'STRIPE_WEBHOOK_SECRET',      category: 'stripe', optional: false, description: 'Stripe webhook signing secret' },
  { name: 'STRIPE_PRICE_SINGLE_SHOW',   category: 'stripe', optional: false, description: 'Price ID — $49 one-time single show pass' },
  { name: 'STRIPE_PRICE_3_SHOW_PACK',   category: 'stripe', optional: false, description: 'Price ID — $129 one-time 3-show pack' },
  { name: 'STRIPE_PRICE_TEAM_PLAN',     category: 'stripe', optional: false, description: 'Price ID — $79/mo team plan' },
  { name: 'STRIPE_PRICE_ORGANIZER_PLAN',category: 'stripe', optional: true,  description: 'Price ID — $299/mo organizer plan (DemoBot referral tier)' },

  // ── Email (Resend) ─────────────────────────────────────────────────────────
  { name: 'RESEND_API_KEY', category: 'resend', optional: true, probe: 'resend', description: 'Resend API key — falls back to console.log when unset' },

  // ── Admin / runtime ────────────────────────────────────────────────────────
  { name: 'DEMOBOT_ADMIN_TOKEN',      category: 'admin', optional: true,  description: 'Bearer token gating /api/demobot/admin/* and /api/shows-catalog mutations' },
  { name: 'ADMIN_EMAILS',             category: 'admin', optional: false, description: 'Comma-separated allowlist of admin user emails (gates /admin)' },
  { name: 'CF_ACCESS_TEAM_DOMAIN',    category: 'admin', optional: true,  description: 'Cloudflare Zero Trust team domain (e.g. dagama.cloudflareaccess.com) — enables edge MFA' },
  { name: 'CF_ACCESS_AUD_TAG',        category: 'admin', optional: true,  description: 'Cloudflare Access Application AUD tag — Worker rejects requests not signed for this AUD' },
  { name: 'TURNSTILE_SITE_KEY',       category: 'admin', optional: true,  description: 'Cloudflare Turnstile public site key — embedded in /register page' },
  { name: 'TURNSTILE_SECRET_KEY',     category: 'admin', optional: true,  description: 'Cloudflare Turnstile secret — server-side siteverify on /api/auth/register' },
  { name: 'WEBHOOK_SECRET',           category: 'admin', optional: false, description: 'JWT signing key for user sessions — also generic webhook validation' },
  { name: 'ENVIRONMENT',         category: 'runtime', optional: false, description: 'development | production' },
  { name: 'ORIGIN',              category: 'runtime', optional: false, description: 'Public origin (used in OAuth redirects + email links)' },

  // ── Bindings (D1/R2/Queue) ─────────────────────────────────────────────────
  { name: 'DB',         category: 'bindings', optional: false, binding: true, probe: 'd1', description: 'D1 database — dagama' },
  { name: 'R2_BUCKET',  category: 'bindings', optional: false, binding: true, probe: 'r2', description: 'R2 bucket — dagama-cards' },
  { name: 'CARD_QUEUE', category: 'bindings', optional: false, binding: true, description: 'Cloudflare Queue — dagama-card-queue' },
];

export interface IntegrationCard {
  category: IntegrationCategory;
  label: string;
  probe?: ProbeId;
  external_link?: string;            // dashboard URL for the underlying service
}

export const INTEGRATION_CARDS: IntegrationCard[] = [
  { category: 'whatsapp',    label: 'WhatsApp (Meta)',     probe: 'whatsapp',    external_link: 'https://business.facebook.com/wa/manage/' },
  { category: 'telegram',    label: 'Telegram',            probe: 'telegram',    external_link: 'https://t.me/BotFather' },
  { category: 'google',      label: 'Google Drive + Sheets', probe: 'google_sa', external_link: 'https://console.cloud.google.com/iam-admin/serviceaccounts' },
  { category: 'gmail_oauth', label: 'Gmail OAuth',         probe: 'gmail_oauth', external_link: 'https://console.cloud.google.com/apis/credentials' },
  { category: 'gemini',      label: 'Gemini',              probe: 'gemini',      external_link: 'https://makersuite.google.com/app/apikey' },
  { category: 'gcv',         label: 'Google Cloud Vision', probe: 'gcv',         external_link: 'https://console.cloud.google.com/apis/credentials' },
  { category: 'stripe',      label: 'Stripe',              probe: 'stripe',      external_link: 'https://dashboard.stripe.com/apikeys' },
  { category: 'resend',      label: 'Resend',              probe: 'resend',      external_link: 'https://resend.com/domains' },
  { category: 'admin',       label: 'Admin / Auth' },
  { category: 'runtime',     label: 'Runtime' },
  { category: 'bindings',    label: 'Cloudflare bindings (D1/R2/Queue)', probe: 'd1' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Routes manifest. Mirrors src/index.ts route registration. Order/grouping is
// for the UI — not load-bearing. Adding/removing routes here does NOT change
// what the worker actually serves; this is read-only documentation.

export type RouteCategory =
  | 'capture'
  | 'auth'
  | 'telegram'
  | 'whatsapp'
  | 'sourcebot'
  | 'demobot'
  | 'expensebot'
  | 'stripe'
  | 'shows_catalog'
  | 'integrations'
  | 'health'
  | 'admin'
  | 'web_chat'
  | 'ui';

export interface RouteEntry {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                       // exact path or pattern with :placeholders
  category: RouteCategory;
  requires_auth: boolean;             // user JWT (Authorization: Bearer)
  requires_admin?: boolean;           // either ADMIN_EMAILS gate or DEMOBOT_ADMIN_TOKEN
  description: string;
}

export const ROUTES_MANIFEST: RouteEntry[] = [
  // Health
  { method: 'GET',  path: '/api/health', category: 'health', requires_auth: false, description: 'Service health check (D1, R2, Queue, tokens)' },

  // Auth
  { method: 'POST', path: '/api/auth/register', category: 'auth', requires_auth: false, description: 'Email-only signup — sends verification link' },
  { method: 'POST', path: '/api/auth/login',    category: 'auth', requires_auth: false, description: 'Password login → JWT' },
  { method: 'POST', path: '/api/auth/activate', category: 'auth', requires_auth: false, description: 'Verification-link activation (sets password)' },
  { method: 'GET',  path: '/api/me',                  category: 'auth', requires_auth: true,  description: 'Current user' },
  { method: 'GET',  path: '/api/me/role',             category: 'auth', requires_auth: true,  description: 'boothbot | sourcebot' },
  { method: 'GET',  path: '/api/me/onboarding-status',category: 'auth', requires_auth: true,  description: 'Onboarding completion state' },
  { method: 'POST', path: '/api/onboard',             category: 'auth', requires_auth: true,  description: 'Onboarding flow' },
  { method: 'GET',  path: '/api/auth/google',         category: 'auth', requires_auth: false, description: 'Google OAuth start' },
  { method: 'GET',  path: '/api/auth/google/callback',category: 'auth', requires_auth: false, description: 'Google OAuth callback' },

  // Telegram
  { method: 'POST', path: '/api/telegram/webhook', category: 'telegram', requires_auth: false, description: 'BoothBot inbound events (Telegram-signed)' },
  { method: 'POST', path: '/api/telegram/setup',   category: 'telegram', requires_auth: false, description: 'Configure BoothBot webhook URL' },

  // WhatsApp
  { method: 'GET',  path: '/api/whatsapp/webhook', category: 'whatsapp', requires_auth: false, description: 'Subscribe-handshake (hub.challenge echo)' },
  { method: 'POST', path: '/api/whatsapp/webhook', category: 'whatsapp', requires_auth: false, description: 'Inbound events (X-Hub-Signature-256 verified)' },

  // SourceBot
  { method: 'POST', path: '/api/sourcebot/webhook',           category: 'sourcebot', requires_auth: false, description: 'SourceBot inbound (Telegram)' },
  { method: 'POST', path: '/api/sourcebot/setup',             category: 'sourcebot', requires_auth: false, description: 'Configure SourceBot webhook URL' },
  { method: 'POST', path: '/api/sourcebot/admin/reset-buyer', category: 'sourcebot', requires_auth: false, requires_admin: true, description: 'Admin: clear sb_buyers row for a Telegram chat_id' },

  // DemoBot
  { method: 'POST', path: '/api/demobot/webhook',                category: 'demobot', requires_auth: false, description: 'DemoBot inbound (Telegram)' },
  { method: 'POST', path: '/api/demobot/setup',                  category: 'demobot', requires_auth: false, description: 'Configure DemoBot webhook URL' },
  { method: 'POST', path: '/api/demobot/admin/freelancer-token', category: 'demobot', requires_auth: false, requires_admin: true, description: 'Issue Telegram onboarding token for a freelancer' },
  { method: 'POST', path: '/api/demobot/admin/conversion',       category: 'demobot', requires_auth: false, requires_admin: true, description: 'Mark a prospect converted (triggers freelancer comp)' },

  // ExpenseBot
  { method: 'POST', path: '/api/expensebot/webhook', category: 'expensebot', requires_auth: false, description: 'ExpenseBot inbound (Telegram)' },
  { method: 'POST', path: '/api/expensebot/setup',   category: 'expensebot', requires_auth: false, description: 'Configure ExpenseBot webhook URL' },

  // Capture (web third channel) + leads/suppliers
  { method: 'POST', path: '/api/upload',                          category: 'capture', requires_auth: true, description: 'Web card upload (channel-agnostic capture)' },
  { method: 'GET',  path: '/api/leads',                           category: 'capture', requires_auth: true, description: 'List recent leads' },
  { method: 'GET',  path: '/api/leads/:id',                       category: 'capture', requires_auth: true, description: 'Get single lead (poll for processing status)' },
  { method: 'GET',  path: '/api/suppliers',                       category: 'capture', requires_auth: true, description: 'List suppliers (SourceBot users)' },
  { method: 'GET',  path: '/api/suppliers/:id/card-back',         category: 'capture', requires_auth: true, description: 'Attach card-back image' },
  { method: 'GET',  path: '/api/suppliers/:id/person-photo',      category: 'capture', requires_auth: true, description: 'Attach person photo' },
  { method: 'GET',  path: '/api/suppliers/:id/voice',             category: 'capture', requires_auth: true, description: 'Attach voice note + transcribe' },
  { method: 'GET',  path: '/api/suppliers/:id/products',          category: 'capture', requires_auth: true, description: 'List supplier products' },
  { method: 'POST', path: '/api/products/:id',                    category: 'capture', requires_auth: true, description: 'Update product details' },
  { method: 'GET',  path: '/api/suppliers/:id/email-draft',       category: 'capture', requires_auth: true, description: 'Generate follow-up email draft' },
  { method: 'POST', path: '/api/suppliers/:id/email',             category: 'capture', requires_auth: true, description: 'Send follow-up via Gmail OAuth' },
  { method: 'GET',  path: '/api/suppliers/:id/pdf',               category: 'capture', requires_auth: true, description: 'Export single supplier PDF' },
  { method: 'POST', path: '/api/blast',                           category: 'capture', requires_auth: true, description: 'Bulk follow-up to suppliers in a show' },
  { method: 'POST', path: '/api/search',                          category: 'capture', requires_auth: true, description: 'Search across supplier data' },
  { method: 'POST', path: '/api/compare',                         category: 'capture', requires_auth: true, description: 'Compare products across suppliers' },
  { method: 'GET',  path: '/api/show/pdf',                        category: 'capture', requires_auth: true, description: 'Export full show PDF' },

  // Stripe
  { method: 'POST', path: '/api/stripe/checkout', category: 'stripe', requires_auth: true,  description: 'Create checkout session' },
  { method: 'POST', path: '/api/stripe/webhook',  category: 'stripe', requires_auth: false, description: 'Stripe webhook events (signed)' },
  { method: 'POST', path: '/api/stripe/portal',   category: 'stripe', requires_auth: true,  description: 'Billing portal redirect' },
  { method: 'GET',  path: '/api/stripe/status',   category: 'stripe', requires_auth: true,  description: 'Subscription / plan status' },

  // Shows catalog
  { method: 'GET',    path: '/api/shows-catalog',     category: 'shows_catalog', requires_auth: false, description: 'Public list of upcoming shows' },
  { method: 'POST',   path: '/api/shows-catalog',     category: 'shows_catalog', requires_auth: false, requires_admin: true, description: 'Admin: create show' },
  { method: 'PUT',    path: '/api/shows-catalog/:id', category: 'shows_catalog', requires_auth: false, requires_admin: true, description: 'Admin: update show' },
  { method: 'DELETE', path: '/api/shows-catalog/:id', category: 'shows_catalog', requires_auth: false, requires_admin: true, description: 'Admin: delete show' },

  // Integrations
  { method: 'GET',  path: '/api/google/sheets',  category: 'integrations', requires_auth: true,  description: 'List per-user Google Sheets' },
  { method: 'GET',  path: '/api/gmail/callback', category: 'integrations', requires_auth: false, description: 'Gmail OAuth callback (per-buyer)' },
  { method: 'GET',  path: '/api/stats',          category: 'integrations', requires_auth: true,  description: 'User stats (leads count, bot connection)' },
  { method: 'GET',  path: '/api/insights',       category: 'integrations', requires_auth: true,  description: 'Gemini AI insights' },

  // Web chat
  { method: 'POST', path: '/api/chat/start',   category: 'web_chat', requires_auth: false, description: 'Start anonymous web chat session' },
  { method: 'POST', path: '/api/chat/message', category: 'web_chat', requires_auth: false, description: 'Send message in web chat' },
  { method: 'POST', path: '/api/chat/poll',    category: 'web_chat', requires_auth: false, description: 'Poll for replies' },

  // Admin (this console)
  { method: 'GET',   path: '/admin',                       category: 'admin', requires_auth: true, requires_admin: true, description: 'Admin console (HTML)' },
  { method: 'GET',   path: '/api/admin/whoami',            category: 'admin', requires_auth: true, requires_admin: true, description: 'Auth diagnostic — returns email + via (cf_access | user_jwt)' },
  { method: 'GET',   path: '/api/admin/inventory',         category: 'admin', requires_auth: true, requires_admin: true, description: 'Aggregated inventory: secrets + integrations + routes + config' },
  { method: 'GET',   path: '/api/admin/config',            category: 'admin', requires_auth: true, requires_admin: true, description: 'List runtime config rows' },
  { method: 'PATCH', path: '/api/admin/config/:key',       category: 'admin', requires_auth: true, requires_admin: true, description: 'Update a runtime config value (audited)' },
  { method: 'POST',  path: '/api/admin/probe/:integration',category: 'admin', requires_auth: true, requires_admin: true, description: 'Run health probe (60s cooldown per isolate)' },

  // UI pages
  { method: 'GET', path: '/',                  category: 'ui', requires_auth: false, description: 'Marketing landing page' },
  { method: 'GET', path: '/login',             category: 'ui', requires_auth: false, description: 'Login form' },
  { method: 'GET', path: '/register',          category: 'ui', requires_auth: false, description: 'Registration form' },
  { method: 'GET', path: '/dashboard',         category: 'ui', requires_auth: false, description: 'User dashboard (auth gated client-side)' },
  { method: 'GET', path: '/onboard-complete',  category: 'ui', requires_auth: false, description: 'Onboarding completion page' },
  { method: 'GET', path: '/_r2/*',             category: 'ui', requires_auth: false, description: 'Internal R2 pass-through for image transforms' },
];

export const ROUTE_CATEGORY_LABELS: Record<RouteCategory, string> = {
  capture:       'Capture / Leads / Suppliers',
  auth:          'Auth',
  telegram:      'Telegram (BoothBot)',
  whatsapp:      'WhatsApp',
  sourcebot:     'SourceBot',
  demobot:       'DemoBot',
  expensebot:    'ExpenseBot',
  stripe:        'Stripe',
  shows_catalog: 'Shows catalog',
  integrations:  'Integrations',
  health:        'Health',
  admin:         'Admin',
  web_chat:      'Web chat',
  ui:            'UI pages',
};

/**
 * For a category, returns whether every required (non-optional) secret is set
 * in env, plus a count of (set, total).
 */
export function summarizeCategory(env: Env, category: IntegrationCategory): { set: number; total: number; missing_required: string[] } {
  const items = INTEGRATIONS_MANIFEST.filter(s => s.category === category);
  const missing_required: string[] = [];
  let set = 0;
  for (const item of items) {
    const present = isSecretPresent(env, item);
    if (present) set++;
    else if (!item.optional) missing_required.push(String(item.name));
  }
  return { set, total: items.length, missing_required };
}

export function isSecretPresent(env: Env, item: SecretManifestEntry): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = (env as any)[item.name];
  if (item.binding) return val != null;
  return typeof val === 'string' && val.length > 0;
}

/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;                       // BoothBot
  TELEGRAM_BOT_TOKEN_SOURCE?: string;               // SourceBot — optional until set
  TELEGRAM_BOT_TOKEN_DEMO?: string;                 // DemoBot (@DaGamaShow) — freelancer-facing
  TELEGRAM_BOT_USERNAME_BOOTH?: string;             // for deep links (defaults if absent)
  TELEGRAM_BOT_USERNAME_SOURCE?: string;
  TELEGRAM_BOT_USERNAME_DEMO?: string;              // defaults to "DaGamaShow"
  WHATSAPP_BOT_NUMBER?: string;                     // e.g. "+1415..." — empty = "coming soon"
  // ── WhatsApp Cloud API (Meta) ─────────────────────────────────────────────
  // All five must be set together for the channel to activate. If any are
  // missing, /api/whatsapp/webhook returns 503 and outbound sends are no-ops.
  // See src/whatsapp.ts: isWhatsAppEnabled().
  WHATSAPP_VERIFY_TOKEN?: string;                   // arbitrary string we pick; echoed during webhook subscribe
  WHATSAPP_APP_SECRET?: string;                     // Meta App Secret — used to verify X-Hub-Signature-256
  WHATSAPP_ACCESS_TOKEN?: string;                   // System User access token (long-lived) for graph.facebook.com
  WHATSAPP_PHONE_NUMBER_ID?: string;                // graph API path segment — /v.../{phone-number-id}/messages
  WHATSAPP_BUSINESS_ACCOUNT_ID?: string;            // WABA ID — used for template management + status callbacks
  WHATSAPP_GRAPH_VERSION?: string;                  // optional override; defaults to 'v21.0'
  GEMINI_API_KEY: string;
  GCV_API_KEY: string;
  WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
  ORIGIN: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_SINGLE_SHOW: string;
  STRIPE_PRICE_3_SHOW_PACK: string;
  STRIPE_PRICE_TEAM_PLAN: string;
  STRIPE_PRICE_ORGANIZER_PLAN?: string;             // $299/mo — referenced by DemoBot referral commission tier
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  // Shared Drive ID where service-account-owned folders/sheets/photos live.
  // Service accounts on personal GCP projects have 0 GB of personal Drive
  // storage, so all files they create must live in a Shared Drive (which
  // owns the storage instead of the SA). Required for any onboarding/capture
  // flow that uses the service-account token.
  SHARED_DRIVE_ID: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  // Central transactional email — Resend. heydagama.com is the verified
  // sending domain (see memory/dagama_email_infra.md). When RESEND_API_KEY is
  // unset, sendVerificationEmail falls back to console.log so dev still works.
  RESEND_API_KEY?: string;
  // Legacy stubs from the abandoned Gmail-OAuth approach. Kept for now so
  // callers that reference them don't break; remove after migration off.
  DAGAMA_NOREPLY_REFRESH_TOKEN?: string;
  DAGAMA_NOREPLY_FROM_EMAIL?: string;
  // Bearer token gating /api/demobot/admin/* + /api/shows-catalog mutations.
  // Optional in dev (admin endpoints reject if unset). Set in production via wrangler secret.
  DEMOBOT_ADMIN_TOKEN?: string;
  R2_BUCKET: R2Bucket;
  CARD_QUEUE: Queue;
}

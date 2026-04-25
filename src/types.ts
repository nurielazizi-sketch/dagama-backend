/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;                       // BoothBot
  TELEGRAM_BOT_TOKEN_SOURCE?: string;               // SourceBot — optional until set
  TELEGRAM_BOT_USERNAME_BOOTH?: string;             // for deep links (defaults if absent)
  TELEGRAM_BOT_USERNAME_SOURCE?: string;
  WHATSAPP_BOT_NUMBER?: string;                     // e.g. "+1415..." — empty = "coming soon"
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
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  // Central transactional email — once nurielazizi@gmail.com (later noreply@heydagama.com)
  // is OAuth'd, store the refresh token + from-address here. Until then, sendWelcomeEmail logs.
  DAGAMA_NOREPLY_REFRESH_TOKEN?: string;
  DAGAMA_NOREPLY_FROM_EMAIL?: string;
  R2_BUCKET: R2Bucket;
  CARD_QUEUE: Queue;
}

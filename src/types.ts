/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
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
}

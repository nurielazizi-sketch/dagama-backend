# Architecture

DaGama is a single Cloudflare Worker that serves three Telegram bots, a WhatsApp Cloud API webhook, the marketing website, and a thin authenticated dashboard. State is in Cloudflare D1 (SQLite). User-uploaded photos are in R2. Long-running OCR + Gemini work is offloaded to a Cloudflare Queue.

Source: [src/index.ts](../src/index.ts), [wrangler.toml](../wrangler.toml)

---

## Topology

```
┌─────────────┐                ┌────────────────────────────────┐
│  Telegram   │  Webhook ───►  │                                │
│  (3 bots)   │                │                                │
├─────────────┤                │                                │
│  WhatsApp   │  Webhook ───►  │     Cloudflare Worker          │
│  Cloud API  │                │     (dagama-backend-prod)      │
├─────────────┤                │                                │
│   Stripe    │  Webhook ───►  │     Routes:                    │
├─────────────┤                │      /api/auth/*               │
│   Gmail     │  OAuth ────►   │      /api/sourcebot/*          │
│             │  Send ◄────    │      /api/telegram/*           │
├─────────────┤                │      /api/demobot/*            │
│   Google    │  Vision ◄─►    │      /api/whatsapp/*           │
│   Cloud     │  Drive  ◄─►    │      /api/stripe/*             │
│   APIs      │  Sheets ◄─►    │      /api/gmail/callback       │
├─────────────┤                │      /api/onboard              │
│   Gemini    │  REST  ◄───►   │                                │
│   2.5 Flash │                │                                │
└─────────────┘                └──┬──────────┬──────────┬───────┘
                                  │          │          │
                          ┌───────▼──┐  ┌────▼───┐  ┌──▼─────┐
                          │ D1 (SQL) │  │   R2   │  │ Queue  │
                          │  dagama  │  │  cards │  │ card-q │
                          └──────────┘  └────────┘  └────────┘
                                                        │
                                                        ▼
                                                ┌──────────────┐
                                                │ Queue worker │
                                                │ handleProcess│
                                                │     Card     │
                                                └──────────────┘
```

---

## Routing — single worker, multi-tenant

Every entrypoint is one `fetch` handler. Path-based dispatch in `src/index.ts`:

| Route prefix | Owner | Notes |
|---|---|---|
| `/` | website | landing/login/register/dashboard/onboard-complete (HTML constants in `index.ts`) |
| `/api/auth/*` | dashboard | password + Google OAuth signin |
| `/api/me`, `/api/stats`, `/api/insights` | dashboard | bearer-token authed JSON |
| `/api/telegram/webhook` | BoothBot | secret-validated |
| `/api/telegram/setup` | BoothBot | one-shot webhook installer |
| `/api/sourcebot/webhook` | SourceBot | secret-validated, update_id deduped |
| `/api/sourcebot/setup` | SourceBot | one-shot webhook installer |
| `/api/sourcebot/admin/*` | SourceBot | `WEBHOOK_SECRET`-gated reset endpoint |
| `/api/demobot/*` | DemoBot | freelancer + admin endpoints |
| `/api/whatsapp/webhook` | DemoBot WA | Meta Cloud API |
| `/api/stripe/checkout` `/webhook` `/portal` `/status` | billing | Stripe |
| `/api/gmail/callback` | Gmail OAuth | per-user refresh token |
| `/api/auth/google` `/callback` | Google OAuth | dashboard signin |
| `/api/onboard` | onboarding | new buyer → provisions Sheet + Drive folder |
| `/api/google/sheets` | dashboard | list user's sheets |
| `/_r2/<key>` | R2 pass-through | exposes private R2 objects on a same-zone URL so Cloudflare image transforms can fetch them |

---

## Bindings (production)

| Binding | Resource | Source |
|---|---|---|
| `DB` | D1 database `dagama` | `[[env.production.d1_databases]]` |
| `R2_BUCKET` | R2 bucket `dagama-cards` | `[[env.production.r2_buckets]]` |
| `CARD_QUEUE` | Queue producer `dagama-card-queue` | `[[env.production.queues.producers]]` |
| `SHARED_DRIVE_ID` | env var `0AKPcQEYiY_9IUk9PVA` | service-account-owned files live here |
| `ORIGIN` | env var `https://heydagama.com` | used by Stripe success URLs, Gmail OAuth redirect, etc. |
| `TELEGRAM_BOT_USERNAME_DEMO` | env var | used by deeplink builders |

---

## Cron — single hourly tick

`crons = ["0 * * * *"]` fires once an hour. The `scheduled` handler in `src/index.ts` runs:

1. `handleShowPassCron` — BoothBot Show Pass expiry (warn → grace → readonly).
2. `handleSourceBotShowPassCron` — same for SourceBot, plus:
   - hard-purges soft-deleted rows whose 24h grace has elapsed
   - trims the `sb_tg_updates_seen` dedup table (>1h old)
3. `processFunnelQueue` — sends due rows from `email_queue` (welcome / digest_6pm / morning_8am / midday_2pm / post_3d / retarget_4w).

---

## Queue — `dagama-card-queue`

- **Producer** — bot enqueues `process_card` jobs when a Telegram user submits a business card photo and we want OCR/Gemini work off the request hot path.
- **Consumer** — `handleProcessCard` in [src/queue.ts](../src/queue.ts) runs the OCR + Gemini extraction, then writes back to the originating `leads` row.
- DLQ: `dagama-card-dlq` after 3 retries.
- `max_batch_size: 10`, `max_batch_timeout: 30s`.

> **Note:** SourceBot does NOT use the queue today — its `handleSupplierCard` and `handleProductPhoto` run inline against Gemini vision (with parallel SA token fetch). Moving SourceBot to the queue is a roadmap item.

---

## Storage layout

### D1 — `dagama`

19 tables — see [SCHEMA.md](SCHEMA.md). Three logical clusters:

- **Auth + users**: `users`, `subscriptions`, `gmail_tokens`, `onboarding_tokens`, `google_sheets`, `buyer_shows` (BoothBot show passes).
- **BoothBot data**: `leads` (with `sheet_row`, `card_url`, `confirmation_message_id`).
- **SourceBot data**: `sb_buyers`, `sb_buyers_telegram`, `sb_buyer_shows`, `sb_companies`, `sb_contacts`, `sb_products`, `sb_voice_notes`, `sb_emails_sent`, `email_queue`, `events`, `referrals`, `sb_tg_updates_seen`.
- **DemoBot data**: `freelancers`, `prospects`, `demobot_pending_registrations`, `demobot_shows`.

### R2 — `dagama-cards`

Card and product photos — but only when we don't have a Drive home for them. SourceBot uploads directly to user-owned Drive folders via the service account, so R2 is mostly used by BoothBot's auto-cropped lead photos and shared assets like `assets/photo-tip.png`.

### Drive (per-buyer)

For SourceBot, the service account creates a folder structure inside `SHARED_DRIVE_ID`:

```
DaGama Shared Drive (org-owned)
└── DaGama — {Show} ({email})/                 ← buyer's per-show folder
    ├── DaGama — {Show} Supplier list          ← Google Sheet
    └── {Company} — {Month YYYY}/               ← per-supplier folder
        ├── Cards/                              ← business card front + back, person/booth photos
        └── Products/                           ← every product photo
```

The Sheet inherits permissions from the parent folder; the buyer is added as `writer` so they can edit values directly.

---

## Integrations

### Service-account auth (Drive + Sheets)
JWT signed with `crypto.subtle.importKey('pkcs8', ...)` → exchanged for a 1-hour bearer token at `https://oauth2.googleapis.com/token`. See [src/google.ts](../src/google.ts).

### Gemini 2.5 Flash
- Card scan: image → JSON contact fields (`extractContactFromImage`).
- Product scan: image → `{type: 'business_card'|'product', name, description}` so a misclassified card auto-routes.
- Voice transcription + structured extraction: extracts price (normalized to `$5.20`), MOQ, lead time, tone, free-form notes (colors, materials).
- Email drafting: returns structured JSON (greeting / intro / discussed_intro / products[] / ask / closing) which the worker renders to both plain-text and HTML.
- Generic deserialization wrapper: `responseMimeType: 'application/json'`.

### Google Cloud Vision
DOCUMENT_TEXT_DETECTION with derived bbox + rotation hints. Used by BoothBot card scanner ([src/extract.ts](../src/extract.ts)). SourceBot **dropped the OCR step** during development to halve scan latency — Gemini vision now runs alone.

### Stripe
- Checkout sessions for SourceBot per-show plans (`event_49` + future tiers) and BoothBot subscriptions (`single_show`, `3_show_pack`, `team_plan`).
- Webhook is **stripe-signature verified in-worker** with HMAC-SHA256 + 5-min timestamp guard. See [src/stripe.ts](../src/stripe.ts).
- Metadata routes the webhook: `metadata.bot === 'sourcebot'` updates `sb_buyer_shows.paid_plan`; otherwise updates `subscriptions`.

### Gmail (per-user)
OAuth 2.0 Web Application client → user-specific refresh token in `gmail_tokens`. `getValidAccessToken` refreshes on demand. `sendGmailEmail` builds RFC-2822 (multipart/alternative if HTML body provided) and POSTs to Gmail's `users.messages.send`.

### WhatsApp Cloud API
DemoBot's WhatsApp surface — text + image webhooks, with an outbound `sendMessage` helper. See [src/whatsapp.ts](../src/whatsapp.ts) and [src/demobot_wa.ts](../src/demobot_wa.ts).

---

## Webhook hardening

| Surface | Auth | Replay protection |
|---|---|---|
| Telegram (BoothBot) | `X-Telegram-Bot-Api-Secret-Token` = `WEBHOOK_SECRET` | none |
| Telegram (SourceBot) | same | `update_id` deduped via `sb_tg_updates_seen` |
| Stripe | `Stripe-Signature` header HMAC-SHA256 | 5-min timestamp window |
| Admin reset | `X-Admin-Secret` = `WEBHOOK_SECRET` | one-shot endpoint |
| Gmail callback | OAuth state | once-per-token |

---

## Secrets (Workers)

| Secret | Purpose |
|---|---|
| `WEBHOOK_SECRET` | Telegram webhook header validation, admin endpoints |
| `TELEGRAM_BOT_TOKEN` | BoothBot |
| `TELEGRAM_BOT_TOKEN_SOURCE` | SourceBot |
| (DemoBot uses its own bot token in env vars — see DEMOBOT.md) |
| `GEMINI_API_KEY` | Gemini 2.5 Flash |
| `GCV_API_KEY` | Google Cloud Vision (BoothBot only) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `_PRIVATE_KEY` | Drive + Sheets writes |
| `GMAIL_CLIENT_ID` + `_CLIENT_SECRET` | per-user Gmail OAuth |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | billing |
| `DAGAMA_NOREPLY_REFRESH_TOKEN` | (deferred) transactional outbound mail for funnel emails |

---

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy --env production
```

Migrations:
```bash
npx wrangler d1 execute dagama --env production --remote --file=migrations/NNN_name.sql
```

Migrations live in [migrations/](../migrations) and are idempotent. Latest: `019_sb_tg_updates_seen.sql`.

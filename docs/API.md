# API reference

All endpoints are served by the single worker at:

- **Production**: `https://api.heydagama.com` (and `https://heydagama.com` for `/`-rooted UI routes)
- **Local dev**: `http://localhost:8788`

CORS preflight (`OPTIONS *`) returns 204 with `Access-Control-Allow-{Origin: *, Methods: GET POST OPTIONS, Headers: Content-Type Authorization}`.

Source: [src/index.ts](../src/index.ts).

---

## Route inventory (auto-generated)

> The table below is **auto-regenerated** from `src/index.ts` by `npm run docs`. Do not edit by hand — edits will be overwritten by the daily cron. The hand-written sections that follow add auth + body details for each route.

<!-- AUTO:ROUTES:START -->
| Method | Path | Handler |
|---|---|---|
| GET | `/api/health` | `handleHealth` |
| ANY | `/api/auth/register` | `handleRegister` |
| ANY | `/api/auth/login` | `handleLogin` |
| GET | `/api/me` | `handleMe` |
| GET | `/api/stats` | `handleStats` |
| GET | `/api/insights` | `handleInsights` |
| POST | `/api/telegram/webhook` | `handleTelegramWebhook` |
| POST | `/api/telegram/setup` | `handleSetupWebhook` |
| ANY | `/api/stripe/checkout` | `handleCreateCheckout` |
| POST | `/api/stripe/webhook` | `handleStripeWebhook` |
| ANY | `/api/stripe/portal` | `handleBillingPortal` |
| GET | `/api/stripe/status` | `handleSubscriptionStatus` |
| GET | `/api/google/sheets` | `handleGetSheets` |
| GET | `/api/gmail/callback` | `handleGmailCallback` |
| ANY | `/api/onboard` | `handleOnboard` |
| GET | `/api/me/onboarding-status` | `handleOnboardingStatus` |
| ANY | `/api/auth/google` | `handleGoogleAuthStart` |
| GET | `/api/auth/google/callback` | `handleGoogleAuthCallback` |
| POST | `/api/sourcebot/webhook` | `handleSourceBotWebhook` |
| POST | `/api/sourcebot/setup` | `handleSourceBotSetupWebhook` |
| POST | `/api/sourcebot/admin/reset-buyer` | `handleAdminReset` |
| POST | `/api/whatsapp/webhook` | `handleWhatsAppWebhook` |
| ANY | `/api/upload` | `handleWebUpload` |
| ANY | `/api/leads` | `handleListLeads` |
| ANY | `/api/suppliers` | `handleListSuppliers` |
| GET | `/api/me/role` | `handleGetMyRole` |
| POST | `/api/demobot/webhook` | `handleDemoBotWebhook` |
| POST | `/api/demobot/setup` | `handleDemoBotSetupWebhook` |
| ANY | `/api/demobot/admin/freelancer-token` | `handleIssueFreelancerToken` |
| ANY | `/api/demobot/admin/conversion` | `handleMarkConversion` |
| GET | `/api/shows-catalog` | `handleListShows` |
| POST | `/api/shows-catalog` | `handleCreateShow` |
| PUT | `(regex) /^\/api\/shows-catalog\/([a-z0-9-]+` | `handleUpdateShow` |
| DELETE | `(regex) /^\/api\/shows-catalog\/([a-z0-9-]+` | `handleDeleteShow` |
| ANY | `/` | `` |
| ANY | `/login` | `` |
| ANY | `/register` | `` |
| ANY | `/dashboard` | `` |
| ANY | `/onboard-complete` | `` |
<!-- AUTO:ROUTES:END -->

---

## Health

### `GET /api/health`
Cheap pings of D1, R2, queue, both bot tokens, Gemini, and Vision keys. Returns 200 + JSON when all are up; 503 + JSON when any check fails.

```json
{
  "status": "ok|degraded",
  "env": "production",
  "time": "...",
  "checks": { "d1": {"ok": true}, "r2": {"ok": true}, ... }
}
```

---

## Auth + dashboard

| Method | Path | Auth | Body / params | Notes |
|---|---|---|---|---|
| POST | `/api/auth/register` | none | `{email, password, name}` | Creates a `users` row, PBKDF2 hashes pw, returns JWT. |
| POST | `/api/auth/login`    | none | `{email, password}` | Returns JWT. |
| GET  | `/api/me`            | Bearer JWT | — | Current user profile + plan summary. |
| GET  | `/api/stats`         | Bearer JWT | — | Lead counts + activity for dashboard. |
| GET  | `/api/insights`      | Bearer JWT | — | Aggregate insights (top countries, recent trends). |
| GET  | `/api/me/onboarding-status` | Bearer JWT | — | Whether the user has completed Telegram onboarding. |
| GET  | `/api/google/sheets` | Bearer JWT | — | List of `google_sheets` rows for this user. |

### `GET /api/auth/google`
Browser-redirected start of the Google OAuth signin flow.

### `GET /api/auth/google/callback`
Code exchange + JWT mint. Returns an HTML page that posts the JWT back to the dashboard.

---

## Onboarding

### `POST /api/onboard`
The web onboarding form posts here after Stripe success or for free trials. Body:

```json
{
  "email": "buyer@example.com",
  "name": "Nuriel",
  "password": "...",
  "user_id": "<from-google-oauth>",
  "role": "sourcebot|boothbot",
  "show_name": "Canton Fair",
  "referrer_code": "abc12345"
}
```

Effects:
1. Upserts `users` row (password OR Google `user_id`).
2. Creates the per-buyer Drive folder inside `SHARED_DRIVE_ID` and the SourceBot Sheet (or BoothBot Sheet, depending on role).
3. Shares the folder with `email` as `writer`.
4. Inserts `sb_buyers` (sourcebot) or `buyer_shows` (boothbot) row.
5. Mints an `onboarding_tokens` row, expires in 24h.
6. Sends welcome email (HTML template) with a `t.me/<bot>?start=<token>` deeplink.

Returns `{ ok: true, onboarding_token }`.

---

## Telegram bots

Three bot surfaces, identical webhook contract.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/telegram/webhook` | `X-Telegram-Bot-Api-Secret-Token` = `WEBHOOK_SECRET` | BoothBot |
| POST | `/api/telegram/setup`   | none (idempotent) | Body `{ url }` — registers `<url>/api/telegram/webhook` with Telegram |
| POST | `/api/sourcebot/webhook`| same secret + `update_id` dedup | SourceBot |
| POST | `/api/sourcebot/setup`  | none | SourceBot variant |
| POST | `/api/sourcebot/admin/reset-buyer` | `X-Admin-Secret` = `WEBHOOK_SECRET` | Body `{ email }`. Trashes the buyer's Drive folder + sheet, wipes per-buyer D1 rows, re-provisions a fresh sheet + folder, leaves a placeholder show called "Setup". Returns the new sheet/folder ids. |
| POST | `/api/demobot/webhook`  | same secret | DemoBot |
| POST | `/api/demobot/setup`    | none | DemoBot variant |
| POST | `/api/demobot/admin/freelancer-token` | TBD admin auth | Issues a `t.me/<DemoBot>?start=<token>` deeplink for an admin to onboard a freelancer manually. |
| POST | `/api/demobot/admin/conversion` | TBD admin auth | Marks a `demobot_prospects` row as converted to a paid buyer (sets `conversion_buyer_id`). |

---

## WhatsApp

### `GET /api/whatsapp/webhook`
Meta's subscribe-handshake. Validates `hub.verify_token` and echoes `hub.challenge`.

### `POST /api/whatsapp/webhook`
Inbound events — text, image, status updates. The handler:
1. Persists the raw payload to `wa_inbound_messages`.
2. Resolves the sender phone → `(user_id, buyer_id, bot_role)` via `wa_user_mappings`.
3. Routes to the bot-specific WhatsApp adapter (DemoBot today; SourceBot is a roadmap item).

503 if any of the `WHATSAPP_*` secrets are missing.

---

## Stripe

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/stripe/checkout` | Bearer JWT | Body `{ plan: 'single_show'|'3_show_pack'|'team_plan' }`. Creates Checkout session, persists pending `subscriptions` row. Returns `{ url }`. |
| POST | `/api/stripe/webhook`  | `Stripe-Signature` HMAC verified in worker | Routes `checkout.session.completed` (split: `metadata.bot === 'sourcebot'` → updates `sb_buyer_shows.paid_plan`; else → activates `subscriptions`) and `customer.subscription.deleted`. |
| POST | `/api/stripe/portal`   | Bearer JWT | Returns a Customer Portal URL for the user's active subscription. |
| GET  | `/api/stripe/status`   | Bearer JWT | Returns `{active, plan, label, shows_remaining, activated_at, expires_at}`. |

---

## Gmail OAuth (per user)

### `GET /api/gmail/callback`
The redirect target for the user-authorized Google OAuth consent (scope: `gmail.send`). On success, persists `gmail_tokens` row, posts a Telegram confirmation back to the user, returns a styled "✅ Gmail Connected" HTML page.

The OAuth-start URL is built per-user by the bot's `/connectgmail` flow with `state=<chatId>`.

---

## Shows catalog

Dashboard-managed list of trade shows used by:
- DemoBot's `/show` autocomplete
- SourceBot/BoothBot show pickers
- Marketing site (future)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/shows-catalog` | none (public) | Lists all shows. |
| POST | `/api/shows-catalog` | admin | Body `{ name, start_date, end_date, location, industry_focus, ... }`. |
| PUT | `/api/shows-catalog/:id` | admin | Update a show. |
| DELETE | `/api/shows-catalog/:id` | admin | Delete a show. |

---

## R2 pass-through

### `GET /_r2/<key>`
Streams an R2 object from `dagama-cards` over the same zone so Cloudflare Image Transforms can fetch it without exposing direct R2 credentials. `Content-Type` from `httpMetadata`. 404 if missing.

---

## UI (HTML) routes

| Path | Notes |
|---|---|
| `/` | Marketing landing page (currently in "coming soon" mode). |
| `/login` | Email/password + Google OAuth signin. |
| `/register` | Email/password registration. |
| `/dashboard` | Bearer-token-authed dashboard with stats, sheet links, plan status. |
| `/onboard-complete` | Post-Stripe / post-onboarding handoff that redirects to the Telegram deeplink. |

All five HTML responses are inline string constants in `src/index.ts` (the `LANDING_PAGE`, `LOGIN_PAGE`, etc. variables). Design system in [WEBSITE.md](WEBSITE.md).

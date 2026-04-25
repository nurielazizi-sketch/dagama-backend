# DaGama backend — architecture map

One Cloudflare Worker hosts two Telegram bots (BoothBot + SourceBot), the
website at `heydagama.com`, and the API surface used by both. This doc names
the boundaries so changes stay local.

## Module boundaries

```
src/
├─ index.ts            ← HTTP + queue + cron router. Routes by path.
├─ types.ts            ← Env interface (single source of truth)
│
├─ telegram.ts         ← BoothBot Telegram handler (exhibitor side, LIVE)
├─ sourcebot.ts        ← SourceBot Telegram handler (buyer side, LIVE post-deploy)
│
├─ auth.ts             ← /api/auth/register + /api/auth/login (email/password)
├─ google_auth.ts      ← /api/auth/google + callback (Sign-In with Google)
├─ gmail.ts            ← Per-buyer Gmail OAuth for sending emails
├─ onboarding.ts       ← /api/onboard + /api/me/onboarding-status + token consume
├─ stripe.ts           ← Checkout, billing portal, plan webhooks
│
├─ google.ts           ← SHARED service-account JWT, Drive folder + share
├─ extract.ts          ← SHARED OCR + Gemini extraction pipeline
├─ email.ts            ← SHARED welcome email (Gmail send via central account)
├─ sheets.ts           ← BoothBot 19-col sheet helpers
├─ sb_sheets.ts        ← SourceBot 30-col sheet helpers
├─ queue.ts            ← Card processing queue consumer (BoothBot v2 path)
├─ crypto.ts           ← Password hashing + JWT
└─ utils/linkedin.ts   ← LinkedIn URL parsing
```

### Per-bot files own their own:
- Session state (`bot_users.session` for BoothBot, `sb_buyers_telegram.session` for SourceBot)
- Commands and callback handlers
- Show pass cron (`handleShowPassCron` vs `handleSourceBotShowPassCron`)

### Shared modules — change here ripples to many callers:
- `extract.ts` is imported by `telegram.ts`, `queue.ts`, `sourcebot.ts`. **A bug in `runGcvOcr` or `ocrThenExtract` breaks card capture in all three.** Tests/changes here should be done carefully.
- `google.ts` (`getServiceAccountToken`) is imported by `telegram.ts` (sheet writes), `sourcebot.ts` (sheet writes), `onboarding.ts` (sheet creation), `queue.ts` (sheet writes). Same blast radius.
- `gmail.ts` is shared between BoothBot's `/connectgmail` and SourceBot's `/connectgmail`. The OAuth `state` param encodes `botRole` so the callback routes the confirmation to the right bot.
- `email.ts` (welcome mail) is sent at `/api/onboard`, used by both roles. Stub-friendly: logs if `DAGAMA_NOREPLY_REFRESH_TOKEN` isn't set.

## Database tables

| Table | Owner | Notes |
|---|---|---|
| `users` | shared | Web account (email/password or Google OAuth) |
| `subscriptions` | shared | Stripe-managed plan rows |
| `gmail_tokens` | shared | Per-buyer Gmail OAuth (chat_id key works for both bots) |
| `bot_users` | BoothBot | Telegram chat → `users.id` |
| `leads` | BoothBot | One row per scanned business card |
| `buyer_shows` | BoothBot | Show pass + cron state |
| `google_sheets` | BoothBot | The 19-col sheet per (user, show_name); `owner_type` = 'user'\|'service_account' |
| `sb_buyers` | SourceBot | 1:1 sidecar to `users` |
| `sb_buyer_shows` | SourceBot | Show pass with sheet/drive refs |
| `sb_buyers_telegram` | SourceBot | Telegram chat → `sb_buyers.id` |
| `sb_companies` | SourceBot | Suppliers |
| `sb_contacts` | SourceBot | Contacts at suppliers |
| `sb_products` | SourceBot | Products under a supplier |
| `sb_voice_notes` | SourceBot | Voice memos transcribed |
| `sb_emails_sent` | SourceBot | Sent follow-up log |
| `onboarding_tokens` | shared | Bot-agnostic deep-link tokens |

**Naming rule:** new SourceBot tables MUST use `sb_*` prefix. Shared tables stay unprefixed. WhatsApp tables (future) will use `wa_*`.

## Migration order (matters)

```
003_gmail_tokens.sql              gmail_tokens (BoothBot)
004_leads_columns.sql             extra columns on leads
005_lead_message_id.sql           confirmation_message_id on leads
006_buyer_shows.sql               buyer_shows (BoothBot)
007_leads_status.sql              status column on leads
008_sourcebot_schema.sql          sb_buyers, sb_buyer_shows, sb_buyers_telegram, sb_companies, sb_contacts, onboarding_tokens
009_google_sheets_owner_type.sql  owner_type, drive_folder_id, drive_folder_url on google_sheets
010_sb_products.sql               sb_products
011_sb_voice_notes.sql            sb_voice_notes
012_sb_emails_sent.sql            sb_emails_sent
```

The `scripts/deploy.sh` applies them in order and treats "duplicate column" / "table already exists" as success (idempotent).

## Data flow: BoothBot card capture

```
Telegram photo
  → telegram.ts handleCardPhoto
  → extract.ts ocrThenExtract           (GCV OCR → Gemini text-or-image flow)
  → telegram.ts saveLead                (insert leads row, RETURNING id)
    → check google_sheets.owner_type
      ├ 'user'           → gmail.ts getValidAccessToken → user's Gmail OAuth token
      └ 'service_account' → google.ts getServiceAccountToken → service-account JWT
    → sheets.ts appendLeadRow            (chooses token by owner)
    → R2 + cf.image trim+rotate          (in-line crop with bbox)
    → uploadCardPhotoToDrive             (cropped image to Drive)
  → finishLead → confirmation message + LinkedIn button
```

## Data flow: SourceBot card capture

```
Telegram photo (token=TELEGRAM_BOT_TOKEN_SOURCE)
  → sourcebot.ts handleSupplierCard
  → extract.ts ocrThenExtract
  → sb_companies upsert (dedupe by lower(name))
  → google.ts getServiceAccountToken → uploadCardImage to Drive
  → sb_sheets.ts appendSupplierRow
  → sb_companies.sheet_row stored back
  → confirmation buttons: Add product | Voice note | Done
```

## Data flow: signup

```
heydagama.com /register
  ├ Email/password POST /api/onboard with {email,name,password,role,show_name}
  └ Sign in with Google → /api/auth/google → callback → /onboard-complete
       → POST /api/onboard with {user_id (from JWT), email, name, role, show_name}

POST /api/onboard
  → resolve / create user
  → google.ts createDriveFolder + shareDriveItem (service account)
  → sheets.ts createBoothBotSheetInFolder OR sb_sheets.ts createSourceBotSheet
  → persist (sb_buyers + sb_buyer_shows)  OR  (google_sheets + buyer_shows)
  → mint onboarding_tokens row
  → email.ts sendWelcomeEmail (Telegram + WhatsApp deep links)
  → return JWT + sheet/drive URLs
```

## What to be careful about when changing things

| If you change… | What might break |
|---|---|
| `extract.ts` | All three card-capture paths (BoothBot, SourceBot, queue.ts). Manually test one card per bot after. |
| `google.ts` | All sheet writes + Drive uploads + onboarding folder creation. |
| `gmail.ts` `state` format | Both `/connectgmail` flows. Default fallback to `boothbot` keeps old links working. |
| `email.ts` template | New welcome emails on both BoothBot and SourceBot signups. |
| `types.ts` `Env` | Anything that reads it. Adding fields is safe; renaming is breaking. |
| Migrations 003-007 | Could break **live BoothBot** (production). Avoid touching them. |
| Migrations 008-012 | SourceBot only. Safe to add new ones; never edit applied ones. |
| `sheets.ts` BoothBot 19 cols | Breaks legacy BoothBot. New behavior should go via `owner_type`. |
| `sb_sheets.ts` 30 cols | SourceBot only. Adding columns means a migration AND a sheet-template update for new sheets. |

## Conventions

- **Append-only migrations.** Never edit a migration once applied. Add a new one.
- **Tables namespaced by feature.** `sb_*` for SourceBot, `wa_*` for future WhatsApp, unprefixed for genuinely shared tables.
- **Per-bot files for per-bot logic.** Don't add SourceBot logic to `telegram.ts`; don't import `sourcebot.ts` from `telegram.ts`.
- **Side effects in their own modules.** Sheet writes only in `sheets.ts` / `sb_sheets.ts`. Drive in `google.ts` (and one-off in `queue.ts`/`sourcebot.ts` because we already had it). Migrate to `google.ts` if we add more.
- **Defensive shared code.** `extract.ts` and `google.ts` should always validate inputs and fail closed (return null / throw with a clear message), so a malformed Gemini response can't take down a feature it shouldn't.

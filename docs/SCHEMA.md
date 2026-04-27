# D1 schema reference

Database: `dagama` (D1, SQLite). Migrations in [migrations/](../migrations) — every migration is idempotent (`IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`).

> Source of truth is the migrations directory; this file is a denormalized reference grouped by purpose. Run `wrangler d1 execute dagama --command "PRAGMA table_info(<table>)"` for the live shape.

---

## Auth + users (shared)

### `users`
Email/password + Google OAuth dashboard accounts. Stripe-driven plan lookup keys off `user_id`.

| col | type | notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `email` | TEXT | |
| `name` | TEXT | |
| `password_hash` | TEXT | PBKDF2 |
| `role` | TEXT | `user` / `admin` (mig 020) |
| `created_at` | TEXT | |

### `subscriptions`
Stripe-backed plan state.

| col | type |
|---|---|
| `user_id` | TEXT FK → users.id |
| `stripe_customer_id`, `stripe_subscription_id`, `stripe_session_id` | TEXT |
| `plan` | TEXT — `single_show` / `3_show_pack` / `team_plan` |
| `status` | TEXT — `pending` / `active` / `canceled` |
| `shows_remaining`, `activated_at`, `expires_at` | |

### `gmail_tokens`
Per-Telegram-chat Gmail OAuth refresh tokens.

| col | type |
|---|---|
| `id` | TEXT PK uuid |
| `chat_id` | INTEGER UNIQUE |
| `gmail_address`, `access_token`, `refresh_token` | TEXT |
| `token_expiry` | INTEGER unix epoch |

### `onboarding_tokens`
One-shot Telegram deeplink tokens.

| col | type |
|---|---|
| `token` | TEXT PK |
| `user_id` | TEXT FK |
| `bot_role` | TEXT — `boothbot` / `sourcebot` |
| `show_name` | TEXT |
| `expires_at`, `used_at` | INTEGER |

### `google_sheets`
Per-user × per-show sheet binding (BoothBot path; SourceBot uses `sb_buyer_shows`).

| col | type |
|---|---|
| `user_id`, `show_name`, `sheet_id`, `sheet_url` | TEXT |
| `owner_type` | TEXT — `user` / `service_account` |
| `drive_folder_id`, `drive_folder_url` | TEXT |
| UNIQUE `(user_id, show_name)` |

---

## BoothBot

### `leads`
One row per captured business card.

| col | type | notes |
|---|---|---|
| `id` | TEXT PK | |
| `chat_id` | INTEGER | Telegram chat |
| `user_id` | TEXT FK → users | |
| `name`, `title`, `company`, `email`, `phone`, `country`, `website`, `linkedin`, `address` | TEXT | |
| `show_name`, `notes` | TEXT | |
| `card_url` | TEXT | R2 / Drive URL |
| `sheet_row` | INTEGER | row in user's Sheet |
| `confirmation_message_id` | INTEGER | Telegram msg id of saved-lead summary |
| `status` | TEXT default `complete` | |
| `created_at` | TEXT | |

### `buyer_shows`
BoothBot Show Pass.

| col | type |
|---|---|
| `id` | TEXT PK |
| `chat_id` | INTEGER |
| `user_id` | TEXT FK |
| `show_name`, `status` (`active` / `grace` / `readonly`) | TEXT |
| `pass_expires_at`, `grace_period_end`, `first_scan_at` | INTEGER |
| `warning_sent`, `grace_msg_sent`, `lock_msg_sent` | INTEGER 0/1 |

---

## SourceBot

### `sb_buyers`
| col | type |
|---|---|
| `id` | TEXT PK |
| `user_id` | TEXT FK → users — UNIQUE so one user has at most one buyer record |
| `email`, `name`, `language` (`en` default), `plan` (`free` default) | TEXT |
| `active_show_id`, `active_company_id`, `current_show_id` | TEXT |
| `timezone` | TEXT default `UTC` |
| `referral_code` | TEXT UNIQUE |
| `referred_by` | TEXT — `referral_code` of referrer |

### `sb_buyers_telegram`
Telegram chat ↔ buyer mapping.

| col | type |
|---|---|
| `buyer_id` | TEXT FK |
| `telegram_chat_id` | INTEGER UNIQUE |
| `session` | TEXT JSON — current step machine state |

### `sb_buyer_shows`
Per-show pass + plan + counters.

| col | type | notes |
|---|---|---|
| `id` | TEXT PK | |
| `buyer_id` | TEXT FK | |
| `show_name`, `status` | TEXT | UNIQUE (`buyer_id`,`show_name`) |
| `sheet_id`, `sheet_url`, `drive_folder_id`, `drive_folder_url` | TEXT | |
| `duration_days` | INTEGER default 3 | drives 24h vs 10-scan free rule |
| `show_start_date`, `show_end_date` | TEXT | |
| `pass_expires_at`, `grace_period_end` | INTEGER | |
| `first_scan_at`, `free_window_ends_at` | INTEGER | trigger on first scan |
| `free_scans_limit`, `free_scans_used` | INTEGER | |
| `paid_plan`, `paid_at`, `stripe_session_id` | | |
| `total_captures`, `last_capture_at` | INTEGER | |
| `warning_sent`, `grace_msg_sent`, `lock_msg_sent` | INTEGER 0/1 | |

### `sb_companies`
| col | type |
|---|---|
| `id` | TEXT PK |
| `buyer_id`, `show_name`, `name`, `website`, `industry` | TEXT |
| `interest_level` | TEXT — `hot` / `warm` / `cold` |
| `cards_folder_id` | TEXT — per-supplier root Drive folder |
| `cards_subfolder_id`, `products_subfolder_id` | TEXT |
| `confirmation_message_id` | INTEGER |
| `sheet_row` | INTEGER |
| `deleted_at` | INTEGER — 24h soft-delete |
| `created_at`, `updated_at` | TEXT |

### `sb_contacts`
| col | type |
|---|---|
| `id` | TEXT PK |
| `company_id`, `buyer_id`, `show_name` | |
| `name`, `title`, `email`, `phone`, `linkedin_url`, `address` | TEXT |
| `card_front_url`, `card_back_url` | TEXT — Drive |
| `person_photo_url`, `person_description` | TEXT |
| `confirmation_message_id` | INTEGER |
| `deleted_at` | INTEGER |

### `sb_products`
| col | type |
|---|---|
| `id` | TEXT PK |
| `company_id`, `buyer_id`, `show_name` | |
| `name`, `description`, `price`, `moq`, `lead_time`, `tone`, `notes` | TEXT |
| `image_url` | TEXT — Drive |
| `sheet_row` | INTEGER |
| `confirmation_message_id` | INTEGER |
| `deleted_at` | INTEGER |
| `created_at` | TEXT |

### `sb_voice_notes`
Raw transcripts attached to a company; structured fields are merged into `sb_products` via `applyProductDetails`.

### `sb_emails_sent`
Sent + failed follow-ups (BoothBot uses the same table semantics; SourceBot is the primary writer).

| col | type |
|---|---|
| `company_id`, `buyer_id`, `show_name`, `recipient_email` | |
| `subject`, `body` | TEXT |
| `status` | `sent` / `failed` |
| `error_msg` | |
| `sent_at` | TEXT ISO |

### `email_queue`
Funnel-email scheduler.

| col | type |
|---|---|
| `id` | TEXT PK |
| `buyer_id`, `show_id` | TEXT |
| `kind` | TEXT — `welcome` / `digest_6pm` / `morning_8am` / `midday_2pm` / `post_3d` / `retarget_4w` / `custom` |
| `scheduled_at`, `sent_at` | INTEGER |
| `status` | `pending` / `sent` / `skipped` / `failed` |
| `payload_json`, `error` | TEXT |
| `created_at` | TEXT |
| Indexes: `(status, scheduled_at)`, `prospect_id` |

### `events`
Lightweight analytics. Indexes on `(buyer_id, created_at)` + `(event_name, created_at)`.

| col | type |
|---|---|
| `buyer_id`, `show_id`, `event_name` | |
| `properties_json` | TEXT |
| `created_at` | |

### `referrals`
| col | type |
|---|---|
| `id` | TEXT PK |
| `referrer_buyer_id`, `referred_buyer_id`, `referred_email` | TEXT |
| `status` | `pending` / `signed_up` / `paid` / `rewarded` |
| `reward_credited_at` | INTEGER |

### `sb_tg_updates_seen`
Webhook dedup. `update_id` PK; cron trims rows older than 1h.

---

## DemoBot + WhatsApp

### `freelancers` / `demobot_freelancers_telegram`
Freelancer accounts and Telegram link mapping.

### `demobot_prospects`
Prospects scanned at shows.

| col | type |
|---|---|
| `id` | TEXT PK |
| `freelancer_user_id` | TEXT FK |
| `show_id`, `prospect_email`, `prospect_name`, `prospect_company` | TEXT |
| `card_url`, `person_photo_url` | TEXT |
| `voice_note_url`, `voice_transcript` | TEXT |
| `conversion_buyer_id` | TEXT — set when admin marks the prospect as converted |
| `scanned_at` | INTEGER |

### `demobot_freelancer_demos`
Per-day demo counter for freelancer commission tracking. UNIQUE `(freelancer_user_id, day_local)`.

### `demobot_pending_registrations`
Self-serve onboarding state machine — `step` ∈ `awaiting_email` / `awaiting_name`.

### `demobot_shows`
Manually-curated catalog of shows DemoBot freelancers can attach a prospect to. Distinct from `shows_catalog`.

### `shows_catalog`
Dashboard-managed list of trade shows.

### `demobot_tg_updates_seen`
Same dedup as SourceBot but for DemoBot's webhook.

### WhatsApp tables
- `wa_user_mappings` — phone → `(user_id, buyer_id, bot_role)`
- `wa_inbound_messages` — every Meta Cloud API webhook payload, `processed` flag for re-entrancy
- `wa_outbound_messages` — every send call we make
- `wa_message_status` — webhook delivery status updates by `wamid`
- `wa_templates` — approved/sent template metadata
- `wa_media_cache` — keyed by Meta media id; cached blobs for re-send

---

## Migration index

> The table below is **auto-regenerated** from the contents of [migrations/](../migrations) by `npm run docs`. Do not edit by hand — edits will be overwritten by the daily cron.

<!-- AUTO:MIGRATIONS:START -->
| # | File | First-line summary |
|---|---|---|
| 003 | `003_gmail_tokens.sql` | CREATE INDEX IF NOT EXISTS idx_gmail_tokens_chat_id ON gmail_tokens(chat_id) |
| 004 | `004_leads_columns.sql` | ALTER TABLE leads ADD COLUMN phone TEXT |
| 005 | `005_lead_message_id.sql` | ALTER TABLE leads ADD COLUMN confirmation_message_id INTEGER |
| 006 | `006_buyer_shows.sql` | CREATE INDEX IF NOT EXISTS idx_buyer_shows_chat_id ON buyer_shows(chat_id) |
| 007 | `007_leads_status.sql` | ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'complete' |
| 008 | `008_sourcebot_schema.sql` | ───────────────────────────────────────────────────────────────────────────── |
| 009 | `009_google_sheets_owner_type.sql` | Distinguish sheets owned by the service account (new flow, since Apr 2026) |
| 010 | `010_sb_products.sql` | Products captured by buyers, tied to a sb_companies row. |
| 011 | `011_sb_voice_notes.sql` | Voice notes captured for a supplier. Gemini transcribes verbatim and extracts |
| 012 | `012_sb_emails_sent.sql` | Log of follow-up emails sent from SourceBot to suppliers' contact emails. |
| 013 | `013_sb_per_supplier_folder.sql` | Per-supplier Drive folder: every supplier gets its own subfolder named |
| 014 | `014_sb_subfolders_corrections.sql` | Spec-compliant Drive layout: per-supplier folder contains Cards/ and Products/ subfolders. |
| 015 | `015_sb_show_metadata_plans.sql` | Show metadata + plan/scan tracking for SourceBot. |
| 016 | `016_funnel_events.sql` | SourceBot funnel email queue (the conversion engine). |
| 017 | `017_referrals_language.sql` | Referral mechanics. (language column already exists on sb_buyers.) |
| 018 | `018_interest_soft_delete.sql` | Soft-delete columns on companies/contacts/products. interest_level was already |
| 019 | `019_sb_tg_updates_seen.sql` | Telegram retries webhooks on slow responses, which is what was causing |
| 020 | `020_demobot.sql` | ───────────────────────────────────────────────────────────────────────────── |
| 021 | `021_whatsapp.sql` | ───────────────────────────────────────────────────────────────────────────── |
| 022 | `022_demobot_self_serve.sql` | DemoBot self-serve onboarding: a chat starts /start with no token, we |
| 023 | `023_demobot_whatsapp.sql` | DemoBot on WhatsApp — extends wa_user_mappings.bot_role CHECK to include |
| 024 | `024_gmail_buyer_id.sql` | ───────────────────────────────────────────────────────────────────────────── |
| 025 | `025_leads_multichannel.sql` | ───────────────────────────────────────────────────────────────────────────── |
| 026 | `026_expensebot_schema.sql` | ───────────────────────────────────────────────────────────────────────────── |
| 027 | `027_passes_and_web_chat.sql` | ───────────────────────────────────────────────────────────────────────────── |
<!-- AUTO:MIGRATIONS:END -->

### Hand-curated highlights

| # | File | Adds |
|---|---|---|
| 001 | (initial users / leads / google_sheets) | base schema |
| 002 | `gmail_tokens` | per-chat Gmail OAuth |
| 003 | leads enrichment columns | phone, title, website, linkedin, address, country |
| 004 | `leads.sheet_row` | retroactive updates |
| 005 | `leads.confirmation_message_id` | reply-to-update |
| 006 | `buyer_shows` | BoothBot Show Pass |
| 007 | `leads.status` | partial-capture |
| 008 | SourceBot core | `sb_buyers`, `sb_buyer_shows`, `sb_buyers_telegram`, `sb_companies`, `sb_contacts`, `onboarding_tokens` |
| 009 | `google_sheets.owner_type` + folder fields | service-account ownership |
| 010 | `sb_products` | |
| 011 | `sb_voice_notes` | |
| 012 | `sb_emails_sent` | |
| 013 | per-supplier folder | `cards_folder_id`, `sb_products.sheet_row` |
| 014 | subfolders + corrections | `cards_subfolder_id`, `products_subfolder_id`, `confirmation_message_id` (3 tables), `person_photo_url`, `person_description` |
| 015 | show metadata + plans | duration_days, dates, first_scan_at, free_window_ends_at, free_scans_limit, free_scans_used, paid_plan, paid_at, stripe_session_id, total_captures, last_capture_at, sb_buyers.active_company_id, sb_buyers.current_show_id |
| 016 | funnel + events | `email_queue`, `events`, `sb_buyers.timezone` |
| 017 | referrals + language | `sb_buyers.referral_code` (backfilled), `referred_by`, `referrals` table |
| 018 | interest + soft-delete | `sb_companies.interest_level`, `deleted_at` on companies/contacts/products + indexes |
| 019 | webhook dedup | `sb_tg_updates_seen` |
| 020+ | DemoBot + WA + admin role | `users.role`, `shows_catalog`, demobot tables, WhatsApp tables, `demobot_pending_registrations` |

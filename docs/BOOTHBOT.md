# DaGama BoothBot — function reference

BoothBot is the **seller-side** Telegram bot for booth exhibitors at trade shows. It captures buyer leads from business-card photos into a per-user Google Sheet, transcribes voice notes, and sends AI-drafted follow-up emails from the user's Gmail.

Source: [src/telegram.ts](../src/telegram.ts) · [src/queue.ts](../src/queue.ts) · [src/extract.ts](../src/extract.ts) · [src/sheets.ts](../src/sheets.ts) · [src/gmail.ts](../src/gmail.ts)

---

## Capture flow

The flow is a small step machine driven by `session.step`:

`idle` → user sends a photo → `await_show_text` (if no shows yet) or show-picker buttons → `await_card` → scanned + confirmed → `await_note` → lead saved → `idle`.

### 1. Show / event selection
- First photo a user sends opens a button list of their existing shows + "➕ New show / event" + "📌 No specific show".
- "New show" enters `await_show_text`; the next text message becomes the show name and the bot creates a Show Pass (`buyer_shows`) for that show.
- A "pending photo" cache holds the original card image so the user doesn't have to re-send it after picking the show.

### 2. Card scan (`await_card`)
1. User sends business-card photo.
2. `scanBusinessCard` (in `src/extract.ts`) runs Google Cloud Vision OCR + Gemini structured extraction (with vision fallback when OCR is empty).
3. Bot replies with a preview of all extracted fields:
   📛 Name · 💼 Title · 🏢 Company · 📧 Email · 📞 Phone · 🌍 Country · 🌐 Website · 🔗 LinkedIn · 📍 Address.
4. Buttons: **✅ Looks good · 🔄 Retake · 📷 Scan back of card**.
5. "Scan back" stays in `await_card` and merges the second photo's fields into the existing draft (non-empty fields are preserved).

### 3. Voice / text note (`await_note`)
- After "✅ Looks good" the bot asks for an optional note.
- Voice → Gemini transcription → saved as `notes`.
- Text → saved verbatim.
- "⏭️ Skip" finalizes with no note.

### 4. Save (`finishLead`)
- Inserts into `leads` table.
- Uploads the card photo to Drive (auto-cropped + rotated using GCV's bbox + rotation hints).
- Appends a row to the user's Google Sheet (sheet_row stored on the lead for later updates).
- Sends a summary message with **📸 Next card · 📋 My leads · 📊 Google Sheet · 🔍 Find on LinkedIn / 🔗 Update LinkedIn**.
- Stores `confirmation_message_id` on the lead so replies route back to that record (used for retroactive notes).

### 5. Reply-to update
Replying to the saved-lead summary message updates that lead — text becomes additional notes, voice transcribes and merges in.

---

## Slash commands

| Command | Effect |
|---|---|
| `/start` | Welcome. Shows plan/Gmail status + commands list + a card-scanning tips photo. |
| `/cancel` | Reset session to `idle`. |
| `/leads` | Lists the user's 10 most recent leads with show, email, LinkedIn. |
| `/sheet` | Returns a button to open the user's Google Sheet. |
| `/summary` | Gemini analysis across the user's leads (top accounts, top countries, recommended follow-ups). |
| `/help` | Compact command reference. |
| `/status` | Plan + Show Pass status. |
| `/connectgmail` | Gmail OAuth flow so emails go from the user's address. |
| `/followup N` | Drafts (no send) a follow-up to lead #N from `/leads`. |
| `/sendemail N` | Drafts + sends a follow-up to lead #N via Gmail. |
| `/skip` | Used during the LinkedIn-URL paste step to skip without saving. |

---

## Inline buttons + callbacks

| Callback | Effect |
|---|---|
| `new_lead` | Starts a fresh capture (re-enters show picker if needed). |
| `show:<name>` | Activates that show pass; if a pending photo was cached, jumps straight to scan. |
| `new_show` | Enters `await_show_text` to type a new show name. |
| `confirm_lead` | Accepts the scan; advances to `await_note`. |
| `retake_card` | Returns to `await_card` for a re-shoot. |
| `scan_back` | Stays in `await_card`; next photo gets merged into the existing draft. |
| `skip_note` | Saves with no note. |
| `next_card` | Capture another lead in the same show. |
| `view_leads`, `view_sheet` | Re-runs `/leads` / `/sheet`. |
| `li_search:<leadId>` | Builds a pre-filled LinkedIn People search URL from name + company; bot remembers `awaitingLinkedInForLeadId` so the user can paste the profile URL back as the next message. |

All callbacks strip the source message's keyboard on tap to prevent stale double-taps (`stripInlineKeyboard`).

---

## Plan + Show Pass

- **`subscriptions` table** holds the Stripe-driven plan (`single_show`, `3_show_pack`, `team_plan`).
- **`buyer_shows`** is the per-show pass (active / grace / readonly), with `pass_expires_at` and `grace_period_end`.
- `checkSubscription` blocks capture when the user has no active plan; bot replies with a Stripe link.
- `handleShowPassCron` (hourly) fires expiry warnings, transitions to grace, and locks captures after the grace period — same shape as SourceBot's cron but for the BoothBot table.

---

## Lead extraction details

- OCR-first pipeline (`runGcvOcr` → `extractContactFromText`) with **Gemini vision fallback** when OCR is empty or fails.
- Bbox + rotation are derived from GCV word-vertex angles to auto-rotate + crop the saved card image.
- Extracted fields: `name`, `title`, `company`, `email`, `phone`, `website`, `linkedin`, `address`, `country`.
- Country is detected from address, dial code, or website TLD.

## Sheet layout (BoothBot)

- One row per lead written via `appendLeadRow`.
- Columns include name, title, company, email, phone, country, website, LinkedIn, address, show name, notes, card photo (`=IMAGE()`), email status, and timestamps.
- `sheet_row` is stored on `leads.sheet_row` so subsequent updates (LinkedIn URL, email-sent status) write to the right row.

## Email send (Gmail)

- `sendGmailEmail` uses the user's connected Gmail OAuth (refresh-token kept in `gmail_tokens`).
- Plain-text by default; takes an optional HTML body and emits multipart/alternative MIME when present.
- `/sendemail N` builds the draft via Gemini, sends, then writes columns V/W/X/Y on the supplier row (`Email Sent`, `Email Sent At`, `Email Subject`, `Email Status`).
- `sendTransactionalEmail` (a thin wrapper) is reserved for system-driven mail like SourceBot's funnel queue — gracefully no-ops if the env isn't fully set up.

## Schema touched

- `users`, `subscriptions`, `buyer_shows`
- `leads` (with `sheet_row`, `card_url`, `confirmation_message_id`)
- `google_sheets` (per-user / per-show sheet binding, `owner_type` = `user` or `service_account`)
- `gmail_tokens` (OAuth refresh tokens)
- `events` (lightweight analytics — first capture, lead saved, email sent)

## Other plumbing

- **Queue**: `dagama-card-queue` queue offloads OCR + Gemini work. The producer enqueues a `process_card` job from the bot, the consumer (`handleProcessCard` in `src/queue.ts`) writes the result back to the lead row.
- **Webhook secret**: `X-Telegram-Bot-Api-Secret-Token` must equal `env.WEBHOOK_SECRET`.
- **R2 pass-through**: `/_r2/<key>` is exposed so Cloudflare image transforms can fetch private R2 objects (used for the photo-tip image and saved card images).
- **Two bot tokens**: `TELEGRAM_BOT_TOKEN` (BoothBot) and `TELEGRAM_BOT_TOKEN_SOURCE` (SourceBot); each has its own `/api/.../webhook` and `/api/.../setup` routes.

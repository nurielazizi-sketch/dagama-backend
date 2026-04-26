# DaGama DemoBot — function reference

DemoBot is the **freelancer-facing** Telegram + WhatsApp bot used at trade shows for live demos and reseller distribution. A field freelancer scans business cards, the bot generates an instant PDF + sends an email to the prospect, and the freelancer earns commission on conversions.

Source: [src/demobot.ts](../src/demobot.ts) · [src/demobot_core.ts](../src/demobot_core.ts) · [src/demobot_admin.ts](../src/demobot_admin.ts) · [src/demobot_wa.ts](../src/demobot_wa.ts) · [src/whatsapp.ts](../src/whatsapp.ts)

Telegram username: `@DaGaMaDemoBot` (env: `TELEGRAM_BOT_USERNAME_DEMO`).

---

## Who uses it

- **Freelancers** at trade shows (independent reps, students, booth staff who get paid per converted demo).
- Onboarded **two ways**:
  1. **Self-serve** — anyone DMs `/start`. The bot collects email + name and creates a `users` row with role `freelancer`.
  2. **Admin-issued** — admin posts to `/api/demobot/admin/freelancer-token` with a user_id; the response is a `t.me/<bot>?start=<token>` deeplink the admin shares with the freelancer.

---

## Capture flow

1. Freelancer sends a **business card photo**.
2. `runCardScan` ([src/demobot_core.ts](../src/demobot_core.ts)) extracts contact fields via Gemini vision.
3. Bot replies with the parsed fields and three buttons:
   - 📷 **Add person photo** → `awaiting_person_photo` step
   - 🎤 **Add voice note** → `awaiting_voice_note` step
   - ➡️ **Skip — next card** → finalize immediately
4. `insertProspect` writes a `demobot_prospects` row (idempotent on email per freelancer) and `bumpFreelancerDay` increments today's `demobot_freelancer_demos.demos_count`.
5. The bot generates a one-pager PDF (with the card image, person photo if any, voice transcript, freelancer's contact details on the footer) and uploads to Drive.
6. The PDF link is emailed to the prospect via the funnel queue (or directly if `DAGAMA_NOREPLY_REFRESH_TOKEN` is configured), copying the freelancer.

### Active show context
- Each freelancer has an "active show" stored in `demobot_freelancers_telegram.session` JSON (`activeShowName` + `activeShowSetAt`).
- After 14 days of staleness (`SHOW_STALENESS_SEC`) the bot re-prompts: "Which trade show are you at right now?"
- Free-text answer becomes the new `activeShowName`. `/show <name>` overrides it explicitly.

---

## Slash commands

| Command | Effect |
|---|---|
| `/start` (no arg) | Self-serve registration: email → name → asks for active show. If already registered: greets back + checks staleness. |
| `/start <token>` | Admin-issued onboarding (consumes `onboarding_tokens` row with `bot_role='demobot'`). |
| `/show <name>` | Sets the active show. |
| `/show` alone | Same as `/myshow`. |
| `/myshow` | Reports the current active show + when it was set. |
| `/stats` | Today's demos + conversions count from `demobot_freelancer_demos`. |
| `/language <code>` | Overrides email language for the next scan (en, zh-CN, de, ar, …). |
| `/help`, `/menu` | Compact reference. |
| `/cancel`, `/done` | Resets the registration step + session step to idle. |

---

## Inline callbacks

| Callback | Effect |
|---|---|
| `demo_add_person` | Enters `awaiting_person_photo`. Next photo gets attached to the prospect. |
| `demo_add_voice` | Enters `awaiting_voice_note`. Next voice (or text) gets attached + transcribed. |
| `demo_skip_person` | Finalizes the prospect immediately, generates PDF, emails it. |

---

## Pre-registration step machine

DemoBot has its own tiny state machine in `demobot_pending_registrations`:

| `step` | Bot is waiting for | Next |
|---|---|---|
| `awaiting_email` | text email address | validates regex → step = `awaiting_name` |
| `awaiting_name` | text full name (≥2 chars) | creates / updates `users` row, `role='freelancer'`, binds `demobot_freelancers_telegram`, drops the pending row |

Post-registration session step is `awaiting_show_name` and the next free-text becomes the active show.

---

## Admin endpoints

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/demobot/admin/freelancer-token` | `{ user_id }` | Mints a one-shot `onboarding_tokens` row with `bot_role='demobot'`. Returns the deeplink. |
| `POST /api/demobot/admin/conversion` | `{ prospect_id, conversion_buyer_id }` | Marks a `demobot_prospects` row as converted; downstream commission flow keys off this. |
| `GET /api/shows-catalog` (public) | — | Lists shows; DemoBot uses this for show name suggestions. |
| `POST/PUT/DELETE /api/shows-catalog[/id]` | admin | Curate the show catalog. |

---

## WhatsApp surface

DemoBot also listens on Meta's WhatsApp Cloud API (`/api/whatsapp/webhook`):

- Inbound text + image messages route through [src/demobot_wa.ts](../src/demobot_wa.ts) using the same `demobot_core` extraction + persistence functions.
- Outbound sends use [src/whatsapp.ts](../src/whatsapp.ts).
- Phone-to-user mapping lives in `wa_user_mappings` with `bot_role='demobot'`.
- Status updates land in `wa_message_status`; raw inbounds in `wa_inbound_messages`; outbounds in `wa_outbound_messages`.
- Templates registered with Meta are tracked in `wa_templates`.
- Media (Meta media-id keyed) cached in `wa_media_cache` so we can re-send without re-fetching.

503 returned until all `WHATSAPP_*` env secrets are configured.

---

## Plumbing

- **Webhook dedup**: `demobot_tg_updates_seen` (PK `update_id`).
- **Drive folders**: `findChildFolderId` + `uploadJpegToDrive` in [src/demobot_core.ts](../src/demobot_core.ts) — drops PDFs and photos in the freelancer's per-show subfolder.
- **PDF**: Drive's HTML→Doc→PDF conversion (no PDF library). Same approach as SourceBot.
- **Analytics**: `events` table with `event_name='demobot_freelancer_registered'`, `'demobot_card_scanned'`, etc. — feeds the dashboard.

---

## Data model

| Table | Purpose |
|---|---|
| `users` (with `role='freelancer'`) | The freelancer's account. |
| `demobot_freelancers_telegram` | Telegram chat ↔ freelancer mapping; `session` JSON holds active show + step. |
| `demobot_prospects` | Each scanned card — contact fields, card_url, person_photo_url, voice_note_url + transcript, conversion_buyer_id. |
| `demobot_freelancer_demos` | Per-day `(freelancer_user_id, day_local)` counters: demos_count + conversions_count. |
| `demobot_pending_registrations` | Mid-registration state (awaiting_email / awaiting_name). |
| `demobot_shows` | Curated show list (separate from `shows_catalog`). |
| `demobot_tg_updates_seen` | Webhook update_id dedup. |

---

## Roadmap (for DemoBot specifically)

- 🟡 Conversion attribution UI — admin marks `conversion_buyer_id` via the `/conversion` endpoint, but there's no dashboard surface yet.
- ⏳ Commission payout tracking — `demos_count` + `conversions_count` are persisted; the payout calc + history view aren't built.
- ⏳ WhatsApp full feature parity with the Telegram surface — text + photo work, voice and inline buttons not yet.
- ⏳ Multi-language email templates per `/language` override — single English template today.

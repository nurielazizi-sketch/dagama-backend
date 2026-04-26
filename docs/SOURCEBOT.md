# DaGama SourceBot — function reference

SourceBot is the **buyer-side** Telegram bot used at sourcing trade shows (Canton Fair, Yiwu, etc.). It captures suppliers, products, and AI-drafted follow-up emails into a per-buyer Google Sheet + Drive folder.

Source: [src/sourcebot.ts](../src/sourcebot.ts) · [src/sb_sheets.ts](../src/sb_sheets.ts) · [src/funnel.ts](../src/funnel.ts) · [src/pdf.ts](../src/pdf.ts)

---

## Capture flows

### 1. Supplier card → contact + folder
1. User sends a photo of a business card.
2. Gemini 2.5 Flash vision extracts: name, title, company, email, phone, country, website, LinkedIn, address.
3. Bot creates per-supplier Drive folder `{Company} — {Month YYYY}` with `Cards/` and `Products/` subfolders inside the buyer's show folder.
4. Card front uploads to `Cards/`; sb_companies + sb_contacts rows inserted.
5. Suppliers tab gets a new row (cols A–AE) with an `=IMAGE()` for the card and `=HYPERLINK()` for the folder.
6. Bot replies with all extracted fields + buttons: **🔥 Hot / 🌤️ Warm / ❄️ Cold · 📷 Scan back of card · 👤 Person / Booth · 💬 Add details · 🗑️ Delete supplier · 📷 New supplier card · ✅ Done**.
7. Session moves to `awaiting_product_photo` so subsequent photos attach to this supplier.

### 2. Product photo → product row
1. Product photo arrives in `awaiting_product_photo` mode.
2. Gemini classifies the image: if it's actually a **business card**, bot transparently re-routes to the supplier flow.
3. Otherwise: extracts product `name` + `description`, uploads to `Products/`, inserts sb_products, appends a row to the **Products** tab (image, description with WRAP, normalized price/MOQ/lead time placeholders).
4. Bot returns the photo with a `force_reply` caption — replying with text or voice updates *that specific* product (per-product reply linkage via `confirmation_message_id`).

### 3. Voice / text reply → fields filled
- Reply attached to a product photo: Gemini transcribes (voice) + extracts price (normalized to `$5.20` form), MOQ, lead time, tone, and free-form notes (colors, materials). Description is **appended cumulatively** so nothing is lost.
- Reply attached to a supplier or contact confirmation: Gemini extracts which fields the user is correcting (e.g. `phone is +1 415 555 1234`) and updates only those.
- Replies that don't match any saved confirmation get a friendly "couldn't match that — try /supplier or /products" prompt instead of the generic photo nudge.

### 4. Card back / Person-or-Booth photo
- **Scan back of card** → uploads to `Cards/`, fills sheet column O.
- **Person / Booth** → accepts a person, booth, signage, or setup shot. Gemini writes a one-line description; both photo URL and description land in cols AB / AC.

---

## Slash commands

### Lookup
| Command | Effect |
|---|---|
| `/supplier [query]` | Lists suppliers in active show + product counts and sheet link. |
| `/products [query]` | Lists products + price/MOQ/lead time + supplier name. |
| `/find <query>` | Full-text search across companies, contacts, products, voice transcripts. |
| `/compare <product>` | AI ranking across all suppliers offering that product. |
| `/summary` | AI summary of the active show — top suppliers, missing data, recommendations. |

### Action
| Command | Effect |
|---|---|
| `/pending` | Products missing price or MOQ. |
| `/followups` | Suppliers with email but no follow-up sent yet. |
| `/email <supplier>` | Drafts a personal HTML email (greeting / paragraphs / bulleted product list / closing) and sends from your Gmail after a confirm tap. |
| `/blast` | Bulk-sends follow-ups (HTML, multipart) to every uncontacted supplier in the active show. Confirms before firing. |
| `/pdf <supplier>` | Drive's HTML→Doc→PDF pipeline produces a one-pager with photos and details. |
| `/pdfshow` | Full-show PDF recap. |
| `/connectgmail` | OAuth flow for Gmail send-as. |
| `/undo` | Soft-deletes the most recent product (or supplier if no products). 24h grace with an inline ↩️ Undo button; cron purges after. |

### Shows + billing
| Command | Effect |
|---|---|
| `/shows` | Lists the buyer's shows with status, plan, totals. |
| `/switch <name>` | Changes active show. |
| `/newshow <name> [days]` | Registers a new show, inheriting sheet + folder. |
| `/allshows` | Cross-show summary. |
| `/upgrade` (alias `/pay`) | Stripe Checkout for the per-show plan; webhook records `paid_plan`. |

### Account
| Command | Effect |
|---|---|
| `/share` | Referral link `?ref=<referral_code>`. Logs `referral_link_viewed`. |
| `/tutorial` | Quick-start walkthrough. |
| `/language [code]` | Sets preferred language (10 locales). |
| `/done`, `/cancel`, `/clear` | Exit current step / reset session. |
| `/start [token]` | First-time connect via emailed deep-link, or "Welcome back" with sheet link if already linked. |
| `/help`, `/menu` | Full command reference. |

---

## Inline buttons + callbacks

| Callback | Effect | Terminal? |
|---|---|---|
| `interest:hot|warm|cold:<companyId>` | Sets `sb_companies.interest_level` + writes label to sheet col S. | No |
| `card_back:<companyId>` | Enters `awaiting_card_back` step. | No |
| `person_photo:<companyId>` | Enters `awaiting_person_photo` step. | No |
| `add_voice:<companyId>` | Enters `awaiting_voice_note` step with `force_reply`. | No |
| `delete_supplier:<companyId>` | Soft-deletes supplier (+ contacts + products); strikes through sheet row; offers Undo. | No |
| `delete_product:<id>` / `undo_delete_*` | Soft-delete / restore for products + suppliers. | Undo is terminal. |
| `done_capturing`, `new_supplier` | End-of-supplier actions. | **Yes** |
| `email_send:<draftId>`, `email_discard` | Send / discard a drafted email. | **Yes** |
| `blast_send:<show>`, `blast_cancel` | Confirm / cancel `/blast`. | **Yes** |
| `runcmd:<cmd>`, `cmd_dismiss` | Accept / decline a fuzzy-command suggestion. | **Yes** |

Terminal callbacks strip the keyboard so the user can't double-tap; non-terminal callbacks leave the keyboard intact so the user can continue interacting with the same supplier confirmation.

---

## Plan enforcement

- **Paid plan** (`paid_plan` set on `sb_buyer_shows`) → unlimited scans.
- **Free, 3+-day show** → 24-hour unlimited window from the first scan.
- **Free, 2-day show** → 10 scans on Day 1 cap.
- Cron `handleSourceBotShowPassCron` (hourly) transitions `active → grace → readonly`, sends warning + lockout DMs, hard-purges expired soft-deletes (>24h), trims the webhook-dedup table.

## Funnel emails

`scheduleFunnelOnFirstScan` queues 6 emails on first scan (welcome, digest 6pm, morning 8am, midday 2pm, post-3-day, retarget-4-week), idempotent. `processFunnelQueue` runs hourly; HTML templates with skipIfEmpty for digests when the show has no captures.

## Other plumbing

- **Update dedup**: webhook stores `update_id` in `sb_tg_updates_seen`. Telegram retries on slow responses don't fire commands twice.
- **Markdown safety**: `escapeMd` escapes `_*\`[]` in user-supplied names so Telegram markdown parsing doesn't reject the message and silently drop the `confirmation_message_id` mapping.
- **Fuzzy commands**: `nearestKnownCommand` (Levenshtein ≤ 2) suggests `/language` for `/langauge` etc., with Yes / No buttons.
- **Smart photo classification**: `extractProductFromImage` returns `{ type: 'business_card' | 'product' }` so a card sent in product mode is auto-routed.
- **Admin reset**: `POST /api/sourcebot/admin/reset-buyer` (gated by `WEBHOOK_SECRET`) trashes the buyer's Drive assets, wipes per-buyer D1 rows, re-provisions a fresh sheet + folder, leaves one placeholder show "Setup".

## Schema touched (current as of 2026-04-26)

- `sb_buyers`, `sb_buyers_telegram`, `sb_buyer_shows`
- `sb_companies` (incl. `interest_level`, `cards_folder_id`, `cards_subfolder_id`, `products_subfolder_id`, `confirmation_message_id`, `deleted_at`)
- `sb_contacts` (incl. `card_front_url`, `card_back_url`, `person_photo_url`, `person_description`, `confirmation_message_id`, `deleted_at`)
- `sb_products` (incl. `image_url`, `sheet_row`, `confirmation_message_id`, `deleted_at`)
- `sb_voice_notes`, `sb_emails_sent`
- `email_queue`, `events`, `referrals`
- `sb_tg_updates_seen`, `onboarding_tokens`, `gmail_tokens`

## Sheet layout

**Suppliers tab** — 31 columns A–AE: Timestamp · Company · Contact Name · Title · Email · Phone · Phone Country · Website · LinkedIn · Industry · Company Size · Certifications · Geographic Presence · Card Front Photo · Card Back Photo · Products · Price Range · Avg Lead Time · Interest Level · Notes · Voice Note · Email Sent · Email Sent At · Email Subject · Email Status · Reply Received · Reply Content · Person Photo · Person Description · Last Updated · **Folder** (HYPERLINK).

**Products tab** — 11 columns A–K, row height 130px, image col 160px wide, description col 320px with WRAP + top alignment.

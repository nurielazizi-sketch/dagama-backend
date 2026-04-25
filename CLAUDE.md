# CLAUDE.md — DaGama project context

This file is the permanent context for Claude Code sessions on this repo. Read it
top-to-bottom before doing any non-trivial work. It documents the actual, verified
state of the codebase plus the strategic guardrails that should never drift.

---

## 1. What DaGama is

**DaGama is a trade-show intelligence platform** — a two-sided product that helps
people who attend trade shows turn business cards, supplier conversations, and
booth visits into structured, actionable data.

- **Domain:** `heydagama.com` (production worker at `api.heydagama.com`)
- **Brand name:** **DaGama**, named after Vasco da Gama.
- **Tagline:** *"The trade explorer on your show floor."*

Two bots, one Cloudflare Worker, one D1 database, one R2 bucket:

| Bot | Audience | What it captures |
|---|---|---|
| **BoothBot** (live) | Exhibitors / booth staff | Buyer business cards → leads → follow-up emails |
| **SourceBot** (built, awaiting deploy) | Buyers / sourcing teams | Supplier cards + products + voice notes → comparisons + email blasts |

Same backend, separate Telegram bot tokens, separate D1 tables (`leads` vs
`sb_*`), separate sheet schemas (19 cols vs 30 cols).

---

## 2. Tech stack (verified against `package.json` + `wrangler.toml` + `src/`)

- **Runtime:** Cloudflare Workers, TypeScript ES2020 strict mode (`tsconfig.json`)
- **Storage:** Cloudflare D1 (SQLite), R2 (`dagama-cards`), Cloudflare Queues (`dagama-card-queue`)
- **Cron:** hourly trigger sweeps show-pass state machines
- **AI:**
  - **Gemini 2.5 Flash** for vision extraction, voice transcription, comparison/summary, email drafting
  - **Google Cloud Vision** `DOCUMENT_TEXT_DETECTION` for OCR (primary) — Gemini-vision is the fallback
- **Bots:** Telegram Bot API, raw webhook handlers (no `grammy` lib — listed in `package.json` but unused; safe to remove)
- **Google APIs:** Drive (folder + file create + share), Sheets (create/append/update), Gmail (per-user OAuth + central transactional sender)
- **Auth:** email/password (PBKDF2 + JWT, `src/crypto.ts`) + Google Sign-In OAuth (`src/google_auth.ts`)
- **Payments:** Stripe (`src/stripe.ts`) — three live price IDs: `STRIPE_PRICE_SINGLE_SHOW`, `STRIPE_PRICE_3_SHOW_PACK`, `STRIPE_PRICE_TEAM_PLAN`. Pricing changes = swap env vars; do not hardcode prices in code.

For the file-by-file map, module boundaries, and "what changes ripple where",
see `ARCHITECTURE.md`. This file does **not** duplicate that map — read both.

---

## 3. Data model conventions

Tables in production D1 (`dagama` database), grouped by ownership:

| Domain | Tables | Notes |
|---|---|---|
| Shared | `users`, `subscriptions`, `gmail_tokens`, `onboarding_tokens` | `users` for web auth; `gmail_tokens` keyed by Telegram chat_id |
| BoothBot | `bot_users`, `leads`, `buyer_shows`, `google_sheets` | flat `leads` table; `google_sheets.owner_type` distinguishes `'user'` (legacy Gmail-OAuth-owned) from `'service_account'` (new flow) |
| SourceBot | `sb_buyers`, `sb_buyer_shows`, `sb_buyers_telegram`, `sb_companies`, `sb_contacts`, `sb_products`, `sb_voice_notes`, `sb_emails_sent` | normalized hierarchy; SourceBot tables MUST use `sb_*` prefix |

**Naming rules:**

- **`sb_*`** = SourceBot only. Future WhatsApp tables will use **`wa_*`**.
- **Unprefixed** = BoothBot or genuinely shared. Don't add new unprefixed tables unless they're shared across products.
- **Migrations are append-only.** Never edit a migration once applied. `scripts/deploy.sh` is idempotent — adding columns via `ALTER TABLE` is safe; renaming or dropping is dangerous.
- **IDs:** lowercase 32-char hex by default (`lower(hex(randomblob(16)))`). Onboarding tokens use UUID. Don't introduce a third scheme.
- **Timestamps:** `created_at` / `updated_at` as ISO `datetime('now')` strings. Show-pass timing fields (`pass_expires_at`, `grace_period_end`) use Unix seconds (integers) to make arithmetic easy.

---

## 4. Coding standards (inferred from the codebase, follow when adding new code)

- **Imports:** named imports only, single-line per import group, grouped: external → `./types` → other internal modules.
- **Errors:** never silently swallow. `try { ... } catch (e) { console.error('[domain] failure context:', e); }` with a domain tag (`[sourcebot]`, `[gcv]`, `[crop]` etc.). Best-effort side effects (sheet writes, R2 cleanup) catch and log; user-facing operations propagate.
- **Bot replies:** every external-side-effect handler should `await send(...)` *something* back to the user, even on failures. Silent failure on Telegram is a UX bug.
- **D1 prepared statements:** always parameterized (`?` placeholders). Never string-interpolate user input into SQL.
- **`UPDATE ... ORDER BY ... LIMIT 1` is broken in D1** — SQLite doesn't support it. Use `WHERE id = (SELECT id ... ORDER BY ... LIMIT 1)` or pass the id directly.
- **Module boundaries:** per-bot files (`telegram.ts`, `sourcebot.ts`) own their own session, commands, cron. Shared infra (`google.ts`, `extract.ts`, `email.ts`, `crypto.ts`) is single-responsibility and defensive. Don't cross-import bot files.
- **Type-check before assuming success:** `npx tsc --noEmit` is fast and catches almost everything.
- **No console-log spam.** `console.log` for state transitions and OCR/crop diagnostics; `console.error` for unexpected failures.
- **HTML pages:** template strings inline in `src/index.ts`. Each page reads `dagama_token` and `dagama_user` from `localStorage` for auth.

---

## 5. Business constraints (non-negotiable)

These rules existed before the codebase and shape every product decision.
Violations are bugs.

### Data ownership: user data lives in the user's own Google account, never on our servers

- The user's Google Sheet is the system of record for their leads/suppliers.
- Service account creates the sheet, then **shares it with the user as Editor**. The sheet ends up in the user's Google Drive.
- D1 holds operational state (auth, sessions, pass status, sheet-row pointers) — **not the user's primary data**.
- If the user revokes access or deletes the sheet, our copy in D1 is treated as ephemeral; we do not reconstitute their data without consent.

### Language auto-detection drives all subsequent communication

- The first business card scan determines the user's preferred working language (Gemini infers from card content + Telegram `language_code`).
- Future bot messages, follow-up emails, summary text — all default to that language.
- Currently English-only end-to-end; the locale plumbing is on the roadmap (Phase 4 of `IMPLEMENTATION_PLAN.md`).

### GDPR-compliant by design

- No PII stored that we don't operationally need.
- Onboarding tokens expire (24h default).
- All user-data tables (leads, contacts, products, voice notes) cascade-delete on `users` deletion via FK.
- Image storage on R2 is temporary (`tmp/` keys, deleted after Drive upload succeeds).
- Audit log of any ad-platform sync (Phase 6) — opt-in only.

### Freemium model (canonical: SourceBot master spec, **24h free for 3+ day shows, 10 scans on 2-day shows**)

- Pre-paid show passes are the primary product. Free tier is a trial, not a tier.
- 3+ day shows: **24 hours of unlimited scans** from first scan, then paywall.
- 2-day shows: **10 card scans on Day 1 only**. Products + voice unlimited within those 10 cards.
- Sheet stays accessible forever after the pass expires (read-only).
- Post-show: 7 days of full access, then archived to read-only.

### Pricing — what currently sells (drive via env vars, not hardcoded)

| Plan | Price | Stripe env var |
|---|---|---|
| Single Show | **$49** one-time | `STRIPE_PRICE_SINGLE_SHOW` |
| 3-Show Pack | **$129** one-time | `STRIPE_PRICE_3_SHOW_PACK` |
| Team Plan | **$79/month** | `STRIPE_PRICE_TEAM_PLAN` |

**Primary marketing price:** $49/show. **Secondary:** $79/month team plan. Do not lead with monthly pricing for individual exhibitors — it raises perceived commitment for a once-a-quarter use case.

A 5-show pack ($199) and Organizer plan ($299/mo) are **planned** but not in code yet — see `IMPLEMENTATION_PLAN.md` for adding them. New tiers should be added by registering a Stripe price + adding an env var, not by editing pricing logic.

Coupon / promo-code support is **planned** (Phase 1 of `IMPLEMENTATION_PLAN.md`) — designed to plug into the checkout flow and the retargeting audiences in Phase 6.

---

## 6. Brand identity

### Name and lineage

- **DaGama**, capital D, capital G, no space.
- Named after **Vasco da Gama**, the explorer who opened the sea route to India.
  Use exploration-era language sparingly: *navigate*, *chart*, *expedition*, *trade route*. Avoid pirate metaphors.
- Tagline: ***"The trade explorer on your show floor."***

### Visual direction (target — currently in flux)

**The logo and design are not final.** Currently the website uses placeholder
typography (Playfair Display + Outfit) and a 🧭 compass emoji for the logo.
Target visual identity:

- **Palette:** Ink Navy (`#0F1419`) + Warm Gold (`#D4AF37`) — these are already in the CSS, they're the one part that's settled.
- **Typography (target):** Cinzel for display headings, DM Sans for body text, Josefin Sans for accents.
- **Logo (target):** Armillary sphere — a hand-drawn, navigation-instrument silhouette.

Don't update fonts/logo in this codebase until brand assets are finalized. A
Phase 2 task in `IMPLEMENTATION_PLAN.md` covers the migration once finalized.

---

## 7. Product principles

### Zero install

The product runs on chat platforms users already have:

- **Telegram** (live for BoothBot, built for SourceBot)
- **WhatsApp** (planned — Meta Business verification pending; deep-link scaffolding already in welcome emails)
- **Web** (heydagama.com — registration, dashboard, sheet links)

No App Store, no Play Store, no SDK install. A user who has Telegram or
WhatsApp can be capturing leads in under 60 seconds from a tap on the welcome
email link.

### Works at any show — not locked to organizers

- DaGama doesn't need a partnership with HKTDC, Canton Fair, or any organizer.
- Show metadata (name, dates, location) is captured at signup or via QR code.
- Show calendar (Phase 2) lets us *recommend* shows but doesn't require organizer cooperation.
- This is a strategic moat: organizer-locked competitors can't enter shows they don't have a deal with; we can.

### Voice notes are a differentiator (SourceBot)

- A buyer at a noisy booth can't type. They can press-hold and dictate.
- Gemini transcribes verbatim + extracts price/MOQ/lead-time/tone in a single API call.
- This is the feature that turns "another card scanner" into "a tool I bring on-floor."

### Two-sided market with shared infrastructure

- Same Worker, same auth, same Google service account, same Stripe account.
- Tables namespaced by side (`sb_*` for buyers).
- A buyer who later exhibits, or vice versa, can use both bots from the same DaGama account.

---

## 8. What NOT to do

These are anti-patterns and anti-features. They've been deliberately avoided
and re-introducing them would be regressions.

- **Do not store user lead data on our servers as the system of record.** D1 holds operational state; the user's Google Sheet is canonical. If you find yourself building a "leads view" that doesn't pull from their sheet, stop and reconsider.
- **Do not lead with monthly pricing for individual exhibitors.** $49/show is the headline; $79/mo is the secondary upsell for teams.
- **Do not add friction to the first scan.** No tutorial gates, no role pickers, no email confirmation walls between "user signs up" and "user scans their first card." The current flow goes: register → email with sheet link + Telegram link → scan. Don't add steps.
- **Do not ask for permissions you don't immediately need.** Gmail OAuth is requested at the moment a user wants to send their first follow-up email, not at signup.
- **Do not centralize behavior that should stay per-bot.** BoothBot logic stays in `telegram.ts`, SourceBot in `sourcebot.ts`. Shared utilities go in named modules (`extract.ts`, `google.ts`, `email.ts`, `crypto.ts`).
- **Do not edit applied migrations.** Add a new one. Existing production databases will not re-run earlier migrations even if you "fix" them.
- **Do not introduce new shared dependencies casually.** Every entry in `extract.ts` / `google.ts` is a blast-radius hotspot — see the table in `ARCHITECTURE.md`.
- **Do not commit secrets.** All credentials live in `wrangler secret`; the script `scripts/deploy.sh` checks they're set before deploying.

---

## 9. Current implementation state (verified, not aspirational)

**Live in production** (BoothBot only):
- Email/password registration + login (`/api/auth/register`, `/api/auth/login`)
- BoothBot Telegram handler: card capture, GCV+Gemini extraction, R2 + Cloudflare Image Resizing crop with rotation, Drive upload, Sheet append, reply-to-update, LinkedIn assist, follow-up email drafting + sending via Gmail OAuth
- Show-pass state machine + hourly cron sweep
- Stripe checkout for three plans

**Built, awaiting `scripts/deploy.sh`** (depends on migrations 008–012 + `TELEGRAM_BOT_TOKEN_SOURCE` secret):
- SourceBot Telegram handler: supplier card → product capture (multi-step) → voice notes (with keyword extraction) → `/find` `/compare` `/summary` `/email` `/pending` `/connectgmail` `/cancel` `/help`
- Google Sign-In OAuth + onboarding endpoint (`/api/onboard`) creating service-account-owned sheets
- `/api/me/onboarding-status` for the post-OAuth completion page
- `/api/health` for uptime probes
- `/onboard-complete` HTML page

**Not built yet** (scoped in `IMPLEMENTATION_PLAN.md`):
- PostHog instrumentation, attribution survey, Stripe Sigma queries, ChartMogul, weekly six-metric dashboard
- Show calendar + admin dashboard
- User-show association (QR codes, `/switchshow`, `/myshows`, post-paid prompt)
- Lifecycle automation engine (rules engine, state machine, idempotent triggers)
- Email service abstraction (provider-agnostic interface; ready to plug Resend / Loops / Customer.io)
- Ad audience engine (LinkedIn Matched Audiences, Google Customer Match, GDPR consent, kill switch)
- WhatsApp handler (Meta Business verification pending)
- Coupon / promo-code mechanism in Stripe checkout
- 5-show pack and Organizer plan price IDs

For phase-by-phase scoping, acceptance criteria, and ordering, see
`IMPLEMENTATION_PLAN.md`. For the lifecycle messaging spec (every trigger,
every channel, every template) that Phase 4 wires up, see
`LIFECYCLE_RULES.md`.

---

## 10. House style for Claude Code sessions on this repo

- **Always run `npx tsc --noEmit` before declaring a change "done."**
- **Always write the migration file even if you can't apply it.** `scripts/deploy.sh` will pick it up next time someone deploys.
- **When in doubt about whether a feature ripples, consult the "What changes ripple where" table in `ARCHITECTURE.md`.**
- **Read this file plus `ARCHITECTURE.md` at the start of any session that touches more than one file.** Five minutes here saves an hour of debugging later.

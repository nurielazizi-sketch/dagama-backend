# IMPLEMENTATION_PLAN.md — DaGama analytics, calendar, lifecycle, and ads

Phased build spec for the systems that turn DaGama from "a bot that captures
leads" into "a bot that captures leads, knows when each user's next show is,
talks to them on the right channel, and feeds high-intent audiences into
LinkedIn and Google Ads."

Each phase has discrete tasks. Each task should be small enough to complete
in a focused session. Each phase ends with **acceptance criteria** phrased as
testable statements — when those all pass, the phase is done.

Read `CLAUDE.md` and `ARCHITECTURE.md` first. References to file paths,
tables, and env vars in this document match the verified state of the repo.

---

## Phase 1 — Analytics foundation

**Goal:** instrument every meaningful product event so we can answer:
acquisition (where do users come from?), activation (do they scan their first
card?), conversion (do they pay?), retention (do they come back for the next
show?), quality (which leads are real opportunities?).

### Tasks

#### 1.1 — PostHog integration

- Sign up for PostHog Cloud (EU region for GDPR posture).
- Add `POSTHOG_API_KEY` and `POSTHOG_HOST` to `wrangler secret` and `Env` interface in `src/types.ts`.
- Create `src/analytics.ts` exporting `track(eventName, properties, distinctId, env)` that POSTs to PostHog `/capture` with idempotency via `$insert_id`.
- Forward Telegram-side events using `chat_id` as `distinctId`; web events use `users.id`. Add `$set` calls to merge properties on the user.

#### 1.2 — Event taxonomy (~30 events)

Implement these events. Names use snake_case. Group by funnel stage.

| Stage | Event | When it fires | Notes |
|---|---|---|---|
| Acquisition | `landing_viewed` | Web `/` page load | Capture UTM params |
| Acquisition | `signup_started` | `/register` form interacted | |
| Acquisition | `signup_completed` | `users` row inserted | `auth_method` = `password` \| `google` |
| Acquisition | `welcome_email_sent` | `sendWelcomeEmail` returns | |
| Acquisition | `welcome_email_link_clicked` | Bot deep-link consumed | `channel` = `telegram` \| `whatsapp` |
| Activation | `bot_first_message` | First Telegram message from a chat_id | |
| Activation | `onboarding_token_consumed` | `consumeOnboardingToken` succeeds | |
| Activation | `first_card_scanned` | First lead/supplier saved for the user | The activation event |
| Activation | `first_sheet_view` | User clicks a sheet link from email/dashboard | |
| Engagement | `card_scanned` | Every lead/supplier save | `bot` = `boothbot` \| `sourcebot` |
| Engagement | `product_captured` | SourceBot product saved | |
| Engagement | `voice_note_captured` | SourceBot voice transcribed + saved | |
| Engagement | `linkedin_added` | LinkedIn URL saved to a lead | `via` = `reply` \| `button` |
| Engagement | `email_sent_to_lead` | Follow-up email sent (BoothBot or SourceBot) | |
| Engagement | `gmail_oauth_started` | `/connectgmail` URL opened | |
| Engagement | `gmail_oauth_completed` | `gmail_tokens` row written | |
| Conversion | `checkout_started` | Stripe checkout session created | `plan` |
| Conversion | `checkout_completed` | Stripe `checkout.session.completed` webhook | `plan`, `revenue_usd` |
| Conversion | `subscription_renewed` | Stripe `invoice.paid` webhook | |
| Conversion | `subscription_canceled` | Stripe `customer.subscription.deleted` webhook | |
| Conversion | `coupon_redeemed` | Stripe checkout session completes with coupon | `coupon_code`, `discount_pct` |
| Retention | `pass_warning_sent` | Cron T+90h warning fired | |
| Retention | `pass_grace_entered` | Pass status flips to `grace` | |
| Retention | `pass_locked` | Pass status flips to `readonly` | |
| Retention | `next_show_added` | User adds a future show via `/myshows` or post-paid prompt | |
| Retention | `next_show_attended` | First scan at a previously-registered upcoming show | The retention event |
| Quality | `summary_generated` | `/summary` invoked | |
| Quality | `compare_invoked` | `/compare` invoked | |
| Quality | `find_invoked` | `/find` invoked | |
| Quality | `feedback_submitted` | NPS or exit survey submitted | `score` |

#### 1.3 — UTM discipline on every link

- Every welcome-email button, every social link, every dashboard CTA carries `utm_source`, `utm_medium`, `utm_campaign`, and where applicable `utm_content`.
- Add a helper `appendUtm(url, source, medium, campaign, content?)` in `src/utils/utm.ts`. All link-generating code must go through it.

#### 1.4 — Self-reported attribution survey

- Trigger one-question modal on the dashboard immediately after **first paid checkout completes**.
- Question: *"How did you first hear about DaGama?"*
- Options (single-select): Friend / colleague · Trade-show contact · LinkedIn · Google · Newsletter / blog · Other
- Store as `users.acquisition_source` (string column, migration). Send to PostHog as `acquisition_source` user property.
- Skip is allowed; record `skipped_attribution`.

#### 1.5 — Stripe Sigma queries

Set up these saved queries in Stripe Sigma (no code change — Stripe-side):
- Daily revenue by plan
- New paid customers / day
- Churn cohort (subscriptions canceled / month)
- Coupon redemption rate
- Refund rate

Document the query SQL in `docs/sigma-queries.sql` so they're versioned.

#### 1.6 — ChartMogul integration

- Connect Stripe → ChartMogul (no code in this repo; configuration in ChartMogul UI).
- Verify it's reporting MRR, ARR, customer count, ARPU, churn correctly.
- Document the ChartMogul login + which dashboard maps to which board metric.

#### 1.7 — Coupon / promo-code mechanism

- Stripe coupons created via Stripe Dashboard (or programmatically — out of scope for Phase 1).
- Update `handleCreateCheckout` in `src/stripe.ts` to accept an optional `coupon` parameter from the frontend and pass it through as `discounts: [{ coupon }]` on the checkout session.
- Add admin endpoint `POST /api/admin/coupon` (auth-gated) to mint Stripe coupons via the Stripe API and tag them with a campaign label.
- PostHog `coupon_redeemed` event fires from the `checkout.session.completed` webhook, including the coupon ID and discount percent.
- Coupon tagging conventions documented inline (e.g. `RETARGET_30D` for a 30-day retargeting offer, `REFERRAL_<code>` for referral rewards) — Phase 6 references these tags.

#### 1.8 — Weekly six-metric dashboard

A single page (admin auth) showing six numbers updated weekly:

1. **Sign-ups this week** — `signup_completed` count
2. **Activation rate** — `first_card_scanned` / `signup_completed` (lagged by 7 days)
3. **Paid conversions this week** — `checkout_completed` count
4. **MRR** — from ChartMogul API
5. **Active paid users** — distinct users with active subscription
6. **Net new users at upcoming shows** — count of `user_upcoming_shows` rows added this week

Implementation: a new API endpoint `GET /api/admin/metrics/weekly` that aggregates from D1 + PostHog; admin HTML page renders the six tiles.

### Acceptance criteria

- [ ] Every event in §1.2 fires with the correct properties when its trigger condition is met (verified by checking PostHog).
- [ ] Every outbound link from an email or HTML page includes UTM params (verified by grep + manual click test).
- [ ] First-paid users see the attribution survey modal exactly once; their answer (or skip) is stored on `users.acquisition_source`.
- [ ] Stripe Sigma has all five saved queries; each returns non-empty results after a test transaction.
- [ ] ChartMogul shows correct MRR within 24h of a test subscription.
- [ ] Applying a Stripe coupon at checkout reduces the price; the `coupon_redeemed` event fires with the right `coupon_code`.
- [ ] `/api/admin/metrics/weekly` returns all six numbers and the dashboard renders them.

---

## Phase 2 — Show calendar and admin dashboard

**Goal:** know which trade shows exist, when, where, who attends. The calendar
is the spine that Phases 3, 4, and 6 hang off of.

### Tasks

#### 2.1 — `shows` table migration

```sql
CREATE TABLE shows (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name                  TEXT NOT NULL,
  start_date            TEXT NOT NULL,         -- ISO YYYY-MM-DD
  end_date              TEXT NOT NULL,
  venue                 TEXT,
  city                  TEXT,
  country               TEXT NOT NULL,
  timezone              TEXT NOT NULL,
  organizer             TEXT,
  industry_tags         TEXT,                  -- JSON array: ["electronics","gifts"]
  languages_expected    TEXT,                  -- JSON array of ISO codes
  tier                  TEXT NOT NULL DEFAULT 'C',  -- 'A' | 'B' | 'C'
  attendance_estimate   INTEGER,
  status                TEXT NOT NULL DEFAULT 'planned',  -- 'planned' | 'live' | 'completed' | 'archived' | 'canceled'
  parent_show_id        TEXT,                  -- multi-phase shows (e.g. Canton Fair phases)
  phase_number          INTEGER,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_shows_status_dates ON shows(status, start_date);
CREATE INDEX idx_shows_country      ON shows(country);
```

Migration file: `migrations/013_shows.sql`.

#### 2.2 — Admin dashboard scaffold

- New HTML page at `/admin` (auth-gated; only specific user emails allowed via `ADMIN_EMAILS` env var, comma-separated).
- Reuse the same JWT auth as the existing dashboard; `requireAdmin` middleware in `src/auth.ts`.
- Tabs (top-level nav): **Calendar** · **Shows** · **Users** · **Audiences** · **Metrics** · **Settings**

#### 2.3 — Calendar grid view (`/admin/calendar`)

- Month grid (28-31 cells), each cell shows shows starting in that day.
- Color-coded by tier (A/B/C).
- Click a cell → show detail page.
- Filters: by country, by industry tag, by status.
- Default view: current month + next 3 months.

#### 2.4 — Show detail page (`/admin/shows/:id`)

Three tabs:

- **Show Info** — read/edit core fields (name, dates, venue, organizer, industry tags, etc.). Edits PATCH to `/api/admin/shows/:id`.
- **Operations** — assigned freelancers (Phase 2.6), QR code preview (Phase 3), pre-show checklist.
- **Performance** — count of registered users for this show, count of users who scanned at this show, conversion rate, top countries, lead/supplier counts. Pulls from PostHog + D1.

#### 2.5 — Quick-add modal (90-second goal)

- Floating "+ Add show" button on `/admin/calendar`.
- Modal with required fields only: name, start_date, end_date, country. Everything else can be filled later.
- One-click duplicates of common templates (Canton Fair phases, IFA Berlin, CES, etc.) — admin-curated list.

#### 2.6 — Bulk operations

- **Clone show** — copies a show row, increments year, blanks status to `'planned'`.
- **Archive** — sets `status = 'archived'`. No row deletion.
- **Export** — downloads shows + their `user_upcoming_shows` membership as CSV.
- **Freelancer assignment** — assigns one or more `users` (with role `'freelancer'`) to a show. Add `users.role` column in this phase if not already present.

#### 2.7 — Filters and search

- `/admin/shows` table view: full-text search on name + city + organizer.
- Server-side filtering: `?country=`, `?status=`, `?industry=`, `?from=YYYY-MM-DD`, `?to=YYYY-MM-DD`.

#### 2.8 — Six-tile summary view

`/admin` (root) shows six top tiles:

1. Active shows (status = 'live')
2. Upcoming shows in next 30 days
3. Total users this month
4. Total scans this week
5. Paid conversions this week
6. MRR (from ChartMogul or fallback to Stripe)

Below the tiles: two lists side-by-side — "Upcoming shows (next 14 days)" and "Recently completed shows (last 14 days)".

### Acceptance criteria

- [ ] Migration 013 applied successfully in production.
- [ ] An admin can create a new show via the Quick-add modal in under 90 seconds.
- [ ] Calendar grid renders correctly for the current month + 3 ahead.
- [ ] Show detail page renders all three tabs and Performance tab pulls live data.
- [ ] Clone, archive, export, freelancer-assign all work and persist.
- [ ] Non-admin users get 403 on `/admin/*` routes.

---

## Phase 3 — User-show association

**Goal:** every captured lead is linked to a show. Detection is automatic
where possible (QR code), self-service where necessary (dropdown), and
explicitly tracked for upcoming shows so Phase 4 can pre-warn users.

### Tasks

#### 3.1 — QR-embedded show ID — primary detection

- URL pattern: `https://t.me/DaGamaBoothBot?start=show_<show_id>` (and `?start=show_<show_id>__fl_<freelancer_id>` when a freelancer-attribution code is present).
- The bot's `/start` handler parses the prefix (`show_`, `fl_`) from the existing `consumeOnboardingToken` machinery. Show-prefixed deep links don't go through `onboarding_tokens` — they're parsed inline.
- On parse, set the user's active show via `buyer_shows.show_name` (BoothBot) or `sb_buyer_shows.show_name` (SourceBot) — match by `shows.name` from the new table.
- Generate the QR code on `/admin/shows/:id` Operations tab — PNG download + printable PDF with a "Scan to start capturing leads at {show.name}" header.
- Track `freelancer_attribution_id` on `users` for revenue-share reporting.

#### 3.2 — Self-select fallback

- When a user starts the bot without a show ID in the deep link AND has no active pass, present a dropdown:

  ```
  Which show are you at?
    🟢 LIVE — IFA Berlin (your country, today)
    🟢 LIVE — Canton Fair Phase 2 (China, today)
    🟢 LIVE — CES Las Vegas (US, today)
    ⚫ I'm not at a show right now
  ```

- Smart sort:
  1. Live shows in user's country (timezone match)
  2. Live shows globally (status = 'live')
  3. "Not at a show" escape hatch
- User selection updates the active show pass row. If "not at a show," prompts them to type the show name (legacy fallback).

#### 3.3 — `/switchshow` command

- Telegram command available on both bots.
- Lists user's currently-active passes (multi-show buyers at co-located events).
- Tapping switches the active show; subsequent scans go to the new show's sheet.

#### 3.4 — Post-first-payment "what shows next" prompt

- Triggered immediately after `checkout_completed` for plans that aren't single-show (i.e. 3-pack, team, future 5-pack/organizer).
- Web modal on dashboard return + Telegram message.
- Multi-select list filtered by:
  - User's industry (inferred from cards captured so far)
  - User's region (inferred from country detected on first card)
- Default-on suggestions; user can deselect.
- Escape hatch: **"I'll add later"** button — sets `users.next_show_prompt_dismissed_at` to now.
- 90-day re-prompt logic: if dismissed and no `user_upcoming_shows` row added since, prompt again 90 days later.

#### 3.5 — `/myshows` command

- Telegram command + dashboard widget.
- Shows the user's `user_upcoming_shows` list with status (planned, attended, skipped, canceled).
- Allows add (search + select from `shows`) and remove.

#### 3.6 — `user_upcoming_shows` table

```sql
CREATE TABLE user_upcoming_shows (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id     TEXT NOT NULL REFERENCES shows(id),
  status      TEXT NOT NULL DEFAULT 'planned',  -- 'planned' | 'attended' | 'skipped' | 'canceled'
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, show_id)
);
CREATE INDEX idx_user_upcoming_shows_user ON user_upcoming_shows(user_id);
CREATE INDEX idx_user_upcoming_shows_show ON user_upcoming_shows(show_id);
```

Migration file: `migrations/014_user_upcoming_shows.sql`.

#### 3.7 — Auto-status updates

A daily cron job (separate from the show-pass cron) does the following:

- For every `user_upcoming_shows` row with `status='planned'` and the show's `end_date < today`:
  - If the user scanned at least one card at that show during its dates → set `status='attended'`
  - Otherwise → set `status='skipped'`
- For shows that get `status='canceled'` in the `shows` table, propagate that to `user_upcoming_shows`.

### Acceptance criteria

- [ ] Scanning a QR code with `?start=show_<show_id>` lands the user with that show pre-selected (verified by the bot's first message confirming the show).
- [ ] Bot session has a freelancer_id when QR includes one; `users.freelancer_attribution_id` is populated.
- [ ] Self-select dropdown sorts live-in-country first, live-globally second.
- [ ] `/switchshow` lists all the user's active passes.
- [ ] After paying for a 3-pack, a non-single-show user sees the multi-select prompt with at least 3 industry-relevant suggestions.
- [ ] `/myshows` reflects edits immediately.
- [ ] When a show's end_date passes, `user_upcoming_shows.status` updates to `attended` or `skipped` within 24 hours.

---

## Phase 4 — Lifecycle automation engine

**Goal:** the right message on the right channel at the right time, every
time, without anyone hand-running it. State machine evaluates user state
against the show calendar and fires triggers. Templates live in
`LIFECYCLE_RULES.md`.

### Tasks

#### 4.1 — Rules engine

- `src/lifecycle.ts` exports `evaluateUser(userId, env): Promise<TriggerFired[]>`.
- For a given user, computes their current lifecycle state:
  - `pre_show` — they have an upcoming show in `user_upcoming_shows` within 7 days
  - `during_show` — they have a show pass currently active
  - `post_show` — their last show pass expired in the last 30 days
  - `dormant` — last activity > 30 days ago and no upcoming show
  - `pre_next_show` — already in `pre_show`, used for ad audience differentiation
- Then matches the state against rules in `LIFECYCLE_RULES.md` and returns a list of `TriggerFired` records.

#### 4.2 — State machine transitions

Implement a state machine where each user is in exactly one primary state at
any time. State is derived (not stored) for freshness; cached in
`users.computed_state` with `users.computed_state_at` timestamp for query
performance, refreshed on each `evaluateUser` call.

```
new → pre_show          (added an upcoming show, today < show.start_date - 7d)
pre_show → during_show  (today >= show.start_date)
during_show → post_show (today > show.end_date)
post_show → dormant     (no activity for 30 days post-show)
dormant → pre_next_show (added another upcoming show)
any → canceled          (subscription canceled, sub-state)
```

#### 4.3 — Trigger evaluation cron

Run hourly (extend the existing cron in `src/index.ts`):

- Iterate over users whose `computed_state` is stale (>1 hour) OR who have a recent activity event.
- Call `evaluateUser`.
- For each trigger fired, route through §4.4.

#### 4.4 — Channel routing

A trigger record has a `preferred_channel` from `LIFECYCLE_RULES.md`. The
router applies:

1. If `preferred_channel === 'email'` AND user has a verified email → send via `EmailService` (Phase 5).
2. If `preferred_channel === 'telegram'` AND user has a `bot_users` or `sb_buyers_telegram` mapping → send via the right bot.
3. If `preferred_channel === 'whatsapp'` AND user has WhatsApp linked → send via WhatsApp (when Phase WhatsApp lands).
4. If `preferred_channel === 'in_product'` → enqueue to `in_product_nudges` table; the dashboard surfaces it on next visit.
5. If `preferred_channel === 'ad_audience'` → add user to the named segment via Phase 6 sync.

Fallback: if the preferred channel isn't available, fall back to email; if no email, drop.

#### 4.5 — Idempotency and deduplication

- Add `lifecycle_triggers_fired` table:

  ```sql
  CREATE TABLE lifecycle_triggers_fired (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id      TEXT NOT NULL,         -- maps to LIFECYCLE_RULES.md rule IDs
    show_id      TEXT,                  -- nullable for non-show-bound triggers
    channel      TEXT NOT NULL,
    fired_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, rule_id, show_id)
  );
  ```

- Before firing any trigger, the engine SELECTs from this table; if a row already exists for `(user_id, rule_id, show_id)`, it skips.
- For recurring triggers (e.g. weekly NPS), the rule definition includes a `cooldown_days` and the engine checks `fired_at < now - cooldown_days`.

Migration file: `migrations/015_lifecycle_triggers.sql`.

#### 4.6 — Admin trigger preview / replay

`/admin/lifecycle` page lets an admin:

- Pick a user and view their computed state + which rules would fire right now.
- Replay a trigger (force-fire it again, ignoring idempotency) — for testing copy changes without waiting.
- View global stats: triggers fired per rule per week, conversion rate per rule (defined by the rule's success metric in `LIFECYCLE_RULES.md`).

### Acceptance criteria

- [ ] Migration 015 applied.
- [ ] `evaluateUser(userId, env)` returns the right trigger list for at least 5 hand-built test cases (one per primary state).
- [ ] Hourly cron fires the engine; PostHog `pass_warning_sent` and other lifecycle events appear when expected.
- [ ] Same user does not receive the same `(rule_id, show_id)` trigger twice.
- [ ] Channel routing falls back to email when the preferred channel is unavailable.
- [ ] Admin trigger preview correctly reports which rules would fire for any given user.

---

## Phase 5 — Email service abstraction layer

**Goal:** swap email providers without touching feature code. We currently
hand-roll Gmail-API sends from a central account; that works for transactional
welcome emails but not for high-volume lifecycle email and segment-based
campaigns. This phase lays the seam.

### Tasks

#### 5.1 — `EmailService` interface

In `src/email_service.ts`:

```ts
export interface EmailService {
  // Transactional, one-off (welcome, password reset, receipt)
  sendTransactional(args: {
    to: string;
    toName?: string;
    templateId: string;        // 'welcome_boothbot', 'password_reset', etc.
    variables: Record<string, string>;
    metadata?: Record<string, string>;
  }): Promise<{ messageId: string }>;

  // Lifecycle event — provider's automation engine handles timing/throttling.
  // For providers without automation (e.g. Resend), this maps to sendTransactional.
  triggerLifecycleEvent(args: {
    userId: string;
    eventName: string;         // matches lifecycle rule IDs
    properties: Record<string, unknown>;
  }): Promise<void>;

  // Segment / audience management for campaigns and retargeting feeds
  addToSegment(args:    { userId: string; segmentId: string }): Promise<void>;
  removeFromSegment(args:{ userId: string; segmentId: string }): Promise<void>;
}
```

#### 5.2 — Dev-mode logging implementation

`src/email_service.ts` exports a default `LoggingEmailService` that just
`console.log`s the call with all arguments. Used in dev and as a fallback when
no provider is configured.

#### 5.3 — Templates as files (not inline strings)

- Create `src/email_templates/` directory.
- One `.ts` file per template, each exporting `{ subject, html, text }` functions that take a `variables` object.
- Templates referenced by `templateId` (the filename without `.ts`).
- Move the existing `renderWelcomeEmail` from `src/email.ts` into `src/email_templates/welcome_boothbot.ts` and `src/email_templates/welcome_sourcebot.ts`.

#### 5.4 — Provider plug-in points

- `src/email_providers/loops.ts`, `src/email_providers/customerio.ts`, `src/email_providers/resend.ts` — each implements the `EmailService` interface but is empty / TODO until we pick.
- Selector in `src/email_service.ts`:

  ```ts
  export function getEmailService(env: Env): EmailService {
    switch (env.EMAIL_PROVIDER) {
      case 'loops':       return new LoopsEmailService(env);
      case 'customerio':  return new CustomerIoEmailService(env);
      case 'resend':      return new ResendEmailService(env);
      default:            return new LoggingEmailService();
    }
  }
  ```

- Add `EMAIL_PROVIDER` and provider-specific env vars to `Env` interface as optional.

#### 5.5 — Feature code rewrite

- Replace direct uses of `sendWelcomeEmail` / Gmail-API code in non-user-Gmail paths with `getEmailService(env).sendTransactional(...)`.
- The existing per-user Gmail-OAuth send (`gmail.ts` `sendGmailEmail`) stays untouched — it's specifically about sending *as the user*, not as us. That's a different concern and should not be abstracted into `EmailService`.

### Acceptance criteria

- [ ] All transactional emails (welcome, password reset, receipt) go through `EmailService.sendTransactional`.
- [ ] `LoggingEmailService` is the default; dev mode produces no real sends.
- [ ] Switching `EMAIL_PROVIDER=loops` (or others) requires no code changes in feature files.
- [ ] All template content lives in `src/email_templates/`; nothing hardcoded in feature files.

---

## Phase 6 — Ad audience engine

**Goal:** turn user behavior into LinkedIn and Google Ads audiences for
retargeting. This is the highest-ROI use of our data, and the highest
GDPR-risk surface — so the design is conservative: opt-in, kill-switched, and
auditable.

### Tasks

#### 6.1 — Audience definition layer

- `src/audiences.ts` exports a registry of named audiences, each defined by a
  D1 query that returns `{ user_id, email, country }`.

  ```ts
  export const AUDIENCES = {
    attended_no_convert: { ... },
    upcoming_show_attendees: { ... },
    dormant_paid: { ... },
    power_users: { ... },
    lookalike_base: { ... },
  } satisfies Record<string, AudienceDef>;
  ```

- Each audience has:
  - `id` (matches `LIFECYCLE_RULES.md` and admin dashboard)
  - `description` (human-readable)
  - `query: (env) => Promise<AudienceMember[]>`
  - `gdpr_basis: 'legitimate_interest' | 'consent_required'` — drives the consent filter in §6.5

#### 6.2 — LinkedIn Matched Audiences sync

- OAuth flow (one-time, admin) at `/admin/integrations/linkedin/connect`.
- Refresh-token persistence in `linkedin_tokens` table.
- `src/sync_linkedin.ts`:
  - Hashes emails with SHA-256 (LinkedIn's required format) before upload.
  - Rate limits per LinkedIn's documented thresholds (~10k members per request, exponential back-off on 429).
  - Uses LinkedIn Matched Audiences API endpoints (`/dmpSegments` / `/dmpSegments/{id}/users`).
- Day-1 ops task: **submit LinkedIn Marketing Developer Platform application** (12-week+ approval cycle — start early).

#### 6.3 — Google Customer Match sync

- OAuth flow at `/admin/integrations/google-ads/connect` (separate Google project from the user-side service account).
- `src/sync_google.ts`:
  - SHA-256 hashes emails (Google's requirement).
  - Uses Google Ads API `customers/{id}/userLists/{id}/customers` endpoints.
- Day-1 ops task: **verify Google Ads account eligibility** (some accounts are excluded from Customer Match — verify before building).

#### 6.4 — GDPR consent layer

- Add `users.consents` JSON column (migration).

  ```sql
  ALTER TABLE users ADD COLUMN consents TEXT;  -- JSON: {"ads": true, "ads_at": "2026-04-25T...", "marketing": true, ...}
  ```

- All audiences with `gdpr_basis: 'consent_required'` filter their member list to only users where `consents.ads === true`.
- Consent collection: a one-time modal on first sign-in, plus a permanent toggle in `/dashboard/settings`.
- Withdrawal flow: when a user toggles `consents.ads` to `false`, fire `removeFromSegment` for every audience they're currently in.

Migration file: `migrations/016_user_consents.sql`.

#### 6.5 — Master kill switch + per-platform toggles

- Env vars (default: all disabled):
  - `AD_SYNC_ENABLED` = `'true'` to enable any sync at all
  - `LINKEDIN_SYNC_ENABLED` = `'true'` to enable LinkedIn syncs specifically
  - `GOOGLE_SYNC_ENABLED` = `'true'` to enable Google syncs specifically
- Sync engine checks all three flags before doing anything; logs which flag blocked it if disabled.
- Toggle from `/admin/audiences/settings` (writes to `wrangler secret put` — actually this can't be done from a Worker; the toggles must be set via wrangler CLI or a separate admin path. Document the procedure.)

#### 6.6 — Manual CSV export

- Parallel to API syncs, every audience has a "Download CSV" button on `/admin/audiences/:id`.
- The CSV contains hashed emails only (never plaintext) so it can be uploaded manually if API syncs are disabled or for ad-platform debugging.

#### 6.7 — Audit log

```sql
CREATE TABLE ad_sync_log (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  audience_id  TEXT NOT NULL,
  platform     TEXT NOT NULL,                  -- 'linkedin' | 'google' | 'csv_export'
  member_count INTEGER NOT NULL,
  status       TEXT NOT NULL,                  -- 'success' | 'partial' | 'failed' | 'kill_switched'
  error_msg    TEXT,
  initiated_by TEXT,                            -- user_id of the admin or 'cron'
  fired_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ad_sync_log_fired ON ad_sync_log(fired_at);
```

Migration file: `migrations/017_ad_sync_log.sql`. Every sync attempt — successful or not, API or CSV — writes a row.

#### 6.8 — Admin "Audiences" page

`/admin/audiences` shows a table of every registered audience:

| Column | Source |
|---|---|
| Name | `AUDIENCES[id].description` |
| Member count | result of `query()` (cached for 5 minutes) |
| Last LinkedIn sync | `MAX(fired_at) FROM ad_sync_log WHERE platform='linkedin'` |
| Last Google sync | same for Google |
| Status | derived from latest log row |
| Actions | "Sync now" buttons, "Download CSV" |

#### 6.9 — Day-1 ops checklist

These don't block code, but blocking them later costs weeks. **Start them on the first day Phase 6 begins:**

- [ ] Submit LinkedIn Marketing Developer Platform application
- [ ] Verify Google Ads account eligibility for Customer Match
- [ ] Draft privacy policy section covering ad data use; have it reviewed before going live
- [ ] Confirm DPA / SCCs with LinkedIn and Google as data processors

### Acceptance criteria

- [ ] Migrations 016 and 017 applied.
- [ ] Every audience query returns the expected user set on a hand-built test (5 cases).
- [ ] LinkedIn sync end-to-end: OAuth → upload → audience visible in LinkedIn Campaign Manager.
- [ ] Google sync end-to-end: OAuth → upload → audience visible in Google Ads.
- [ ] With `AD_SYNC_ENABLED=false`, no platform receives any data; the kill-switch event is logged.
- [ ] Withdrawing consent removes the user from all audiences within 24 hours.
- [ ] CSV export contains only SHA-256 hashed emails.
- [ ] `ad_sync_log` row exists for every sync attempt.
- [ ] Privacy policy live and linked from the dashboard footer + welcome email.

---

## Cross-phase notes

- Each phase introduces at least one migration. They must be numbered sequentially (next available is `013`).
- **Coupon mechanism is in Phase 1.7** — but it's referenced by Phase 6 retargeting (a coupon code is the natural payload for a retargeting offer).
- **WhatsApp is referenced as a channel in Phase 4** but its handler is its own future phase (not numbered here — depends on Meta verification).
- **Brand visual migration** (Cinzel + DM Sans + Josefin Sans + armillary-sphere logo) is a Phase 2 task only after final brand assets land. Don't block phases on visuals.
- **Pricing tiers** ($199 5-show pack, $299/mo organizer plan) get added by registering Stripe prices and adding env vars; no code change required if §1.7 is implemented properly. Document the new tiers on the landing page when they go live.

---

## Anti-goals (out of scope, by design)

- Building our own analytics warehouse. PostHog + Stripe Sigma + ChartMogul cover what we need; don't invest in BigQuery/Snowflake plumbing until we have >1k paid users.
- Building our own email-sending infrastructure. Provider abstraction in Phase 5 lets us pick later; don't run our own MTA.
- Building our own ad-platform. We feed audiences to LinkedIn and Google; we don't run pixel-based attribution.
- Locking integrations to specific organizers. The product principle is "works at any show" — no Phase here adds organizer-specific deals.

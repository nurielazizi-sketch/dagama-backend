-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 029: coupons (Stripe-synced) + user_show_interest +
-- retargeting_emails_sent.
--
-- Strategic context (memory/dagama_retargeting_strategy.md): retargeting fires
-- based on the user's NEXT trade show date, not "N days after trial expiry."
-- This requires three pieces:
--
-- 1. coupons + coupon_redemptions: code-driven discounts. Local mirror of
--    Stripe Coupon objects (so Checkout can apply by ID), plus single-use-
--    per-user enforcement that Stripe doesn't natively give us.
--
-- 2. user_show_interest: explicit "this user is preparing for show X"
--    signals. Inferred signals come from buyer_shows (SourceBot) and
--    google_sheets (BoothBot); this table captures the explicit ones from
--    onboarding chat ("Which show?") + retargeting selection.
--
-- 3. retargeting_emails_sent: idempotency + cooldown for the daily cron.
--    Without this, the cron would fire the T-30 email every day for 30 days.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. coupons — local mirror of Stripe Coupon objects + our extensions
CREATE TABLE IF NOT EXISTS coupons (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  code                TEXT NOT NULL UNIQUE,                 -- user-visible: 'CES2026', 'COMEBACK30'
  stripe_coupon_id    TEXT,                                 -- Stripe Coupon ID; NULL for free_extension_hours
  -- Discount kind
  kind                TEXT NOT NULL
                        CHECK (kind IN ('percent_off', 'fixed_off_cents', 'free_extension_hours')),
  value               INTEGER NOT NULL,                     -- 30 (% off), 1000 (cents off), 24 (hours extended)
  -- Scope
  applies_to          TEXT NOT NULL DEFAULT 'any'
                        CHECK (applies_to IN ('any', 'show_pass', 'three_show_pack', 'team_unlimited', 'expensebot_standalone')),
  -- Validity window
  valid_from          TEXT,                                 -- NULL = valid immediately
  valid_until         TEXT,                                 -- NULL = no expiry (rare; prefer setting one)
  -- Usage caps
  max_total_uses      INTEGER,                              -- NULL = unlimited
  total_uses          INTEGER NOT NULL DEFAULT 0,
  single_use_per_user INTEGER NOT NULL DEFAULT 1
                        CHECK (single_use_per_user IN (0, 1)),
  -- Provenance
  source              TEXT NOT NULL
                        CHECK (source IN ('admin', 'retargeting', 'partner', 'referral', 'launch_promo')),
  source_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,  -- for retargeting/referral codes, who they're for
  source_show_id      TEXT,                                 -- if show-specific (e.g. CES2026); references shows_catalog.id
  notes               TEXT,
  -- Lifecycle
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'revoked')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coupons_active        ON coupons(code) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_coupons_user          ON coupons(source_user_id) WHERE source_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_show          ON coupons(source_show_id) WHERE source_show_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_validity      ON coupons(valid_until)    WHERE valid_until IS NOT NULL AND status = 'active';

-- 2. coupon_redemptions — single-use-per-user audit trail
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  coupon_id           TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applied_to          TEXT NOT NULL,                        -- pass.id, subscription.id, etc.
  applied_to_kind     TEXT NOT NULL
                        CHECK (applied_to_kind IN ('pass', 'subscription', 'free_extension')),
  discount_cents      INTEGER,                              -- actual cents saved (post-Stripe-call)
  redeemed_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user   ON coupon_redemptions(user_id);
-- Enforce single-use-per-user when the parent coupon flag is set; check
-- enforcement happens in app code (D1 doesn't support partial UNIQUE on join).

-- 3. user_show_interest — explicit user → show signals
CREATE TABLE IF NOT EXISTS user_show_interest (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id             TEXT NOT NULL,                        -- shows_catalog.id; not FK'd to allow shows_catalog rebuilds
  -- How we learned this user is interested
  source              TEXT NOT NULL DEFAULT 'onboarding_chat'
                        CHECK (source IN ('onboarding_chat', 'website_picker', 'inferred_capture', 'retargeting_click', 'admin')),
  -- Bot the user is using for this show
  bot_role            TEXT
                        CHECK (bot_role IN ('boothbot', 'sourcebot', 'expensebot')),
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_show_interest_user ON user_show_interest(user_id);
CREATE INDEX IF NOT EXISTS idx_user_show_interest_show ON user_show_interest(show_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_show_interest_pair
  ON user_show_interest(user_id, show_id);

-- 4. retargeting_emails_sent — idempotency for the daily cron
CREATE TABLE IF NOT EXISTS retargeting_emails_sent (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id             TEXT NOT NULL,                        -- shows_catalog.id
  -- T-N days before show start. We send at T-30, T-14, T-7, T-1.
  days_before_show    INTEGER NOT NULL,
  coupon_id           TEXT REFERENCES coupons(id) ON DELETE SET NULL,
  resend_message_id   TEXT,                                 -- Resend's id for delivery tracking
  sent_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_retargeting_uniq
  ON retargeting_emails_sent(user_id, show_id, days_before_show);
CREATE INDEX IF NOT EXISTS idx_retargeting_user
  ON retargeting_emails_sent(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 027: passes (unified time-window access) + web_chat_sessions +
-- web_chat_messages.
--
-- Why `passes` (and not just `subscriptions`):
-- The existing `subscriptions` table is Stripe-scoped (stripe_subscription_id,
-- shows_remaining, plan). It works fine for paid passes (show_96h, 3-pack,
-- team) and stays untouched here. But the Day-1 free-tier 24h trial is NOT
-- a Stripe object — it's a free, time-boxed access grant whose clock starts
-- at the user's first message. Trying to shoehorn it into `subscriptions`
-- would muddle the model.
--
-- Instead: `passes` is the unified time-window-access concept. Free trial
-- inserts a `kind='free_24h'` row at signup with started_at NULL. First
-- message sets started_at = NOW() and expires_at = NOW() + 24h. Status
-- transitions: pending → active → expired (then trial-expiry email queued).
--
-- Paid passes can later be issued as `passes` rows linked back to a
-- `subscriptions` row (source_subscription_id) — but that migration of
-- existing paid logic is OUT OF SCOPE here. For v1, only free_24h uses
-- `passes`; paid show passes still flow through `subscriptions` + buyer_shows.
--
-- web_chat_sessions / web_chat_messages: storage layer for the new web
-- channel. Sessions are keyed by a session_token (separate from JWT — long-
-- lived chat shouldn't break when JWT rotates). Messages are bidirectional
-- (direction = inbound | outbound). Media (image / voice) lives in R2;
-- `media_r2_key` is the pointer.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. passes — unified time-window access grants
CREATE TABLE IF NOT EXISTS passes (
  id                          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  kind                        TEXT NOT NULL
                                CHECK (kind IN (
                                  'free_24h',         -- Day-1 trial
                                  'show_96h',         -- one show pass
                                  'three_show_pack',  -- 3-pack of shows
                                  'team_unlimited',   -- team plan, no expiry
                                  'demo'              -- internal/freelancer demo grants
                                )),

  bot_role                    TEXT NOT NULL
                                CHECK (bot_role IN ('boothbot', 'sourcebot', 'expensebot')),

  -- Time window. started_at NULL until clock kicks off; expires_at NULL means
  -- no expiry (team_unlimited) or not-yet-started (started_at IS NULL).
  started_at                  TEXT,
  expires_at                  TEXT,

  -- Provenance
  source_subscription_id      TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  source_show_name            TEXT,
  source_buyer_show_id        TEXT,    -- buyer_shows.id when applicable; not FK'd to keep this migration small

  -- Lifecycle
  status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'active', 'expired', 'consumed', 'canceled')),

  -- 8am-email scheduling: when free_24h transitions to expired, queue
  -- exactly one trial-expiry email by setting this. Cron sweep emits the
  -- email + sets sent_at; subsequent sweeps see sent_at and skip.
  trial_expiry_email_sent_at  TEXT,

  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at                TEXT,
  expired_at                  TEXT,
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Find a user's currently-active or pending pass (most-common query)
CREATE INDEX IF NOT EXISTS idx_passes_user_active ON passes(user_id, status)
  WHERE status IN ('pending', 'active');

-- All passes for a user, by kind (for billing / history queries)
CREATE INDEX IF NOT EXISTS idx_passes_user_kind ON passes(user_id, kind);

-- Cron sweep: expire active passes whose expires_at has passed
CREATE INDEX IF NOT EXISTS idx_passes_expiring ON passes(expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

-- Cron sweep: queue 8am email for free_24h passes that expired but haven't
-- been notified yet
CREATE INDEX IF NOT EXISTS idx_passes_email_due ON passes(expired_at)
  WHERE kind = 'free_24h' AND status = 'expired' AND trial_expiry_email_sent_at IS NULL;

-- 2. web_chat_sessions — long-lived chat surface per (user, bot_role)
CREATE TABLE IF NOT EXISTS web_chat_sessions (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_role            TEXT NOT NULL
                        CHECK (bot_role IN ('boothbot', 'sourcebot', 'expensebot')),

  -- Client-side opaque token; separate from JWT so chat survives JWT rotation
  -- and can identify a returning anonymous-then-authenticated user.
  session_token       TEXT NOT NULL UNIQUE,

  -- Bot brain session state — JSON, mirrors bot_users.session shape so the
  -- same brain code can read/write it regardless of channel.
  state               TEXT,

  -- Active pass at last check (denormalized for fast pass-expiry check on
  -- inbound message). NULL means "look up fresh".
  active_pass_id      TEXT REFERENCES passes(id) ON DELETE SET NULL,

  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_inbound_at     TEXT,
  last_outbound_at    TEXT,
  ended_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_web_chat_sessions_user      ON web_chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_web_chat_sessions_token     ON web_chat_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_web_chat_sessions_active    ON web_chat_sessions(user_id, ended_at)
  WHERE ended_at IS NULL;

-- 3. web_chat_messages — bidirectional message log
CREATE TABLE IF NOT EXISTS web_chat_messages (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id          TEXT NOT NULL REFERENCES web_chat_sessions(id) ON DELETE CASCADE,

  direction           TEXT NOT NULL
                        CHECK (direction IN ('inbound', 'outbound')),

  -- text | image | voice | system | buttons (interactive bot prompt)
  kind                TEXT NOT NULL
                        CHECK (kind IN ('text', 'image', 'voice', 'system', 'buttons')),

  text                TEXT,

  -- Media (image / voice) stored in R2; this is the key.
  media_r2_key        TEXT,
  media_mime          TEXT,

  -- For interactive button messages — JSON array of {text, data?, url?}
  buttons_json        TEXT,

  -- Optional dedupe key from client to absorb retry storms.
  client_dedupe_key   TEXT,

  -- Bot-side: which adapter call produced this row (for debugging / replay)
  produced_by         TEXT,

  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Most-common query: load a session's full history in chronological order
CREATE INDEX IF NOT EXISTS idx_web_chat_messages_session_time
  ON web_chat_messages(session_id, created_at);

-- Inbound dedupe — only enforced when client_dedupe_key is set
CREATE UNIQUE INDEX IF NOT EXISTS idx_web_chat_messages_dedupe
  ON web_chat_messages(session_id, client_dedupe_key)
  WHERE client_dedupe_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- WhatsApp Cloud API (Meta) integration. All WA-specific tables prefixed wa_*.
-- Mirrors sb_buyers_telegram + sb_tg_updates_seen patterns so a buyer/exhibitor
-- can use BoothBot or SourceBot through Telegram OR WhatsApp interchangeably.
--
-- Bot routing: wa_user_mappings.bot_role = 'boothbot' | 'sourcebot'.
-- Set during onboarding (deep link "join <token>" or first message that
-- consumes an onboarding_tokens row), then sticky for that phone number.
--
-- Idempotency: wa_inbound_messages stores the WA message_id (unique per WABA).
-- INSERT OR IGNORE; if no row was changed, this is a retry — drop on the floor.
--
-- Status: wa_message_status tracks sent/delivered/read/failed lifecycle for
-- outbound messages, keyed by our wamid (returned on send).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Phone number ↔ user mapping. One row per phone number that has talked to
--    either bot. bot_role decides which handler the message routes to.
CREATE TABLE IF NOT EXISTS wa_user_mappings (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  phone         TEXT NOT NULL UNIQUE,                 -- E.164 without '+', e.g. '15551234567' (matches WA payload format)
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  buyer_id      TEXT REFERENCES sb_buyers(id) ON DELETE SET NULL,  -- populated when SourceBot user
  bot_role      TEXT NOT NULL CHECK (bot_role IN ('boothbot', 'sourcebot', 'unassigned')) DEFAULT 'unassigned',
  display_name  TEXT,                                 -- WA "profile.name" from inbound payload
  session       TEXT,                                 -- JSON; mirrors bot_users.session / sb_buyers_telegram.session
  language      TEXT DEFAULT 'en',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_user_mappings_user  ON wa_user_mappings (user_id);
CREATE INDEX IF NOT EXISTS idx_wa_user_mappings_buyer ON wa_user_mappings (buyer_id);
CREATE INDEX IF NOT EXISTS idx_wa_user_mappings_role  ON wa_user_mappings (bot_role);

-- 2. Inbound message dedupe — WhatsApp delivers webhooks at-least-once.
--    PRIMARY KEY on wamid means INSERT OR IGNORE drops retries cleanly.
CREATE TABLE IF NOT EXISTS wa_inbound_messages (
  wamid         TEXT PRIMARY KEY,                     -- "wamid.HBgM..." from payload.messages[].id
  phone         TEXT NOT NULL,
  msg_type      TEXT NOT NULL,                        -- text | image | audio | video | document | interactive | reaction | location | contacts | unknown
  received_at   INTEGER NOT NULL,                     -- unix epoch seconds
  raw_json      TEXT,                                 -- compact JSON of the message envelope (for debugging)
  processed     INTEGER NOT NULL DEFAULT 0,           -- 1 once handler completed
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_inbound_phone  ON wa_inbound_messages (phone, received_at);
CREATE INDEX IF NOT EXISTS idx_wa_inbound_unproc ON wa_inbound_messages (processed, received_at);

-- 3. Outbound message status callbacks (sent/delivered/read/failed). Keyed by
--    the wamid we got back from the send call. We only care about the latest
--    state, but we keep history for debugging.
CREATE TABLE IF NOT EXISTS wa_message_status (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  wamid         TEXT NOT NULL,                        -- our outbound wamid
  recipient     TEXT NOT NULL,                        -- recipient phone in E.164-no-plus
  status        TEXT NOT NULL,                        -- sent | delivered | read | failed
  error_code    INTEGER,
  error_title   TEXT,
  error_detail  TEXT,
  observed_at   INTEGER NOT NULL                      -- unix epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_wa_status_wamid     ON wa_message_status (wamid);
CREATE INDEX IF NOT EXISTS idx_wa_status_recipient ON wa_message_status (recipient, observed_at);

-- 4. Outbound message log (one row per send attempt). Tracks the wamid we got
--    back from the Graph API plus the request payload — useful for debugging
--    template rejections and retry decisions.
CREATE TABLE IF NOT EXISTS wa_outbound_messages (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  wamid         TEXT,                                 -- nullable: null until graph API responds
  recipient     TEXT NOT NULL,
  msg_type      TEXT NOT NULL,                        -- text | template | interactive | image | document | audio | video | reaction
  template_name TEXT,                                 -- only for msg_type='template'
  payload_json  TEXT NOT NULL,                        -- the body we POSTed
  response_json TEXT,                                 -- the body we got back (truncated if huge)
  http_status   INTEGER,
  sent_by       TEXT,                                 -- 'boothbot' | 'sourcebot' | 'system'
  sent_at       INTEGER NOT NULL                      -- unix epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_wa_outbound_wamid     ON wa_outbound_messages (wamid);
CREATE INDEX IF NOT EXISTS idx_wa_outbound_recipient ON wa_outbound_messages (recipient, sent_at);

-- 5. Template registry — local cache of Meta-approved templates so we can
--    look up name/language/components without round-tripping to the Graph API.
--    Sync separately (admin endpoint or manual) — Meta is the source of truth.
CREATE TABLE IF NOT EXISTS wa_templates (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name          TEXT NOT NULL,                        -- e.g. 'boothbot_welcome'
  language      TEXT NOT NULL,                        -- 'en' | 'en_US' | 'es' | ...
  category      TEXT,                                 -- AUTHENTICATION | UTILITY | MARKETING
  status        TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected | paused
  components_json TEXT,                               -- raw components array from Meta
  meta_id       TEXT,                                 -- Meta's template ID
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, language)
);
CREATE INDEX IF NOT EXISTS idx_wa_templates_status ON wa_templates (status);

-- 6. Media cache — when an inbound message has media.id, we fetch the auth'd
--    URL once, stream it to R2, and remember the mapping so re-deliveries
--    don't re-download. R2 key convention: 'wa-media/{media_id}/{filename}'.
CREATE TABLE IF NOT EXISTS wa_media_cache (
  media_id      TEXT PRIMARY KEY,                     -- WA media id from payload
  r2_key        TEXT NOT NULL,                        -- key in R2_BUCKET
  mime_type     TEXT,
  sha256        TEXT,                                 -- WA provides this on inbound
  size_bytes    INTEGER,
  fetched_at    INTEGER NOT NULL                      -- unix epoch seconds
);

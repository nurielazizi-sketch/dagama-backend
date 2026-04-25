-- ─────────────────────────────────────────────────────────────────────────────
-- SourceBot MVP schema. All SourceBot-specific tables are prefixed `sb_*` to
-- avoid collisions with BoothBot tables (e.g. existing `leads`, `buyer_shows`).
--
-- Bot-agnostic table: `onboarding_tokens` — used by both Telegram and (future)
-- WhatsApp deep links to map first contact back to a registered user.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1:1 sidecar to existing `users` row, only for users who chose the SourceBot path.
CREATE TABLE IF NOT EXISTS sb_buyers (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id         TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  name            TEXT,
  language        TEXT DEFAULT 'en',
  active_show_id  TEXT,
  plan            TEXT NOT NULL DEFAULT 'free',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sb_buyers_user_id ON sb_buyers(user_id);
CREATE INDEX IF NOT EXISTS idx_sb_buyers_email   ON sb_buyers(email);

-- Per-buyer per-show pass + sheet/drive references. show_name is denormalized
-- (kept as a string here, not a FK) to mirror BoothBot's model and let us defer
-- the `shows` lookup table to a later phase.
CREATE TABLE IF NOT EXISTS sb_buyer_shows (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  buyer_id          TEXT NOT NULL,
  show_name         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',  -- active | grace | readonly | expired
  sheet_id          TEXT,
  sheet_url         TEXT,
  drive_folder_id   TEXT,
  drive_folder_url  TEXT,
  first_capture_at  INTEGER,
  pass_expires_at   INTEGER,
  grace_period_end  INTEGER,
  warning_sent      INTEGER NOT NULL DEFAULT 0,
  grace_msg_sent    INTEGER NOT NULL DEFAULT 0,
  lock_msg_sent     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(buyer_id, show_name)
);
CREATE INDEX IF NOT EXISTS idx_sb_buyer_shows_buyer  ON sb_buyer_shows(buyer_id);
CREATE INDEX IF NOT EXISTS idx_sb_buyer_shows_status ON sb_buyer_shows(status);

-- Telegram chat ↔ buyer (kept separate from buyers so a future WhatsApp
-- mapping table can sit beside it without coupling the two).
CREATE TABLE IF NOT EXISTS sb_buyers_telegram (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  buyer_id          TEXT NOT NULL,
  telegram_chat_id  INTEGER NOT NULL UNIQUE,
  telegram_username TEXT,
  session           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sb_buyers_telegram_buyer ON sb_buyers_telegram(buyer_id);

-- Suppliers / companies the buyer captured at a show.
CREATE TABLE IF NOT EXISTS sb_companies (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  buyer_id            TEXT NOT NULL,
  show_name           TEXT NOT NULL,
  name                TEXT NOT NULL,
  website             TEXT,
  industry            TEXT,
  geographic_presence TEXT,
  interest_level      TEXT,
  sheet_row           INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sb_companies_buyer_show ON sb_companies(buyer_id, show_name);

-- Contact persons (one company can have many contacts).
CREATE TABLE IF NOT EXISTS sb_contacts (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id     TEXT NOT NULL,
  buyer_id       TEXT NOT NULL,
  show_name      TEXT NOT NULL,
  name           TEXT,
  title          TEXT,
  email          TEXT,
  phone          TEXT,
  phone_country  TEXT,
  linkedin_url   TEXT,
  address        TEXT,
  card_front_url TEXT,
  card_back_url  TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sb_contacts_company ON sb_contacts(company_id);

-- Bot-agnostic onboarding tokens. Generated at registration; consumed by either
-- the Telegram /start payload or the WhatsApp first message (deep-link "join <token>").
CREATE TABLE IF NOT EXISTS onboarding_tokens (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_role    TEXT NOT NULL,                   -- 'boothbot' | 'sourcebot'
  show_name   TEXT,                            -- optional pre-selected show
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_onboarding_tokens_user ON onboarding_tokens(user_id);

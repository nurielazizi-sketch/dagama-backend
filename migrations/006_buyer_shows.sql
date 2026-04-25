CREATE TABLE IF NOT EXISTS buyer_shows (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  chat_id          INTEGER NOT NULL,
  user_id          TEXT,
  show_name        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  first_scan_at    INTEGER,
  pass_expires_at  INTEGER,
  grace_period_end INTEGER,
  warning_sent     INTEGER NOT NULL DEFAULT 0,
  grace_msg_sent   INTEGER NOT NULL DEFAULT 0,
  lock_msg_sent    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_buyer_shows_chat_id ON buyer_shows(chat_id);
CREATE INDEX IF NOT EXISTS idx_buyer_shows_status  ON buyer_shows(status);

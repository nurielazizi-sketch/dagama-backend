CREATE TABLE IF NOT EXISTS gmail_tokens (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  chat_id       INTEGER NOT NULL UNIQUE,
  gmail_address TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry  INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gmail_tokens_chat_id ON gmail_tokens(chat_id);

ALTER TABLE leads ADD COLUMN sheet_row INTEGER;

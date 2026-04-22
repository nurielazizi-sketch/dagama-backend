-- DaGama D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Links a Telegram chat_id to a DaGama user account
CREATE TABLE IF NOT EXISTS bot_users (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  chat_id    INTEGER NOT NULL UNIQUE,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT,
  session    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bot_users_chat_id ON bot_users(chat_id);

-- Leads captured at trade shows via the Telegram bot
CREATE TABLE IF NOT EXISTS leads (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  chat_id    INTEGER NOT NULL,
  show_name  TEXT NOT NULL DEFAULT 'General',
  name       TEXT NOT NULL,
  company    TEXT,
  email      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_chat_id ON leads(chat_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);

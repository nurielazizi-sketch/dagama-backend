-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 025: leads table → multi-channel.
--
-- Problem this fixes: leads.chat_id is INTEGER NOT NULL, locking the table to
-- Telegram captures. BoothBot's WhatsApp pipeline (whatsapp.ts:239-284) calls
-- the channel-agnostic handleCardCapture() with channel:'whatsapp', which would
-- fail to insert into leads. Web captures (web_capture.ts) hit the same wall.
--
-- This migration:
--   1. Adds channel, user_id, wa_phone, web_session_id columns.
--   2. Makes chat_id nullable (table rebuild, since SQLite can't DROP NOT NULL).
--   3. Backfills user_id from bot_users.chat_id mapping for existing TG rows.
--   4. Tags every existing row channel='telegram' (only channel today).
--
-- After this lands, capture.ts callers must:
--   - Always set channel ∈ {'telegram','whatsapp','web'}.
--   - Set the matching channel-specific identifier (chat_id / wa_phone / web_session_id).
--   - Resolve user_id at insert time (bot_users / wa_user_mappings / web session).
--
-- Rebuild pattern is the standard SQLite approach for nullability change.
-- Wrangler wraps each migration in a transaction by default; no explicit
-- BEGIN/COMMIT or PRAGMA foreign_keys here.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE leads_new (
  id                       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id                  TEXT REFERENCES users(id) ON DELETE SET NULL,
  channel                  TEXT NOT NULL DEFAULT 'telegram'
                             CHECK (channel IN ('telegram', 'whatsapp', 'web')),
  chat_id                  INTEGER,
  wa_phone                 TEXT,
  web_session_id           TEXT,
  show_name                TEXT NOT NULL DEFAULT 'General',
  name                     TEXT NOT NULL,
  company                  TEXT,
  email                    TEXT,
  notes                    TEXT,
  phone                    TEXT,
  title                    TEXT,
  website                  TEXT,
  linkedin                 TEXT,
  address                  TEXT,
  country                  TEXT,
  sheet_row                INTEGER,
  confirmation_message_id  INTEGER,
  status                   TEXT NOT NULL DEFAULT 'complete',
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO leads_new (
  id, channel, chat_id,
  show_name, name, company, email, notes,
  phone, title, website, linkedin, address, country,
  sheet_row, confirmation_message_id, status, created_at
)
SELECT
  id, 'telegram', chat_id,
  show_name, name, company, email, notes,
  phone, title, website, linkedin, address, country,
  sheet_row, confirmation_message_id, status, created_at
FROM leads;

UPDATE leads_new
   SET user_id = (
     SELECT bot_users.user_id
       FROM bot_users
      WHERE bot_users.chat_id = leads_new.chat_id
   )
 WHERE channel = 'telegram'
   AND chat_id IS NOT NULL
   AND user_id IS NULL;

DROP TABLE leads;
ALTER TABLE leads_new RENAME TO leads;

CREATE INDEX idx_leads_chat_id    ON leads(chat_id);
CREATE INDEX idx_leads_created_at ON leads(created_at);
CREATE INDEX idx_leads_user_id    ON leads(user_id);
CREATE INDEX idx_leads_channel    ON leads(channel);
CREATE INDEX idx_leads_wa_phone   ON leads(wa_phone)        WHERE wa_phone        IS NOT NULL;
CREATE INDEX idx_leads_web_sess   ON leads(web_session_id)  WHERE web_session_id  IS NOT NULL;

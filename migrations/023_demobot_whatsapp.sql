-- DemoBot on WhatsApp — extends wa_user_mappings.bot_role CHECK to include
-- 'demobot'. SQLite can't ALTER a CHECK constraint, so we rebuild the table.
-- All other columns + indexes preserved.
CREATE TABLE IF NOT EXISTS wa_user_mappings_v2 (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  phone         TEXT NOT NULL UNIQUE,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  buyer_id      TEXT REFERENCES sb_buyers(id) ON DELETE SET NULL,
  bot_role      TEXT NOT NULL CHECK (bot_role IN ('boothbot', 'sourcebot', 'demobot', 'unassigned')) DEFAULT 'unassigned',
  display_name  TEXT,
  session       TEXT,
  language      TEXT DEFAULT 'en',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO wa_user_mappings_v2 (id, phone, user_id, buyer_id, bot_role, display_name, session, language, created_at, updated_at)
  SELECT id, phone, user_id, buyer_id, bot_role, display_name, session, language, created_at, updated_at FROM wa_user_mappings;
DROP TABLE wa_user_mappings;
ALTER TABLE wa_user_mappings_v2 RENAME TO wa_user_mappings;
CREATE INDEX IF NOT EXISTS idx_wa_user_mappings_user  ON wa_user_mappings (user_id);
CREATE INDEX IF NOT EXISTS idx_wa_user_mappings_buyer ON wa_user_mappings (buyer_id);
CREATE INDEX IF NOT EXISTS idx_wa_user_mappings_role  ON wa_user_mappings (bot_role);

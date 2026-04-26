-- Telegram retries webhooks on slow responses, which is what was causing
-- duplicate /start messages. Dedupe by update_id (unique per bot).
CREATE TABLE IF NOT EXISTS sb_tg_updates_seen (
  update_id INTEGER PRIMARY KEY,
  seen_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sb_tg_updates_seen_at ON sb_tg_updates_seen (seen_at);

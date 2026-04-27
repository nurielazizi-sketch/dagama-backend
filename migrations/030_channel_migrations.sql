-- Pending channel migrations.
--
-- Day-1 architecture is single-active per buyer: a buyer talks to DaGama on
-- Telegram OR WhatsApp OR web at any one time. When the same user clicks an
-- onboarding/relink link from a NEW channel while they already have an active
-- mapping on another channel, we don't silently swap — the OLD channel must
-- confirm the move first (so a forwarded email can't hijack the account).
--
-- Lifecycle:
--   1. New channel redeems the token. We detect there's already an active
--      mapping. Insert a row here with status='pending' and a 10-min TTL.
--   2. We send a "Confirm switch?" message to the OLD channel with two
--      callback buttons: confirm_migration:<id> and discard_migration:<id>.
--      The new channel sees a "waiting for confirmation" message.
--   3. Old channel taps Confirm → status='confirmed', we remove the old
--      mapping and bind the new one. Both channels get notified.
--      Old channel taps Discard → status='discarded', the new attempt is
--      rejected; old mapping stays.
--   4. Cron purges pending rows past expires_at (status='expired').
CREATE TABLE IF NOT EXISTS pending_channel_migrations (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  buyer_id        TEXT NOT NULL,
  new_channel     TEXT NOT NULL CHECK (new_channel IN ('telegram','whatsapp','web')),
  new_identifier  TEXT NOT NULL,                                    -- chat_id (TG) | phone (WA) | session_id (web)
  old_channel     TEXT NOT NULL CHECK (old_channel IN ('telegram','whatsapp','web')),
  old_identifier  TEXT NOT NULL,
  requested_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','confirmed','discarded','expired')) DEFAULT 'pending',
  confirmed_at    INTEGER,
  FOREIGN KEY (buyer_id) REFERENCES sb_buyers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pcm_buyer  ON pending_channel_migrations(buyer_id);
CREATE INDEX IF NOT EXISTS idx_pcm_status ON pending_channel_migrations(status, expires_at);

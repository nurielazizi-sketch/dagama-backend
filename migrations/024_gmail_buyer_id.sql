-- ─────────────────────────────────────────────────────────────────────────────
-- Add a nullable buyer_id column to gmail_tokens so SourceBot users can
-- connect Gmail from any channel (web, WhatsApp) without needing a Telegram
-- chat_id first. Existing rows (Telegram-side connections) keep working
-- exactly as before — chat_id stays the primary key, buyer_id is additive.
--
-- Lookups now prefer buyer_id when known and fall back to chat_id via
-- sb_buyers_telegram for buyers who connected via Telegram first. See
-- gmail.ts: getValidAccessTokenForBuyer().
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE gmail_tokens ADD COLUMN buyer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_gmail_tokens_buyer ON gmail_tokens (buyer_id);

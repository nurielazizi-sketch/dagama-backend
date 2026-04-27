-- One-shot deeplink tokens for "Connect ExpenseBot" from the dashboard.
--
-- Flow:
--   1. Logged-in dashboard user taps "Connect ExpenseBot".
--   2. POST /api/expensebot/link-token (Bearer JWT) mints a row here.
--   3. Dashboard opens t.me/DaGaMaExpenseBot?start=<token>.
--   4. ExpenseBot's /start <token> handler consumes the row (sets used_at)
--      and inserts the chat_id↔user_id mapping directly — bypassing the
--      email-lookup auth that plain /start uses.
--
-- Tokens are short-lived (30 min). Single-shot — used_at being non-null means
-- already redeemed. Cron purge deletes expired+used rows nightly.
CREATE TABLE IF NOT EXISTS expensebot_link_tokens (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_eblt_user    ON expensebot_link_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_eblt_expires ON expensebot_link_tokens(expires_at);

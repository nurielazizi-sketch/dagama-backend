-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 027: ExpenseBot Telegram channel — chat_id ↔ user_id binding +
-- a pending-auth scratch table for the email-lookup self-serve flow.
--
-- Why two tables:
--   - expensebot_users_telegram: persistent mapping. After successful auth,
--     every inbound TG message resolves chat_id → user_id via this table.
--   - expensebot_pending_auth:   ephemeral scratch row while a brand-new chat
--     is in the email-input step. Cleared on success or on /reset.
--
-- ExpenseBot inbound dedup uses expenses.source_message_id UNIQUE
-- (format: 'telegram:<chat_id>:<message_id>') — no separate updates_seen table.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS expensebot_users_telegram (
  chat_id     INTEGER PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_username TEXT,
  -- Per-chat default context. Most ExpenseBot users will be exhibitors logging
  -- show expenses, so default to 'expedition'. User flips with /context.
  default_context TEXT NOT NULL DEFAULT 'expedition'
                    CHECK (default_context IN ('expedition', 'basecamp')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expbot_tg_user ON expensebot_users_telegram(user_id);

CREATE TABLE IF NOT EXISTS expensebot_pending_auth (
  chat_id     INTEGER PRIMARY KEY,
  tg_username TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

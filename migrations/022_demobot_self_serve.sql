-- DemoBot self-serve onboarding: a chat starts /start with no token, we
-- create a pending row, ask for email, then name, then promote to a real
-- users row + demobot_freelancers_telegram binding. The pending row is
-- removed on completion or abandonment (no TTL cleanup yet — table stays tiny).
CREATE TABLE IF NOT EXISTS demobot_pending_registrations (
  chat_id           INTEGER PRIMARY KEY,
  telegram_username TEXT,
  step              TEXT NOT NULL CHECK (step IN ('awaiting_email','awaiting_name')),
  email             TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demobot_pending_created_at ON demobot_pending_registrations (created_at);

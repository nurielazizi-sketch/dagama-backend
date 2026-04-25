-- SourceBot funnel email queue (the conversion engine).
-- 6 touchpoints per spec: welcome (T+0), digest (T+6pm Day 1), morning proof
-- (T+8am Day 2), midday nudge (T+2pm Day 2 if 2-day show), thank-you
-- (T+3 days post-show), retargeting (T+4 weeks pre-next-show).
CREATE TABLE IF NOT EXISTS email_queue (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  buyer_id      TEXT NOT NULL,
  show_id       TEXT,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'welcome','digest_6pm','morning_8am','midday_2pm',
                  'post_3d','retarget_4w','custom'
                )),
  scheduled_at  INTEGER NOT NULL,
  sent_at       INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error         TEXT,
  payload_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_queue_due
  ON email_queue (status, scheduled_at);

-- Behavioural event stream — the basis for /summary, weekly admin metrics,
-- conversion funnel reporting and retargeting decisions.
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  buyer_id        TEXT,
  show_id         TEXT,
  event_name      TEXT NOT NULL,
  properties_json TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_buyer ON events (buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_name  ON events (event_name, created_at);

-- Buyer timezone for delivering "6pm local" / "8am local" emails. Defaults to UTC.
ALTER TABLE sb_buyers ADD COLUMN timezone TEXT DEFAULT 'UTC';

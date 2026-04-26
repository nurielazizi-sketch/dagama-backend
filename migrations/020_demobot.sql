-- ─────────────────────────────────────────────────────────────────────────────
-- DemoBot — internal freelancer tool. Freelancers at trade shows scan a
-- prospect's business card; the system creates a service-account-owned Google
-- Sheet + Drive folder, shares both to the prospect, and runs a 4-email
-- nurture sequence pitching SourceBot.
--
-- Reuses existing infra:
--   - events / email_queue            (migration 016)
--   - referrals + sb_buyers.referral_code  (migration 017)
--   - extract.ts / google.ts / email.ts (sendTransactionalEmail)
--
-- Net-new tables here:
--   - shows_catalog                   show curation for Email 4 retargeting
--   - demobot_prospects               one row per scanned card (the "buyer"
--                                     analog before they sign up — keyed by
--                                     prospect email + freelancer + show)
--   - demobot_freelancer_demos        per-freelancer per-day rollup for the
--                                     6pm Telegram summary + comp tracking
--   - demobot_tg_updates_seen         webhook dedupe (mirrors sb_tg_updates_seen)
--
-- Schema additions:
--   - users.role                      'user' | 'freelancer' | 'admin' (default 'user')
--   - email_queue.kind CHECK adds the four DemoBot kinds
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Freelancer role on users (deferred from IMPLEMENTATION_PLAN.md Phase 2.6).
--    Freelancers log in via the same email/password flow as buyers; the role
--    column flips them into freelancer-only endpoints (/api/demobot/*) and
--    gates compensation reporting.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- 2. Shows catalog — curated list of upcoming + recent trade shows. Email 4
--    queries this to pick the "next show in this prospect's industry" 4 weeks
--    pre-start. Also referenced by freelancer attribution + anti-abuse checks.
CREATE TABLE IF NOT EXISTS shows_catalog (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  show_name       TEXT NOT NULL,
  show_location   TEXT,                   -- "Hong Kong", "Guangzhou", etc.
  start_date      TEXT NOT NULL,          -- ISO YYYY-MM-DD
  end_date        TEXT NOT NULL,          -- ISO YYYY-MM-DD
  show_length     INTEGER,                -- inferred days (end - start + 1) or override
  industry_focus  TEXT,                   -- electronics | food | textiles | machinery | chemicals | consumer | logistics | other
  website         TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shows_catalog_dates    ON shows_catalog (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_shows_catalog_industry ON shows_catalog (industry_focus);

-- 3. DemoBot prospects — one row per scanned business card. The prospect has
--    NOT signed up; this is our shadow buyer record until/if they convert.
--    On conversion, conversion_buyer_id points at the sb_buyers row that pays.
CREATE TABLE IF NOT EXISTS demobot_prospects (
  id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

  -- Who scanned the card
  freelancer_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id              TEXT REFERENCES shows_catalog(id) ON DELETE SET NULL,
  show_name_raw        TEXT,              -- denormalized in case the freelancer is at an unlisted show

  -- Card data (extracted by Gemini)
  prospect_email       TEXT NOT NULL,
  prospect_name        TEXT,
  prospect_title       TEXT,
  company              TEXT,
  phone                TEXT,
  website              TEXT,
  linkedin             TEXT,
  address              TEXT,
  detected_country     TEXT,
  detected_language    TEXT NOT NULL DEFAULT 'en',  -- per Prompt 5 country detection + locale rules
  industry             TEXT,                         -- per Prompt 2 industry classifier
  industry_confidence  TEXT,                         -- 'high' | 'low'

  -- Person photo + Gemini Prompt 3 conservative description
  person_photo_url     TEXT,
  person_description   TEXT,
  person_confidence    REAL,                         -- 0.0–1.0; <0.8 → no description used

  -- Website analysis (Prompt 4)
  website_summary_json TEXT,                         -- 7 enriched fields + quality

  -- Storage & deliverables
  card_front_url       TEXT,
  card_back_url        TEXT,
  voice_note_transcript TEXT,
  drive_folder_id      TEXT,
  drive_folder_url     TEXT,
  sheet_id             TEXT,
  sheet_url            TEXT,
  pdf_drive_file_id    TEXT,
  pdf_drive_url        TEXT,

  -- Lifecycle
  scanned_at           INTEGER NOT NULL,             -- unix epoch
  email1_sent_at       INTEGER,
  email1_opened_at     INTEGER,
  email1_clicked_at    INTEGER,
  conversion_buyer_id  TEXT REFERENCES sb_buyers(id) ON DELETE SET NULL,
  converted_at         INTEGER,

  -- Referral plumbing (referee side — referrer is on sb_buyers.referral_code)
  referrer_buyer_id    TEXT REFERENCES sb_buyers(id) ON DELETE SET NULL,
  referral_code_used   TEXT,

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),

  -- Anti-double-scan: same prospect email at same show by same freelancer is a no-op.
  UNIQUE(freelancer_user_id, show_name_raw, prospect_email)
);
CREATE INDEX IF NOT EXISTS idx_demobot_prospects_email      ON demobot_prospects (prospect_email);
CREATE INDEX IF NOT EXISTS idx_demobot_prospects_freelancer ON demobot_prospects (freelancer_user_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_demobot_prospects_show       ON demobot_prospects (show_id);
CREATE INDEX IF NOT EXISTS idx_demobot_prospects_conversion ON demobot_prospects (conversion_buyer_id);

-- 4. Per-freelancer per-day demo rollup. Updated incrementally on each scan;
--    drives the 6pm Telegram summary + the $80 base / $1 over 30 / $3 conversion comp model.
CREATE TABLE IF NOT EXISTS demobot_freelancer_demos (
  id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  freelancer_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id              TEXT REFERENCES shows_catalog(id) ON DELETE SET NULL,
  day_local            TEXT NOT NULL,              -- 'YYYY-MM-DD' in show timezone (or UTC if unknown)
  demos_count          INTEGER NOT NULL DEFAULT 0,
  conversions_count    INTEGER NOT NULL DEFAULT 0, -- updated retroactively as conversions land within 30d
  summary_sent_at      INTEGER,                    -- 6pm dispatch flag
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(freelancer_user_id, day_local)
);
CREATE INDEX IF NOT EXISTS idx_demobot_demos_freelancer ON demobot_freelancer_demos (freelancer_user_id, day_local);

-- 5. Telegram webhook dedupe (mirrors sb_tg_updates_seen for the @DaGamaShow bot).
CREATE TABLE IF NOT EXISTS demobot_tg_updates_seen (
  update_id  INTEGER PRIMARY KEY,
  seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demobot_tg_updates_seen_at ON demobot_tg_updates_seen (seen_at);

-- 6. Telegram chat ↔ freelancer mapping (separate from sb_buyers_telegram so a
--    freelancer who is also a buyer keeps each role's session distinct).
CREATE TABLE IF NOT EXISTS demobot_freelancers_telegram (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  freelancer_user_id  TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  telegram_chat_id    INTEGER NOT NULL UNIQUE,
  telegram_username   TEXT,
  session             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_demobot_freelancers_chat ON demobot_freelancers_telegram (telegram_chat_id);

-- 7. Extend email_queue.kind CHECK to allow the four DemoBot kinds. SQLite can't
--    ALTER a CHECK; we rebuild the table. New kinds:
--      demobot_e1   T+0           prospect email 1 (sent inline at scan, not via queue)
--      demobot_e2   8am Day+1     opened/clicked-gated nurture
--      demobot_e3   show_end+3d   conversion-gated post-show pitch
--      demobot_e4   next_show-28d retarget if shows_catalog has a relevant upcoming show
--
-- Inline send for e1 still emits an event; queue handles e2/e3/e4.
CREATE TABLE IF NOT EXISTS email_queue_v2 (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  buyer_id      TEXT,                                       -- nullable (DemoBot prospects don't have an sb_buyers row yet)
  show_id       TEXT,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'welcome','digest_6pm','morning_8am','midday_2pm',
                  'post_3d','retarget_4w','custom',
                  'demobot_e1','demobot_e2','demobot_e3','demobot_e4'
                )),
  prospect_id   TEXT,                                       -- demobot_prospects.id when kind starts with demobot_
  scheduled_at  INTEGER NOT NULL,
  sent_at       INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error         TEXT,
  payload_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO email_queue_v2 (id, buyer_id, show_id, kind, scheduled_at, sent_at, status, error, payload_json, created_at)
  SELECT id, buyer_id, show_id, kind, scheduled_at, sent_at, status, error, payload_json, created_at FROM email_queue;
DROP TABLE email_queue;
ALTER TABLE email_queue_v2 RENAME TO email_queue;
CREATE INDEX IF NOT EXISTS idx_email_queue_due      ON email_queue (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_email_queue_prospect ON email_queue (prospect_id);

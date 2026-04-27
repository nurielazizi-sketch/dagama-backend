-- Runtime-tunable config + audit log for the /admin console.
-- Reads happen via getConfig() in src/app_config.ts (30s in-isolate cache).
-- Writes via setConfig() update both rows in a single D1 batch.

CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  value_type  TEXT NOT NULL DEFAULT 'string',  -- string|number|bool|json
  description TEXT,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS app_config_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_config_audit_key ON app_config_audit (key, updated_at DESC);

-- Seed safe runtime tunables. updated_at = 0 means "never edited from UI" so
-- the dashboard renders these as "(default)". INSERT OR IGNORE so re-running
-- the migration doesn't clobber values changed via the admin UI.
INSERT OR IGNORE INTO app_config (key, value, value_type, description, updated_at) VALUES
  ('free_tier_scan_limit',     '10',                'number', 'Max free scans per buyer per show before paywall',                       0),
  ('free_tier_window_hours',   '24',                'number', 'Free-tier sliding window in hours (used when show duration is unknown)', 0),
  ('channel_whatsapp_enabled', 'true',              'bool',   'Master switch for WhatsApp channel (also requires WHATSAPP_* secrets)',  0),
  ('channel_telegram_enabled', 'true',              'bool',   'Master switch for Telegram BoothBot channel',                            0),
  ('channel_web_enabled',      'true',              'bool',   'Master switch for web /api/upload',                                      0),
  ('gemini_model',             'gemini-2.5-flash',  'string', 'Gemini model used for OCR + structured extraction',                      0),
  ('card_image_max_kb',        '6144',              'number', 'Soft cap on inbound card image size (kilobytes)',                        0),
  ('voice_max_seconds',        '180',               'number', 'Soft cap on voice note duration',                                        0),
  ('email_blast_daily_cap',    '200',               'number', 'Per-buyer daily cap on /api/blast recipients',                           0),
  ('show_pdf_max_suppliers',   '500',               'number', 'Max suppliers included in /api/show/pdf export',                         0);

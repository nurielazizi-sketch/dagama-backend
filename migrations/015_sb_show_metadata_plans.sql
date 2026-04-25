-- Show metadata + plan/scan tracking for SourceBot.
-- Spec: 3+ day shows get 24h unlimited from first scan; 2-day shows get 10 scans Day 1.
-- After free window, buyers must upgrade to event_49 / event_199 / team_79 / organizer_299.

ALTER TABLE sb_buyer_shows ADD COLUMN duration_days       INTEGER DEFAULT 3;
ALTER TABLE sb_buyer_shows ADD COLUMN show_start_date     TEXT;
ALTER TABLE sb_buyer_shows ADD COLUMN show_end_date       TEXT;
ALTER TABLE sb_buyer_shows ADD COLUMN first_scan_at       INTEGER;
ALTER TABLE sb_buyer_shows ADD COLUMN free_window_ends_at INTEGER;
ALTER TABLE sb_buyer_shows ADD COLUMN free_scans_limit    INTEGER;
ALTER TABLE sb_buyer_shows ADD COLUMN free_scans_used     INTEGER DEFAULT 0;
ALTER TABLE sb_buyer_shows ADD COLUMN paid_plan           TEXT;
ALTER TABLE sb_buyer_shows ADD COLUMN paid_at             INTEGER;
ALTER TABLE sb_buyer_shows ADD COLUMN stripe_session_id   TEXT;
ALTER TABLE sb_buyer_shows ADD COLUMN total_captures      INTEGER DEFAULT 0;
ALTER TABLE sb_buyer_shows ADD COLUMN last_capture_at     INTEGER;

-- Active context on the buyer record so we can support multi-show flows.
ALTER TABLE sb_buyers ADD COLUMN active_company_id TEXT;
ALTER TABLE sb_buyers ADD COLUMN current_show_id   TEXT;

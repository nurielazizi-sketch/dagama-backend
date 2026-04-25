-- Distinguish sheets owned by the service account (new flow, since Apr 2026)
-- from sheets owned by the user via their personal Gmail OAuth (legacy flow).
-- Existing rows default to 'user' so legacy BoothBot users continue working.
ALTER TABLE google_sheets ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE google_sheets ADD COLUMN drive_folder_id TEXT;
ALTER TABLE google_sheets ADD COLUMN drive_folder_url TEXT;

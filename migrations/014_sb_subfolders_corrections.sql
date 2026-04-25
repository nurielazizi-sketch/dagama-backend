-- Spec-compliant Drive layout: per-supplier folder contains Cards/ and Products/ subfolders.
ALTER TABLE sb_companies ADD COLUMN cards_subfolder_id    TEXT;
ALTER TABLE sb_companies ADD COLUMN products_subfolder_id TEXT;

-- Reply-to-correction support: each entity remembers the Telegram message id of
-- the confirmation we sent so a user reply ("Actually it's Uriel Aziz") can be
-- routed back to the right row.
ALTER TABLE sb_companies ADD COLUMN confirmation_message_id INTEGER;
ALTER TABLE sb_contacts  ADD COLUMN confirmation_message_id INTEGER;
ALTER TABLE sb_products  ADD COLUMN confirmation_message_id INTEGER;

-- Person photo + description (sheet columns AB, AC exist but had no capture path).
-- card_back_url is already present from migration 008.
ALTER TABLE sb_contacts ADD COLUMN person_photo_url   TEXT;
ALTER TABLE sb_contacts ADD COLUMN person_description TEXT;

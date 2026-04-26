-- Soft-delete columns on companies/contacts/products. interest_level was already
-- added in an earlier sb_companies migration so we skip it here.
ALTER TABLE sb_companies ADD COLUMN deleted_at INTEGER;        -- unix epoch when soft-deleted
ALTER TABLE sb_contacts  ADD COLUMN deleted_at INTEGER;
ALTER TABLE sb_products  ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_sb_companies_deleted ON sb_companies (deleted_at);
CREATE INDEX IF NOT EXISTS idx_sb_contacts_deleted  ON sb_contacts  (deleted_at);
CREATE INDEX IF NOT EXISTS idx_sb_products_deleted  ON sb_products  (deleted_at);

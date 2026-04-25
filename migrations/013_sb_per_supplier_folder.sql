-- Per-supplier Drive folder: every supplier gets its own subfolder named
-- "{Company} — {Month Year}" so cards + product photos for that supplier
-- live together. Set lazily on first save.
ALTER TABLE sb_companies ADD COLUMN cards_folder_id TEXT;

-- Per-product sheet row tracking: each product is its own row on the
-- "Products" tab. We update that row in place when details come in.
ALTER TABLE sb_products  ADD COLUMN sheet_row INTEGER;

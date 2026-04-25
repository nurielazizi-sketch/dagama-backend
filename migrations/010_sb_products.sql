-- Products captured by buyers, tied to a sb_companies row.
-- Sheet representation: aggregated into the supplier's existing row (columns
-- P=Products, Q=Price Range, R=Avg Lead Time). One D1 row per product.
CREATE TABLE IF NOT EXISTS sb_products (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id    TEXT NOT NULL,
  buyer_id      TEXT NOT NULL,
  show_name     TEXT NOT NULL,
  name          TEXT,
  description   TEXT,
  price         TEXT,                  -- free-form: "$10/unit", "TBD", "20-30 USD"
  moq           TEXT,                  -- "100 pcs", "TBD"
  lead_time     TEXT,                  -- "30 days", "TBD"
  image_url     TEXT,                  -- Drive URL for product photo
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sb_products_company ON sb_products(company_id);
CREATE INDEX IF NOT EXISTS idx_sb_products_buyer   ON sb_products(buyer_id);

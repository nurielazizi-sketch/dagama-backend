-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 026: ExpenseBot v1 schema (DRAFT — apply when ExpenseBot dev starts).
--
-- ExpenseBot is the strategic bridge between the Expedition (work / trade-show)
-- and Basecamp (life / household) halves of the DaGama product universe.
-- Every expense row carries:
--   - channel: which surface the user logged from (telegram | whatsapp | web)
--   - context: which half of the brand the expense lives in (expedition | basecamp)
--
-- This is intentional from row 1: the bridge mechanic IS the strategic wedge.
-- DO NOT add `context` later via migration — bake it in now.
--
-- Channel-agnostic identity: user_id is the canonical reference. chat_id /
-- wa_phone / web_session_id are channel-specific routing hints, optional, used
-- only for replying via the same surface where the message came from.
--
-- LLM-based natural-language extraction is first-class: extraction_* columns
-- record which model parsed the message + a confidence score, so we can audit
-- low-confidence rows and replay if the model improves.
--
-- FX is stored at entry time, not at report time — keeps reports fast and lets
-- users see "what I paid in USD when I logged it" rather than fluctuating FX.
--
-- Soft-delete (deleted_at) replaces the legacy /undo hard-delete — preserves
-- audit trail and lets users restore mistaken deletions.
-- ─────────────────────────────────────────────────────────────────────────────

-- Currency reference table (read-only seed; no FK from expenses, just a
-- canonical list to validate against in application code).
CREATE TABLE IF NOT EXISTS expense_currencies (
  code        TEXT PRIMARY KEY,                          -- ISO 4217: 'USD', 'HKD', etc.
  symbol      TEXT NOT NULL,
  name        TEXT NOT NULL,
  decimal_places INTEGER NOT NULL DEFAULT 2              -- JPY = 0, most = 2
);

INSERT OR IGNORE INTO expense_currencies (code, symbol, name, decimal_places) VALUES
  ('USD', '$',   'US Dollar',          2),
  ('EUR', '€',   'Euro',               2),
  ('GBP', '£',   'British Pound',      2),
  ('HKD', 'HK$', 'Hong Kong Dollar',   2),
  ('CNY', '¥',   'Chinese Yuan',       2),
  ('JPY', '¥',   'Japanese Yen',       0),
  ('SGD', 'S$',  'Singapore Dollar',   2),
  ('AED', 'د.إ', 'UAE Dirham',         2),
  ('ILS', '₪',   'Israeli Shekel',     2);

-- Main expenses table — one row per logged expense.
CREATE TABLE IF NOT EXISTS expenses (
  id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel                TEXT NOT NULL
                           CHECK (channel IN ('telegram', 'whatsapp', 'web')),
  context                TEXT NOT NULL
                           CHECK (context IN ('expedition', 'basecamp')),
  -- Channel-specific routing hints (optional; user_id is canonical).
  chat_id                INTEGER,
  wa_phone               TEXT,
  web_session_id         TEXT,
  -- Idempotency key for inbound message dedup. Format: '<channel>:<msg_id>'.
  source_message_id      TEXT UNIQUE,
  -- Show context (only set when context='expedition'; nullable when basecamp).
  show_name              TEXT,
  -- Categorization — free-form for v1, will tighten to a controlled vocabulary later.
  category               TEXT,
  description            TEXT,
  -- Money. amount_cents stored in original currency; amount_usd_cents is the
  -- snapshot at entry time. Both required so reports work without re-querying FX.
  amount_cents           INTEGER NOT NULL,
  currency               TEXT NOT NULL REFERENCES expense_currencies(code),
  amount_usd_cents       INTEGER,                        -- nullable until FX call succeeds
  fx_rate                REAL,                           -- snapshot of (1 unit currency → USD)
  fx_date                TEXT,                           -- date of FX snapshot, ISO 8601
  -- Receipt photo (optional). R2 key + mime type. OCR result inlined below.
  receipt_r2_key         TEXT,
  receipt_mime           TEXT,
  receipt_ocr_text       TEXT,                           -- raw OCR for debugging / re-extraction
  -- LLM extraction provenance (NULL when user typed structured input directly).
  extraction_model       TEXT,                           -- e.g. 'claude-haiku-4-5-20251001'
  extraction_confidence  REAL,                           -- 0..1; for review queue
  -- Original raw input (regardless of source modality).
  original_message       TEXT,
  -- Audit fields.
  recorded_at            TEXT NOT NULL DEFAULT (datetime('now')),
  -- expense date as the user remembers it; defaults to recorded_at, can be
  -- backdated by user ("I forgot to log this — it was yesterday").
  expense_date           TEXT NOT NULL DEFAULT (date('now')),
  deleted_at             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_expenses_user_context        ON expenses(user_id, context);
CREATE INDEX idx_expenses_user_date           ON expenses(user_id, expense_date);
CREATE INDEX idx_expenses_user_show           ON expenses(user_id, show_name)         WHERE show_name IS NOT NULL;
CREATE INDEX idx_expenses_channel             ON expenses(channel);
CREATE INDEX idx_expenses_review_queue        ON expenses(extraction_confidence)      WHERE extraction_confidence IS NOT NULL AND extraction_confidence < 0.7;
CREATE INDEX idx_expenses_active              ON expenses(user_id, deleted_at)        WHERE deleted_at IS NULL;

-- Recurring expense definitions. The application emits a row into `expenses`
-- on each `next_emit_at` and advances the timestamp by `cadence`.
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context             TEXT NOT NULL
                        CHECK (context IN ('expedition', 'basecamp')),
  description         TEXT NOT NULL,
  category            TEXT,
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL REFERENCES expense_currencies(code),
  cadence             TEXT NOT NULL
                        CHECK (cadence IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
  next_emit_at        TEXT NOT NULL,
  last_emitted_at     TEXT,
  active              INTEGER NOT NULL DEFAULT 1
                        CHECK (active IN (0, 1)),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_recurring_user           ON recurring_expenses(user_id);
CREATE INDEX idx_recurring_due            ON recurring_expenses(next_emit_at)  WHERE active = 1;

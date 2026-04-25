-- Log of follow-up emails sent from SourceBot to suppliers' contact emails.
-- The buyer's Gmail OAuth (gmail_tokens table, shared with BoothBot) is the
-- "From"; subject/body are AI-drafted via Gemini and confirmed by the buyer.
CREATE TABLE IF NOT EXISTS sb_emails_sent (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id      TEXT NOT NULL,
  buyer_id        TEXT NOT NULL,
  show_name       TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject         TEXT,
  body            TEXT,
  status          TEXT NOT NULL DEFAULT 'sent',   -- 'sent' | 'failed'
  sent_at         TEXT,
  error_msg       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sb_emails_sent_company ON sb_emails_sent(company_id);
CREATE INDEX IF NOT EXISTS idx_sb_emails_sent_buyer   ON sb_emails_sent(buyer_id);

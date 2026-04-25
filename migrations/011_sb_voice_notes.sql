-- Voice notes captured for a supplier. Gemini transcribes verbatim and extracts
-- price/MOQ/lead-time/tone keywords in a single pass. Sheet representation:
-- aggregated transcripts in the supplier row's column U (Voice Note).
CREATE TABLE IF NOT EXISTS sb_voice_notes (
  id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id           TEXT NOT NULL,
  buyer_id             TEXT NOT NULL,
  show_name            TEXT NOT NULL,
  transcript           TEXT,
  language             TEXT,                 -- best-effort detection
  duration_seconds     INTEGER,
  extracted_price      TEXT,
  extracted_moq        TEXT,
  extracted_lead_time  TEXT,
  extracted_tone       TEXT,                 -- 'positive' | 'neutral' | 'negative' | 'enthusiastic' | 'skeptical'
  audio_url            TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sb_voice_notes_company ON sb_voice_notes(company_id);
CREATE INDEX IF NOT EXISTS idx_sb_voice_notes_buyer   ON sb_voice_notes(buyer_id);

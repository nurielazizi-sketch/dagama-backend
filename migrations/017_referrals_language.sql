-- Referral mechanics. (language column already exists on sb_buyers.)
ALTER TABLE sb_buyers ADD COLUMN referral_code TEXT;
ALTER TABLE sb_buyers ADD COLUMN referred_by   TEXT;  -- referral_code of referrer

-- Backfill an 8-hex-char code for every existing buyer
UPDATE sb_buyers SET referral_code = lower(hex(randomblob(4))) WHERE referral_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_buyers_referral_code ON sb_buyers (referral_code);

CREATE TABLE IF NOT EXISTS referrals (
  id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  referrer_buyer_id  TEXT NOT NULL,
  referred_buyer_id  TEXT,            -- NULL until the referred buyer signs up
  referred_email     TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','signed_up','paid','rewarded')),
  reward_credited_at INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_buyer_id);

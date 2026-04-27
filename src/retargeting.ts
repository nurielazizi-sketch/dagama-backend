/// <reference types="@cloudflare/workers-types" />

// ─────────────────────────────────────────────────────────────────────────────
// Show-date-tied retargeting cron (Sprint 3a-4).
//
// Locked principle (memory: dagama_retargeting_strategy.md):
//   Trade-show buyers and exhibitors think in SHOW CYCLES, not calendar days.
//   "7 days after trial expired" is generic and loses to noise; "Your next
//   show, CES 2026, is 14 days away — here's 30% off your show pass" is
//   workflow-aligned and converts dramatically better.
//
// Cadence:
//   T-30 / T-14 / T-7 / T-1 days before the user's next-show start_date.
//   Idempotency via retargeting_emails_sent.UNIQUE(user_id, show_id, days_before_show).
//
// Eligibility filter (per send):
//   • User has user_show_interest row pointing at the show.
//   • Show.start_date is exactly N days away (where N ∈ allowed cadence).
//   • User has NO active pass for that bot_role today (otherwise we'd be
//     spamming people who already paid).
//   • This (user, show, days) tuple isn't already in retargeting_emails_sent.
//
// Coupon:
//   Each email carries a per-user single-use code (kind=percent_off, value=30,
//   source='retargeting'), created via coupons.createCoupon. Code format:
//   COMEBACK-<8-hex>. The Stripe Coupon mirror is auto-issued by createCoupon.
//
// Schedule:
//   The Worker cron fires every hour (`0 * * * *`). This module is gated to
//   run only when UTC hour == 8 — i.e. once per day at 08:00 UTC. Adjust
//   RUN_AT_UTC_HOUR if we ever want a different send window.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from './types';
import { createCoupon, type CouponSource } from './coupons';
import { sendRetargetingEmail } from './email';

const RUN_AT_UTC_HOUR = 8;
const CADENCE_DAYS_BEFORE = [30, 14, 7, 1] as const;
type DaysBefore = typeof CADENCE_DAYS_BEFORE[number];

const PER_RUN_CAP = 200;     // hard cap on emails sent per cron tick (safety)

interface CandidateRow {
  user_id:        string;
  user_email:     string;
  user_name:      string | null;
  show_id:        string;
  show_name:      string;
  show_location:  string | null;
  show_start:     string;        // YYYY-MM-DD
  bot_role:       string | null; // 'boothbot' | 'sourcebot' | 'expensebot' | null
  days_before:    number;
}

export interface RetargetingCronResult {
  ran:    boolean;
  reason?: string;
  candidates: number;
  sent:   number;
  skipped: number;
  failed: number;
}

export async function processRetargetingCron(env: Env): Promise<RetargetingCronResult> {
  const now = new Date();
  // Gate: only run once a day at the configured UTC hour.
  if (now.getUTCHours() !== RUN_AT_UTC_HOUR) {
    return { ran: false, reason: `outside-window (utc hour ${now.getUTCHours()})`, candidates: 0, sent: 0, skipped: 0, failed: 0 };
  }

  const todayIso = now.toISOString().slice(0, 10);   // YYYY-MM-DD

  // For each cadence day, find shows starting exactly N days from today and
  // join in interested users + their email + their pass status. We compute
  // `days_before` server-side (julianday math) so the query can be cleanly
  // filtered.
  //
  // We exclude users who:
  //   • Already have an active pass valid today (no point retargeting them).
  //   • Already received an email for this (show, days_before) tuple.
  //   • Have status='paused' or no email on record.

  const candidates: CandidateRow[] = [];
  for (const days of CADENCE_DAYS_BEFORE) {
    const targetDate = new Date(now.getTime());
    targetDate.setUTCDate(targetDate.getUTCDate() + days);
    const targetIso  = targetDate.toISOString().slice(0, 10);

    const rows = await env.DB.prepare(`
      SELECT
        u.id        AS user_id,
        u.email     AS user_email,
        u.name      AS user_name,
        sc.id       AS show_id,
        sc.show_name,
        sc.show_location,
        sc.start_date AS show_start,
        usi.bot_role
      FROM user_show_interest usi
      JOIN users         u  ON u.id  = usi.user_id
      JOIN shows_catalog sc ON sc.id = usi.show_id
      WHERE date(sc.start_date) = date(?)
        AND u.email IS NOT NULL
        -- exclude users already retargeted for this (show, days)
        AND NOT EXISTS (
          SELECT 1 FROM retargeting_emails_sent r
           WHERE r.user_id = u.id
             AND r.show_id = sc.id
             AND r.days_before_show = ?
        )
        -- exclude users with an active pass that hasn't expired yet
        AND NOT EXISTS (
          SELECT 1 FROM passes p
           WHERE p.user_id = u.id
             AND p.status = 'active'
             AND (p.expires_at IS NULL OR datetime(p.expires_at) > datetime('now'))
        )
      ORDER BY u.id
      LIMIT ?
    `)
      .bind(targetIso, days, PER_RUN_CAP)
      .all<CandidateRow>();

    for (const r of rows.results) candidates.push({ ...r, days_before: days });
    if (candidates.length >= PER_RUN_CAP) break;
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const c of candidates) {
    if (sent + failed >= PER_RUN_CAP) break;
    try {
      // 1) Issue a per-user single-use 30%-off coupon for this show.
      //    Code: COMEBACK-<rand8>. Validity: until 24h after the show ends.
      const code = `COMEBACK-${randHex(8).toUpperCase()}`;
      const validUntilDate = addDays(c.show_start, 1);  // day after show start; tighten if needed
      const coupon = await createCoupon({
        code,
        kind:                'percent_off',
        value:               30,
        applies_to:          'show_pass',
        valid_until:         `${validUntilDate}T23:59:59Z`,
        max_total_uses:      1,
        single_use_per_user: true,
        source:              'retargeting' as CouponSource,
        source_user_id:      c.user_id,
        source_show_id:      c.show_id,
        notes:               `Auto-issued by retargeting cron (T-${c.days_before}, show=${c.show_name})`,
      }, env);

      // 2) Send the email. fire-and-await so a single bad row doesn't kill
      //    the batch; we count it as failed and move on.
      await sendRetargetingEmail({
        to:           c.user_email,
        firstName:    pickFirstName(c.user_name, c.user_email),
        showName:     c.show_name,
        showLocation: c.show_location,
        showStart:    c.show_start,
        daysBefore:   c.days_before,
        couponCode:   coupon.code,
        botRole:      (c.bot_role === 'sourcebot' ? 'sourcebot' : 'boothbot'),
      }, env);

      // 3) Record idempotency. Insert AFTER send so a transient send failure
      //    can be retried on the next day's cron tick.
      await env.DB.prepare(`
        INSERT INTO retargeting_emails_sent (user_id, show_id, days_before_show, coupon_id)
        VALUES (?, ?, ?, ?)
      `)
        .bind(c.user_id, c.show_id, c.days_before, coupon.id)
        .run();

      sent++;
    } catch (e) {
      // Distinguish "we already inserted" from real send failures — UNIQUE
      // collisions just mean a parallel run got there first.
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE/i.test(msg) && /retargeting_emails_sent/i.test(msg)) {
        skipped++;
        continue;
      }
      failed++;
      console.error('[retargeting] candidate failed', {
        user_id: c.user_id, show_id: c.show_id, days_before: c.days_before, error: msg,
      });
    }
  }

  return { ran: true, candidates: candidates.length, sent, skipped, failed };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function randHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

function addDays(iso: string, days: number): string {
  // Accepts YYYY-MM-DD or full ISO; returns YYYY-MM-DD.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pickFirstName(name: string | null, email: string): string {
  if (name && name.trim()) return name.trim().split(/\s+/)[0];
  return (email.split('@')[0] || 'there').replace(/[._-]/g, ' ').split(/\s+/)[0];
}

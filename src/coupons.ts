/// <reference types="@cloudflare/workers-types" />

// ─────────────────────────────────────────────────────────────────────────────
// Coupon engine. Schema lives in migrations/032_coupons_and_retargeting.sql.
//
// Design (locked 2026-04-27):
//   • Local `coupons` table is the source of truth — one row per code.
//   • For Stripe-backed kinds (percent_off, fixed_off_cents) we mirror to a
//     Stripe Coupon object so Checkout can apply by ID. The mirror happens at
//     coupon-CREATE time, not at redemption — Stripe needs the object to exist
//     before its Promotion Code / Checkout flows can reference it.
//   • For the SaaS-only kind `free_extension_hours` (extends an active pass)
//     there's no Stripe analogue — we manipulate `passes.expires_at` directly.
//   • Single-use-per-user is enforced atomically via INSERT into
//     coupon_redemptions; the parent flag `coupons.single_use_per_user`
//     gates whether duplicate-redemption checks run at all.
//   • Total-uses cap is enforced via UPDATE … WHERE total_uses < max_total_uses
//     (atomic increment) so two concurrent redemptions can't both succeed past
//     the cap.
//
// Provenance:
//   `source` records WHERE the code came from — admin manual issue, daily
//   retargeting cron, partner promo, referral, or launch promo. Retargeting
//   codes are 1:1 with `source_user_id` so we can audit "did this user ever
//   redeem the comeback offer we sent them" cleanly.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from './types';

// ── Types ────────────────────────────────────────────────────────────────────

export type CouponKind   = 'percent_off' | 'fixed_off_cents' | 'free_extension_hours';
export type CouponScope  = 'any' | 'show_pass' | 'three_show_pack' | 'team_unlimited' | 'expensebot_standalone';
export type CouponSource = 'admin' | 'retargeting' | 'partner' | 'referral' | 'launch_promo';
export type CouponStatus = 'active' | 'paused' | 'revoked';
export type AppliedToKind = 'pass' | 'subscription' | 'free_extension';

export interface CouponRow {
  id:                  string;
  code:                string;
  stripe_coupon_id:    string | null;
  kind:                CouponKind;
  value:               number;
  applies_to:          CouponScope;
  valid_from:          string | null;
  valid_until:         string | null;
  max_total_uses:      number | null;
  total_uses:          number;
  single_use_per_user: 0 | 1;
  source:              CouponSource;
  source_user_id:      string | null;
  source_show_id:      string | null;
  notes:               string | null;
  status:              CouponStatus;
  created_at:          string;
  updated_at:          string;
}

export interface CreateCouponInput {
  code:                string;          // case-preserved; we look up case-INSENSITIVE
  kind:                CouponKind;
  value:               number;
  applies_to?:         CouponScope;     // default 'any'
  valid_from?:         string;          // ISO datetime
  valid_until?:        string;          // ISO datetime
  max_total_uses?:     number;
  single_use_per_user?: boolean;        // default true
  source:              CouponSource;
  source_user_id?:     string;
  source_show_id?:     string;
  notes?:              string;
}

export type ValidateOk    = { ok: true;  coupon: CouponRow };
export type ValidateError = {
  ok:     false;
  reason: 'not_found' | 'revoked' | 'paused' | 'not_yet_valid' | 'expired'
        | 'cap_reached' | 'wrong_scope' | 'already_redeemed_by_user';
  message: string;
};

// ── Public API: validate ─────────────────────────────────────────────────────
// Returns ok=true with the row when the coupon is good to apply for this user
// (and optional scope). Side-effect-free — a redeem call does the actual
// increment + redemption record.

export async function validateCoupon(
  code:    string,
  userId:  string | null,
  scope:   CouponScope | null,
  env:     Env,
): Promise<ValidateOk | ValidateError> {
  const row = await env.DB
    .prepare(`SELECT * FROM coupons WHERE lower(code) = lower(?) LIMIT 1`)
    .bind(code.trim())
    .first<CouponRow>();
  if (!row) return { ok: false, reason: 'not_found',  message: 'Coupon code not found.' };

  if (row.status === 'revoked') return { ok: false, reason: 'revoked', message: 'This coupon has been revoked.' };
  if (row.status === 'paused')  return { ok: false, reason: 'paused',  message: 'This coupon is paused.' };

  const nowIso = new Date().toISOString();
  if (row.valid_from  && nowIso < row.valid_from)  return { ok: false, reason: 'not_yet_valid', message: 'This coupon is not active yet.' };
  if (row.valid_until && nowIso > row.valid_until) return { ok: false, reason: 'expired',       message: 'This coupon has expired.' };

  if (row.max_total_uses !== null && row.total_uses >= row.max_total_uses) {
    return { ok: false, reason: 'cap_reached', message: 'This coupon has reached its usage limit.' };
  }

  if (scope && row.applies_to !== 'any' && row.applies_to !== scope) {
    return { ok: false, reason: 'wrong_scope', message: 'This coupon does not apply to this purchase.' };
  }

  if (userId && row.single_use_per_user === 1) {
    const prior = await env.DB
      .prepare(`SELECT 1 FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ? LIMIT 1`)
      .bind(row.id, userId)
      .first<{ '1': 1 }>();
    if (prior) return { ok: false, reason: 'already_redeemed_by_user', message: 'You have already used this coupon.' };
  }

  return { ok: true, coupon: row };
}

// ── Public API: redeem ───────────────────────────────────────────────────────
// Atomically:
//   1. re-validates,
//   2. increments coupons.total_uses (gated on the cap),
//   3. inserts coupon_redemptions row.
// On failure (race on cap or duplicate redemption), returns the same shape
// validateCoupon returns.
//
// `appliedTo` + `appliedToKind` identify what the coupon applied to — typically
// the new passes.id or stripe subscription.id. discountCents is the actual
// cents saved (post-Stripe response, when known); pass null at issue time and
// patch later if you need post-hoc reconciliation.

export interface RedeemArgs {
  code:           string;
  userId:         string;
  appliedTo:      string;
  appliedToKind:  AppliedToKind;
  scope?:         CouponScope;
  discountCents?: number;
}

export async function redeemCoupon(args: RedeemArgs, env: Env): Promise<ValidateOk | ValidateError> {
  const v = await validateCoupon(args.code, args.userId, args.scope ?? null, env);
  if (!v.ok) return v;

  // Atomic-ish cap enforcement: only bump total_uses if still under cap.
  // SQLite + D1 don't have row-level locks, so we use the WHERE clause as the
  // guard. If the UPDATE affects 0 rows, another concurrent redeem hit the cap.
  const updateRes = await env.DB.prepare(
    v.coupon.max_total_uses === null
      ? `UPDATE coupons SET total_uses = total_uses + 1, updated_at = datetime('now') WHERE id = ?`
      : `UPDATE coupons SET total_uses = total_uses + 1, updated_at = datetime('now')
          WHERE id = ? AND total_uses < ?`
  )
    .bind(...(v.coupon.max_total_uses === null
      ? [v.coupon.id]
      : [v.coupon.id, v.coupon.max_total_uses]))
    .run();
  // D1 exposes meta.changes — when 0, the cap was hit between validate and update.
  const changes = updateRes.meta?.changes ?? 0;
  if (changes === 0) {
    return { ok: false, reason: 'cap_reached', message: 'This coupon just hit its usage limit.' };
  }

  // Record the redemption. If a UNIQUE constraint or duplicate slips through
  // (shouldn't, since we validated single_use_per_user above), roll back the
  // coupon counter to keep total_uses honest.
  try {
    await env.DB.prepare(
      `INSERT INTO coupon_redemptions (coupon_id, user_id, applied_to, applied_to_kind, discount_cents)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(v.coupon.id, args.userId, args.appliedTo, args.appliedToKind, args.discountCents ?? null)
      .run();
  } catch (e) {
    await env.DB.prepare(`UPDATE coupons SET total_uses = total_uses - 1 WHERE id = ?`).bind(v.coupon.id).run();
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[coupons] redemption insert failed', { coupon_id: v.coupon.id, user_id: args.userId, error: msg });
    return { ok: false, reason: 'already_redeemed_by_user', message: 'You have already used this coupon.' };
  }

  return v;
}

// ── Public API: create ───────────────────────────────────────────────────────
// Used by:
//   • POST /api/admin/coupons (manual partner / launch / show codes)
//   • The retargeting cron (per-user single-use codes)
//   • Future: referral tracking job
//
// For Stripe-backed kinds we mirror to api.stripe.com/v1/coupons before
// committing — if Stripe rejects the value (e.g. percent_off > 100), we fail
// the whole create rather than persist a coupon Checkout can't apply.

export async function createCoupon(input: CreateCouponInput, env: Env): Promise<CouponRow> {
  // Validate inputs early to avoid round-tripping bad data to Stripe.
  const code = input.code.trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) {
    throw new Error(`Invalid code "${input.code}" — alnum + _- only, 2-40 chars.`);
  }
  if (input.value <= 0) throw new Error('Coupon value must be positive.');
  if (input.kind === 'percent_off' && input.value > 100) {
    throw new Error('percent_off value cannot exceed 100.');
  }

  // Mirror to Stripe up-front for purchase-discount kinds.
  let stripeCouponId: string | null = null;
  if (input.kind === 'percent_off' || input.kind === 'fixed_off_cents') {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY missing — cannot mirror coupon to Stripe.');
    }
    stripeCouponId = await createStripeCoupon(input, code, env);
  }

  // Insert local row (UNIQUE(code) protects against duplicates). If Stripe
  // succeeded but local insert fails (highly unlikely), the orphan Stripe
  // coupon stays — admin can clean it up. We don't try to roll back Stripe;
  // it's a side-effect-only API and idempotency keys would be the right fix
  // for a v2 if this ever bites us.
  const inserted = await env.DB
    .prepare(`
      INSERT INTO coupons (
        code, stripe_coupon_id, kind, value, applies_to,
        valid_from, valid_until, max_total_uses, single_use_per_user,
        source, source_user_id, source_show_id, notes, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      RETURNING *
    `)
    .bind(
      code,
      stripeCouponId,
      input.kind,
      input.value,
      input.applies_to ?? 'any',
      input.valid_from ?? null,
      input.valid_until ?? null,
      input.max_total_uses ?? null,
      input.single_use_per_user === false ? 0 : 1,
      input.source,
      input.source_user_id ?? null,
      input.source_show_id ?? null,
      input.notes ?? null,
    )
    .first<CouponRow>();
  if (!inserted) throw new Error('Failed to insert coupon row');
  return inserted;
}

// ── Public API: revoke / pause ───────────────────────────────────────────────
// Soft delete: status='revoked' stops future redemptions but keeps the row
// (and its redemptions) for accounting. We don't revoke the Stripe object —
// Stripe accepts further redemptions until they expire, but our checkout
// flow blocks before getting that far. If you need to invalidate Stripe-side
// too, call the Stripe API explicitly; that's a billing-side decision.

export async function setCouponStatus(couponId: string, status: CouponStatus, env: Env): Promise<void> {
  await env.DB
    .prepare(`UPDATE coupons SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(status, couponId)
    .run();
}

// ── Stripe sync ──────────────────────────────────────────────────────────────
// Mirrors a coupon to api.stripe.com/v1/coupons. Returns the Stripe Coupon ID,
// which we store in coupons.stripe_coupon_id so Checkout can reference it.
// We don't create a Promotion Code (that's the user-facing alias); the
// /api/coupons/validate endpoint validates against the local table and the
// frontend then passes the stripe_coupon_id (not the user-visible code) into
// Checkout's `discounts[0][coupon]` field.

async function createStripeCoupon(
  input: CreateCouponInput,
  code:  string,
  env:   Env,
): Promise<string> {
  // Stripe coupon `id` must be ≤ 64 chars; safe since our code regex is ≤ 40.
  // We use our local code as the Stripe ID for symmetry — easier to grep.
  const params: Record<string, string> = {
    id:       code,
    duration: 'once',           // SaaS one-shot model. For team_plan repeating
                                // discounts we'd switch to 'repeating' with
                                // duration_in_months — not in v1.
    name:     code,
    'metadata[source]': input.source,
  };
  if (input.kind === 'percent_off')      params.percent_off  = String(input.value);
  if (input.kind === 'fixed_off_cents')  { params.amount_off = String(input.value); params.currency = 'usd'; }
  if (input.max_total_uses) params.max_redemptions = String(input.max_total_uses);
  if (input.valid_until) {
    // Stripe wants Unix seconds.
    const ts = Math.floor(new Date(input.valid_until).getTime() / 1000);
    if (Number.isFinite(ts)) params.redeem_by = String(ts);
  }
  if (input.source_user_id) params['metadata[source_user_id]'] = input.source_user_id;
  if (input.source_show_id) params['metadata[source_show_id]'] = input.source_show_id;

  const res = await fetch('https://api.stripe.com/v1/coupons', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Idempotency-Key prevents duplicate Stripe coupons on retry.
      'Idempotency-Key': `coupon-create-${code}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json() as { id?: string; error?: { message?: string; code?: string } };
  if (!res.ok || !data.id) {
    // If Stripe says the coupon already exists with the same ID (idempotent
    // retry from a prior run), we treat it as success — the row is the same.
    if (data.error?.code === 'coupon_already_exists' || data.error?.code === 'resource_already_exists') {
      return code;
    }
    throw new Error(`Stripe coupon create failed: ${data.error?.message ?? res.statusText}`);
  }
  return data.id;
}

// ── Public API: free extension (non-Stripe redemption side-effect) ───────────
// The `free_extension_hours` kind doesn't discount a Stripe purchase — it
// extends an existing pass's expires_at. Caller looks up the user's most
// recent active free_24h or paid pass and we push expires_at forward.

export async function applyFreeExtension(
  couponRow: CouponRow,
  userId:    string,
  env:       Env,
): Promise<{ ok: true; pass_id: string; new_expires_at: string } | { ok: false; reason: string }> {
  if (couponRow.kind !== 'free_extension_hours') {
    return { ok: false, reason: 'wrong_kind' };
  }
  // Find the user's most-recently-activated pass — even if expired, we can
  // resurrect it by pushing expires_at forward. Status flips back to 'active'
  // because we just bought them more time.
  const pass = await env.DB
    .prepare(`
      SELECT id, expires_at FROM passes
       WHERE user_id = ?
       ORDER BY started_at DESC NULLS LAST, created_at DESC
       LIMIT 1
    `)
    .bind(userId)
    .first<{ id: string; expires_at: string | null }>();
  if (!pass) return { ok: false, reason: 'no_pass_to_extend' };

  // New expires_at = max(now, current expires_at) + value hours.
  const baseSql = `MAX(datetime('now'), COALESCE(expires_at, datetime('now')))`;
  const updated = await env.DB
    .prepare(`
      UPDATE passes
         SET expires_at  = datetime(${baseSql}, '+' || ? || ' hours'),
             status      = 'active',
             updated_at  = datetime('now')
       WHERE id = ?
       RETURNING expires_at
    `)
    .bind(couponRow.value, pass.id)
    .first<{ expires_at: string }>();
  if (!updated) return { ok: false, reason: 'pass_update_failed' };

  return { ok: true, pass_id: pass.id, new_expires_at: updated.expires_at };
}

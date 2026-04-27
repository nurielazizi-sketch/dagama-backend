/// <reference types="@cloudflare/workers-types" />

// ─────────────────────────────────────────────────────────────────────────────
// HTTP surface for the coupon engine. Library lives in src/coupons.ts.
//
//   GET  /api/coupons/validate?code=…&scope=…   public  — no side effects
//   POST /api/coupons/redeem                     auth    — caller is the user
//   POST /api/admin/coupons                      admin   — issue new coupon
//   GET  /api/admin/coupons                      admin   — list / search
//   POST /api/admin/coupons/:id/revoke           admin   — soft-revoke
//
// Stripe integration: when /redeem applies a discount to a Checkout flow,
// the frontend gets back the `stripe_coupon_id` so it can pass it as
// `discounts[0][coupon]` on the Checkout Session create call. We don't run
// the Checkout from this endpoint — that stays in stripe.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from './types';
import { requireAuth } from './auth';
import { requireAdminUser } from './admin';
import {
  validateCoupon,
  redeemCoupon,
  createCoupon,
  setCouponStatus,
  applyFreeExtension,
  type CouponScope,
  type CouponSource,
  type CouponKind,
  type AppliedToKind,
  type CreateCouponInput,
} from './coupons';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── GET /api/coupons/validate ────────────────────────────────────────────────
// Public — no auth. Used by:
//   • The website Checkout drawer when the user types a promo code
//   • The chat widget if we surface an "Apply code" button
// Returns the coupon shape WITHOUT the source_user_id / notes (admin-only).

export async function handleValidateCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url   = new URL(request.url);
  const code  = (url.searchParams.get('code')  ?? '').trim();
  const scope = (url.searchParams.get('scope') ?? '').trim() as CouponScope | '';
  if (!code) return json({ error: 'code is required' }, 400);

  // If a logged-in user is making the call, pass their userId so we can apply
  // single_use_per_user checks. Anonymous validation skips that gate (the
  // /redeem endpoint enforces it again at apply-time).
  const auth = await requireAuth(request, env);
  const userId = auth instanceof Response ? null : auth.userId;

  const v = await validateCoupon(code, userId, scope || null, env);
  if (!v.ok) return json({ ok: false, reason: v.reason, message: v.message }, 200);

  // Strip admin-only fields before returning to the client.
  const c = v.coupon;
  return json({
    ok:                  true,
    code:                c.code,
    kind:                c.kind,
    value:               c.value,
    applies_to:          c.applies_to,
    valid_until:         c.valid_until,
    stripe_coupon_id:    c.stripe_coupon_id,
    single_use_per_user: c.single_use_per_user === 1,
  });
}

// ── POST /api/coupons/redeem ─────────────────────────────────────────────────
// Auth required. Body: { code, applied_to, applied_to_kind, scope?, discount_cents? }
//
// `applied_to` is the ID of the thing being discounted — typically a freshly
// created Stripe checkout_session.id, subscription.id, or pass.id. The
// caller is responsible for creating that target FIRST and passing the ID.
//
// For free_extension_hours coupons there's no Stripe target — caller passes
// applied_to_kind='free_extension', and we extend the user's most-recent
// pass.expires_at. The `applied_to` field is required by schema; pass the
// resulting pass.id (or any opaque audit string).

export async function handleRedeemCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: {
    code?:             string;
    applied_to?:       string;
    applied_to_kind?:  AppliedToKind;
    scope?:            CouponScope;
    discount_cents?:   number;
  };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const code = (body.code ?? '').trim();
  if (!code)                  return json({ error: 'code is required' }, 400);
  if (!body.applied_to)       return json({ error: 'applied_to is required' }, 400);
  if (!body.applied_to_kind)  return json({ error: 'applied_to_kind is required' }, 400);

  const result = await redeemCoupon({
    code,
    userId:        auth.userId,
    appliedTo:     body.applied_to,
    appliedToKind: body.applied_to_kind,
    scope:         body.scope,
    discountCents: body.discount_cents,
  }, env);
  if (!result.ok) return json({ ok: false, reason: result.reason, message: result.message }, 200);

  // For free_extension_hours, also push the pass clock here. We do this
  // after the redemption row so the audit trail records the redemption
  // even if the extension fails (then the admin can investigate).
  if (result.coupon.kind === 'free_extension_hours') {
    const ext = await applyFreeExtension(result.coupon, auth.userId, env);
    if (!ext.ok) {
      console.error('[coupons] free_extension applied but pass extension failed', { user_id: auth.userId, reason: ext.reason });
      return json({
        ok: true,
        coupon: { code: result.coupon.code, kind: result.coupon.kind, value: result.coupon.value },
        warning: 'Coupon recorded but pass extension failed — contact support.',
      }, 200);
    }
    return json({
      ok: true,
      coupon: { code: result.coupon.code, kind: result.coupon.kind, value: result.coupon.value },
      pass_id:        ext.pass_id,
      new_expires_at: ext.new_expires_at,
    });
  }

  return json({
    ok: true,
    coupon: {
      code:             result.coupon.code,
      kind:             result.coupon.kind,
      value:            result.coupon.value,
      stripe_coupon_id: result.coupon.stripe_coupon_id,
    },
  });
}

// ── POST /api/admin/coupons ──────────────────────────────────────────────────
// Admin issues a coupon (manual partner promo, seasonal code, retargeting
// override, etc.). Body matches CreateCouponInput.

export async function handleAdminCreateCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const ctx = await requireAdminUser(request, env);
  if (ctx instanceof Response) return ctx;

  let body: Partial<CreateCouponInput>;
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const required: Array<keyof CreateCouponInput> = ['code', 'kind', 'value', 'source'];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === '') {
      return json({ error: `${k} is required` }, 400);
    }
  }

  // Defensive narrowing — the regex / value-range / Stripe checks live in
  // createCoupon(), which throws with a precise message we relay to the admin.
  try {
    const created = await createCoupon({
      code:                body.code as string,
      kind:                body.kind as CouponKind,
      value:               Number(body.value),
      applies_to:          body.applies_to,
      valid_from:          body.valid_from,
      valid_until:         body.valid_until,
      max_total_uses:      body.max_total_uses,
      single_use_per_user: body.single_use_per_user,
      source:              body.source as CouponSource,
      source_user_id:      body.source_user_id,
      source_show_id:      body.source_show_id,
      notes:               body.notes,
    }, env);
    return json({ ok: true, coupon: created }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Best-effort surface of the underlying cause (Stripe rejection, dup code, etc.).
    const isDupCode = /UNIQUE.*coupons\.code/i.test(msg);
    return json({ error: msg }, isDupCode ? 409 : 400);
  }
}

// ── GET /api/admin/coupons ───────────────────────────────────────────────────
// List + search. Query params:
//   ?status=active|paused|revoked   (default: active)
//   ?source=admin|retargeting|partner|referral|launch_promo
//   ?code_prefix=COMEBACK
//   ?limit=50  (default 50, max 200)

export async function handleAdminListCoupons(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const ctx = await requireAdminUser(request, env);
  if (ctx instanceof Response) return ctx;

  const url    = new URL(request.url);
  const status = url.searchParams.get('status') ?? 'active';
  const source = url.searchParams.get('source');
  const prefix = url.searchParams.get('code_prefix');
  const limit  = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);

  const wheres: string[] = [];
  const binds:  unknown[] = [];
  if (status && status !== 'all') {
    wheres.push('status = ?');
    binds.push(status);
  }
  if (source) {
    wheres.push('source = ?');
    binds.push(source);
  }
  if (prefix) {
    wheres.push('code LIKE ?');
    binds.push(`${prefix}%`);
  }
  const sql = `
    SELECT id, code, stripe_coupon_id, kind, value, applies_to,
           valid_from, valid_until, max_total_uses, total_uses,
           single_use_per_user, source, source_user_id, source_show_id,
           notes, status, created_at, updated_at
      FROM coupons
     ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ coupons: rows.results });
}

// ── POST /api/admin/coupons/:id/revoke ───────────────────────────────────────
// Admin disables a coupon. Existing redemptions stay (accounting is forever).

export async function handleAdminRevokeCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const ctx = await requireAdminUser(request, env);
  if (ctx instanceof Response) return ctx;

  const url = new URL(request.url);
  const m = url.pathname.match(/\/api\/admin\/coupons\/([^/]+)\/revoke$/);
  if (!m) return json({ error: 'Invalid coupon id' }, 400);
  const couponId = decodeURIComponent(m[1]);

  await setCouponStatus(couponId, 'revoked', env);
  return json({ ok: true, coupon_id: couponId, status: 'revoked' });
}

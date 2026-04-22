/// <reference types="@cloudflare/workers-types" />

import { requireAuth } from './auth';
import type { Env } from './types';

const STRIPE_API = 'https://api.stripe.com/v1';

type Plan = 'single_show' | '3_show_pack' | 'team_plan';

const PLAN_CONFIG: Record<Plan, { label: string; mode: 'payment' | 'subscription'; shows: number | null }> = {
  single_show:  { label: 'Single Show',   mode: 'payment',      shows: 1    },
  '3_show_pack':  { label: '3-Show Pack',   mode: 'payment',      shows: 3    },
  team_plan:    { label: 'Team Plan',     mode: 'subscription', shows: null },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stripePost(path: string, params: Record<string, string>, secretKey: string): Promise<Response> {
  return fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
}

// ── POST /api/stripe/checkout ─────────────────────────────────────────────────

export async function handleCreateCheckout(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: { plan?: string };
  try { body = await request.json() as typeof body; } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const plan = body.plan as Plan;
  if (!PLAN_CONFIG[plan]) return jsonResponse({ error: 'Invalid plan. Use: single_show, 3_show_pack, team_plan' }, 400);

  const priceId = getPriceId(plan, env);
  if (!priceId || priceId.startsWith('price_placeholder')) {
    return jsonResponse({ error: 'Stripe price IDs not configured yet' }, 503);
  }

  const config = PLAN_CONFIG[plan];
  const origin = env.ORIGIN;

  // Create or retrieve Stripe customer
  const customerId = await getOrCreateCustomer(auth.userId, auth.email, env);

  const params: Record<string, string> = {
    'customer': customerId,
    'mode': config.mode,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'success_url': `${origin}/dashboard?payment=success&plan=${plan}`,
    'cancel_url': `${origin}/dashboard?payment=canceled`,
    'metadata[user_id]': auth.userId,
    'metadata[plan]': plan,
    'allow_promotion_codes': 'true',
  };

  if (config.mode === 'subscription') {
    params['subscription_data[metadata][user_id]'] = auth.userId;
    params['subscription_data[metadata][plan]'] = plan;
  }

  const res = await stripePost('/checkout/sessions', params, env.STRIPE_SECRET_KEY);
  const session = await res.json() as { id?: string; url?: string; error?: { message: string } };

  if (!res.ok || !session.url) {
    return jsonResponse({ error: session.error?.message ?? 'Failed to create checkout session' }, 502);
  }

  // Record pending subscription in D1
  await env.DB.prepare(
    `INSERT OR IGNORE INTO subscriptions (user_id, stripe_customer_id, stripe_session_id, plan, status, shows_remaining)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).bind(auth.userId, customerId, session.id, plan, config.shows).run();

  return jsonResponse({ url: session.url });
}

// ── POST /api/stripe/webhook ──────────────────────────────────────────────────

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';

  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  let event: { type: string; data: { object: Record<string, unknown> } };
  try { event = JSON.parse(rawBody); } catch { return new Response('Bad request', { status: 400 }); }

  if (event.type === 'checkout.session.completed') {
    await handleCheckoutCompleted(event.data.object, env);
  }

  if (event.type === 'customer.subscription.deleted') {
    await handleSubscriptionCanceled(event.data.object, env);
  }

  return new Response('OK', { status: 200 });
}

// ── GET /api/stripe/portal ────────────────────────────────────────────────────

export async function handleBillingPortal(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const sub = await env.DB.prepare(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1`
  ).bind(auth.userId).first<{ stripe_customer_id: string }>();

  if (!sub?.stripe_customer_id) return jsonResponse({ error: 'No active subscription found' }, 404);

  const res = await stripePost('/billing_portal/sessions', {
    customer: sub.stripe_customer_id,
    return_url: `${env.ORIGIN}/dashboard`,
  }, env.STRIPE_SECRET_KEY);

  const portal = await res.json() as { url?: string; error?: { message: string } };
  if (!res.ok || !portal.url) return jsonResponse({ error: portal.error?.message ?? 'Failed to open portal' }, 502);

  return jsonResponse({ url: portal.url });
}

// ── GET /api/stripe/status ────────────────────────────────────────────────────

export async function handleSubscriptionStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const sub = await env.DB.prepare(
    `SELECT plan, status, shows_remaining, activated_at, expires_at FROM subscriptions
     WHERE user_id = ? AND status = 'active' ORDER BY activated_at DESC LIMIT 1`
  ).bind(auth.userId).first<{ plan: string; status: string; shows_remaining: number | null; activated_at: string; expires_at: string | null }>();

  if (!sub) return jsonResponse({ active: false });

  return jsonResponse({
    active: true,
    plan: sub.plan,
    label: PLAN_CONFIG[sub.plan as Plan]?.label ?? sub.plan,
    shows_remaining: sub.shows_remaining,
    activated_at: sub.activated_at,
    expires_at: sub.expires_at,
  });
}

// ── Webhook event handlers ────────────────────────────────────────────────────

async function handleCheckoutCompleted(session: Record<string, unknown>, env: Env): Promise<void> {
  const sessionId = session['id'] as string;
  const metadata = session['metadata'] as Record<string, string> | null;
  const userId = metadata?.['user_id'];
  const plan = metadata?.['plan'] as Plan | undefined;
  const customerId = session['customer'] as string;
  const subscriptionId = (session['subscription'] as string | null) ?? null;

  if (!userId || !plan) return;

  const config = PLAN_CONFIG[plan];
  if (!config) return;

  // For recurring subscriptions, set expires_at to null (managed by Stripe events)
  // For one-time payments, no expiry
  await env.DB.prepare(
    `UPDATE subscriptions
     SET status = 'active',
         stripe_customer_id = ?,
         stripe_subscription_id = ?,
         activated_at = datetime('now'),
         shows_remaining = ?
     WHERE stripe_session_id = ?`
  ).bind(customerId, subscriptionId, config.shows, sessionId).run();
}

async function handleSubscriptionCanceled(subscription: Record<string, unknown>, env: Env): Promise<void> {
  const subscriptionId = subscription['id'] as string;
  await env.DB.prepare(
    `UPDATE subscriptions SET status = 'canceled' WHERE stripe_subscription_id = ?`
  ).bind(subscriptionId).run();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateCustomer(userId: string, email: string, env: Env): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1`
  ).bind(userId).first<{ stripe_customer_id: string }>();

  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const res = await stripePost('/customers', { email, metadata: `user_id=${userId}` }, env.STRIPE_SECRET_KEY);
  const customer = await res.json() as { id?: string };
  return customer.id ?? email;
}

function getPriceId(plan: Plan, env: Env): string {
  if (plan === 'single_show')  return env.STRIPE_PRICE_SINGLE_SHOW  ?? 'price_placeholder_single';
  if (plan === '3_show_pack')  return env.STRIPE_PRICE_3_SHOW_PACK  ?? 'price_placeholder_3pack';
  if (plan === 'team_plan')    return env.STRIPE_PRICE_TEAM_PLAN    ?? 'price_placeholder_team';
  return 'price_placeholder';
}

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  // header format: t=timestamp,v1=sig1,v1=sig2,...
  const parts = Object.fromEntries(
    header.split(',').map(p => p.split('=') as [string, string])
  );
  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) return false;

  // Reject timestamps older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time compare
  if (computed.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// One-shot Stripe test-mode setup. Creates the 3 products + prices, registers
// the webhook endpoint, sets every Cloudflare Workers secret, and redeploys.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_test_xxxxxxxxxx node scripts/setup-stripe.mjs
//
// Prereqs:
//   - You're already in test mode on https://dashboard.stripe.com
//   - CLOUDFLARE_API_TOKEN is in ~/.zshrc (already true on this machine)
//   - npx wrangler works (already true)
//
// Idempotent: re-running creates new products. Don't re-run unless the previous
// run failed mid-way; if it did, delete the half-created products from the
// Stripe Dashboard test mode first.

import { execSync } from 'node:child_process';

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('❌ STRIPE_SECRET_KEY not set.');
  console.error('   Run: STRIPE_SECRET_KEY=sk_test_xxxx node scripts/setup-stripe.mjs');
  process.exit(1);
}
if (!KEY.startsWith('sk_test_')) {
  console.error('❌ Refusing to run — key is not a test-mode key (must start with sk_test_).');
  console.error('   This script is for test mode only. Run a separate live-mode setup once you go live.');
  process.exit(1);
}

const WEBHOOK_URL = 'https://api.heydagama.com/api/stripe/webhook';
const WEBHOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.deleted'];

const PRODUCTS = [
  { name: 'DaGama — Single Show',  amount: 4900,  recurring: false, secretName: 'STRIPE_PRICE_SINGLE_SHOW' },
  { name: 'DaGama — 3-Show Pack',  amount: 12900, recurring: false, secretName: 'STRIPE_PRICE_3_SHOW_PACK' },
  { name: 'DaGama — Team Plan',    amount: 7900,  recurring: true,  secretName: 'STRIPE_PRICE_TEAM_PLAN'   },
];

async function stripeApi(path, body) {
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: typeof body === 'string' ? body : new URLSearchParams(body).toString(),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Stripe ${path} failed: ${r.status} ${text}`);
  }
  return JSON.parse(text);
}

function setCfSecret(name, value) {
  // Pipe value via stdin so it never appears in process listings or shell history.
  execSync(`npx wrangler secret put ${name} --env production`, {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

console.log('🟧 Stripe test-mode setup starting...\n');

// ── 1. Products + prices ────────────────────────────────────────────────────
const created = [];
for (const p of PRODUCTS) {
  process.stdout.write(`  · ${p.name} ($${(p.amount / 100).toFixed(2)}${p.recurring ? '/mo' : ''}) ... `);
  const product = await stripeApi('/products', { name: p.name });

  const priceParams = {
    product: product.id,
    unit_amount: String(p.amount),
    currency: 'usd',
  };
  if (p.recurring) priceParams['recurring[interval]'] = 'month';

  const price = await stripeApi('/prices', priceParams);
  console.log(`OK  product=${product.id}  price=${price.id}`);
  created.push({ ...p, productId: product.id, priceId: price.id });
}

console.log('\n🟧 Setting Cloudflare secrets for price IDs...\n');
for (const c of created) {
  console.log(`  · ${c.secretName}`);
  setCfSecret(c.secretName, c.priceId);
}

// ── 2. Webhook endpoint ─────────────────────────────────────────────────────
console.log('\n🟧 Creating webhook endpoint...\n');
// Stripe expects enabled_events[]=foo&enabled_events[]=bar
const eventsBody = WEBHOOK_EVENTS.map(e => `enabled_events[]=${encodeURIComponent(e)}`).join('&');
const webhookBody = `url=${encodeURIComponent(WEBHOOK_URL)}&${eventsBody}`;
const webhook = await stripeApi('/webhook_endpoints', webhookBody);
console.log(`  endpoint id: ${webhook.id}`);
console.log(`  signing secret: ${webhook.secret.slice(0, 12)}…  (storing in Cloudflare secret STRIPE_WEBHOOK_SECRET)`);
setCfSecret('STRIPE_WEBHOOK_SECRET', webhook.secret);

// ── 3. Redeploy worker so the new secrets take effect immediately ──────────
console.log('\n🟧 Redeploying worker so secrets are live...\n');
execSync('npx wrangler deploy --env production', { stdio: 'inherit' });

// ── 4. Summary ──────────────────────────────────────────────────────────────
console.log('\n✅ Done!\n');
console.log('Created in Stripe (test mode):');
for (const c of created) {
  console.log(`  · ${c.secretName.padEnd(28)} → ${c.priceId}`);
}
console.log(`  · STRIPE_WEBHOOK_SECRET       → ${webhook.secret.slice(0, 12)}…`);
console.log(`  · Webhook endpoint id         → ${webhook.id}`);
console.log('\nNext: open Telegram, run /upgrade in SourceBot, click the Checkout link,');
console.log('and pay with test card 4242 4242 4242 4242 (any future expiry, any CVC, any zip).');

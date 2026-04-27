/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { getServiceAccountToken, createDriveFolder, shareDriveItem } from './google';
import { createSourceBotSheet } from './sb_sheets';
import { sendWelcomeEmail } from './email';
import { hashPassword, signJwt } from './crypto';
import { createBoothBotSheetInFolder } from './sheets';

const SHOW_PASS_DURATION_SEC = 96 * 3600;
const GRACE_PERIOD_SEC       = 2  * 3600;
const ONBOARDING_TOKEN_TTL_SEC = 24 * 3600;

// Placeholder show name used when a user lands on the bot via the Day-1
// signup flow without picking a show on the website. The bot prompts them
// to pick a real show right after `cmdStartWithToken` and renames this row
// via `renameProvisionedShow()` once they choose.
export const PLACEHOLDER_SHOW_NAME = 'Setup';

export interface ProvisionResult {
  buyerId:            string | null;     // sb_buyers.id (sourcebot) or null (boothbot)
  showName:           string;
  sheetId:            string;
  sheetUrl:           string;
  folderId:           string;
  folderUrl:          string;
  alreadyProvisioned: boolean;            // true if we found a pre-existing sheet/folder and skipped creation
}

// ─────────────────────────────────────────────────────────────────────────────
// provisionBuyer — idempotent Drive folder + Sheet + per-role row creation.
//
// Called from:
//   - handleOnboard (POST /api/onboard) — website form path, with showName
//   - SourceBot cmdStartWithToken — Day-1 signup, lazy-provision with PLACEHOLDER_SHOW_NAME
//   - BoothBot start handler — same lazy path
//   - WhatsApp `join <token>` handler — same
//   - Web channel redemption — same
//
// Idempotency: looks up an existing row keyed on (userId, showName) for the
// requested role. If the show already has a sheet, returns the existing
// folder/sheet URLs and `alreadyProvisioned: true`. This makes it safe to
// call from any code path without worrying about duplicate Drive items.
// ─────────────────────────────────────────────────────────────────────────────
export async function provisionBuyer(opts: {
  userId:        string;
  email:         string;
  name:          string;
  role:          'sourcebot' | 'boothbot';
  showName?:     string;
  referrerCode?: string;
  env:           Env;
}): Promise<ProvisionResult> {
  const env       = opts.env;
  const showName  = (opts.showName ?? PLACEHOLDER_SHOW_NAME).trim() || PLACEHOLDER_SHOW_NAME;

  if (!env.SHARED_DRIVE_ID) {
    throw new Error('SHARED_DRIVE_ID not configured — service account cannot create files outside a Shared Drive.');
  }

  // 1. Idempotency check — skip Drive/Sheet creation if we've already provisioned this (user, show).
  if (opts.role === 'sourcebot') {
    const existing = await env.DB.prepare(
      `SELECT b.id AS buyer_id, s.sheet_id, s.sheet_url, s.drive_folder_id, s.drive_folder_url
         FROM sb_buyers b
         JOIN sb_buyer_shows s ON s.buyer_id = b.id AND s.show_name = ?
        WHERE b.user_id = ?`
    ).bind(showName, opts.userId).first<{
      buyer_id: string; sheet_id: string; sheet_url: string;
      drive_folder_id: string; drive_folder_url: string;
    }>();
    if (existing) {
      return {
        buyerId: existing.buyer_id, showName,
        sheetId: existing.sheet_id, sheetUrl: existing.sheet_url,
        folderId: existing.drive_folder_id, folderUrl: existing.drive_folder_url,
        alreadyProvisioned: true,
      };
    }
  } else {
    const existing = await env.DB.prepare(
      `SELECT sheet_id, sheet_url, drive_folder_id, drive_folder_url
         FROM google_sheets
        WHERE user_id = ? AND show_name = ? AND owner_type = 'service_account'`
    ).bind(opts.userId, showName).first<{
      sheet_id: string; sheet_url: string;
      drive_folder_id: string; drive_folder_url: string;
    }>();
    if (existing) {
      return {
        buyerId: null, showName,
        sheetId: existing.sheet_id, sheetUrl: existing.sheet_url,
        folderId: existing.drive_folder_id, folderUrl: existing.drive_folder_url,
        alreadyProvisioned: true,
      };
    }
  }

  // 2. Create Drive folder + Sheet via service account.
  const token   = await getServiceAccountToken(env);
  const folder  = await createDriveFolder(`DaGama — ${showName} (${opts.email})`, env.SHARED_DRIVE_ID, token);
  const folderId  = folder.id;
  const folderUrl = folder.url;

  let sheetId: string, sheetUrl: string;
  if (opts.role === 'sourcebot') {
    const sheet = await createSourceBotSheet(showName, folderId, token);
    sheetId  = sheet.sheetId;
    sheetUrl = sheet.sheetUrl;
  } else {
    const sheet = await createBoothBotSheetInFolder(showName, folderId, token);
    sheetId  = sheet.sheetId;
    sheetUrl = sheet.sheetUrl;
  }

  // notify=false suppresses Drive's auto-share email. We send our own branded
  // welcome email via Resend instead so users don't get the off-brand
  // "lead-manager-bot@…iam.gserviceaccount.com via Google Drive" notification.
  await shareDriveItem(folderId, opts.email, token, 'writer', false);

  // 3. Persist per-role rows.
  const now            = Math.floor(Date.now() / 1000);
  const passExpiresAt  = now + SHOW_PASS_DURATION_SEC;
  const gracePeriodEnd = passExpiresAt + GRACE_PERIOD_SEC;

  let buyerId: string | null = null;

  if (opts.role === 'sourcebot') {
    let referrerBuyerId: string | null = null;
    if (opts.referrerCode) {
      const ref = await env.DB.prepare(`SELECT id FROM sb_buyers WHERE referral_code = ?`).bind(opts.referrerCode).first<{ id: string }>();
      referrerBuyerId = ref?.id ?? null;
    }

    const newReferralCode = (crypto.randomUUID() as string).split('-')[0];
    const buyer = await env.DB.prepare(
      `INSERT INTO sb_buyers (user_id, email, name, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, name = excluded.name, updated_at = datetime('now')
       RETURNING id`
    ).bind(opts.userId, opts.email, opts.name, newReferralCode, opts.referrerCode ?? null).first<{ id: string }>();
    buyerId = buyer?.id ?? null;
    if (!buyerId) throw new Error('sb_buyers insert failed');

    if (referrerBuyerId) {
      await env.DB.prepare(
        `INSERT INTO referrals (referrer_buyer_id, referred_buyer_id, referred_email, status)
         SELECT ?, ?, ?, 'signed_up'
          WHERE NOT EXISTS (SELECT 1 FROM referrals WHERE referred_buyer_id = ?)`
      ).bind(referrerBuyerId, buyerId, opts.email, buyerId).run();
    }

    await env.DB.prepare(
      `INSERT INTO sb_buyer_shows
         (buyer_id, show_name, status, sheet_id, sheet_url, drive_folder_id, drive_folder_url, pass_expires_at, grace_period_end)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(buyer_id, show_name) DO UPDATE SET
         sheet_id = excluded.sheet_id,
         sheet_url = excluded.sheet_url,
         drive_folder_id = excluded.drive_folder_id,
         drive_folder_url = excluded.drive_folder_url,
         updated_at = datetime('now')`
    ).bind(buyerId, showName, sheetId, sheetUrl, folderId, folderUrl, passExpiresAt, gracePeriodEnd).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO google_sheets (user_id, show_name, sheet_id, sheet_url, owner_type, drive_folder_id, drive_folder_url)
       VALUES (?, ?, ?, ?, 'service_account', ?, ?)
       ON CONFLICT(user_id, show_name) DO UPDATE SET
         sheet_id = excluded.sheet_id,
         sheet_url = excluded.sheet_url,
         owner_type = 'service_account',
         drive_folder_id = excluded.drive_folder_id,
         drive_folder_url = excluded.drive_folder_url`
    ).bind(opts.userId, showName, sheetId, sheetUrl, folderId, folderUrl).run();

    await env.DB.prepare(
      `INSERT INTO buyer_shows
         (chat_id, user_id, show_name, status, first_scan_at, pass_expires_at, grace_period_end)
       VALUES (0, ?, ?, 'active', ?, ?, ?)`
    ).bind(opts.userId, showName, now, passExpiresAt, gracePeriodEnd).run();
  }

  return {
    buyerId, showName, sheetId, sheetUrl, folderId, folderUrl,
    alreadyProvisioned: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// renameProvisionedShow — called when a SourceBot user picks a real show in
// the bot after lazy-provisioning. Renames the Drive folder + Sheet doc + the
// sb_buyer_shows row from the placeholder to the chosen show name. Idempotent
// — if the row is already named correctly, returns immediately.
// ─────────────────────────────────────────────────────────────────────────────
export async function renameProvisionedShow(opts: {
  buyerId:    string;
  email:      string;
  oldShowName: string;
  newShowName: string;
  env:         Env;
}): Promise<void> {
  const newShowName = opts.newShowName.trim();
  if (!newShowName || newShowName === opts.oldShowName) return;

  // Check the row still uses the old name (otherwise nothing to do).
  const row = await opts.env.DB.prepare(
    `SELECT sheet_id, drive_folder_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
  ).bind(opts.buyerId, opts.oldShowName).first<{ sheet_id: string; drive_folder_id: string }>();
  if (!row) return;

  // Drive renames: folder + sheet doc. Best-effort — DB rename happens regardless.
  try {
    const token = await getServiceAccountToken(opts.env);
    const folderName = `DaGama — ${newShowName} (${opts.email})`;
    await driveRename(row.drive_folder_id, folderName, token);
    await driveRename(row.sheet_id,        newShowName, token);
  } catch (e) {
    console.warn('[onboarding] Drive rename failed (continuing with DB rename)', e);
  }

  await opts.env.DB.prepare(
    `UPDATE sb_buyer_shows SET show_name = ?, updated_at = datetime('now')
      WHERE buyer_id = ? AND show_name = ?`
  ).bind(newShowName, opts.buyerId, opts.oldShowName).run();
}

async function driveRename(fileId: string, newName: string, token: string): Promise<void> {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    },
  );
  if (!r.ok) throw new Error(`Drive rename ${fileId} failed: ${r.status} ${await r.text()}`);
}

interface OnboardRequest {
  email:          string;
  name:           string;
  role:           'sourcebot' | 'boothbot';
  show_name?:     string;
  password?:      string;   // For email/password signup; omit if Google OAuth already created the user
  user_id?:       string;   // If Google OAuth created the user, pass the id here
  referrer_code?: string;   // Optional: ?ref=<code> from the website signup URL
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboard
// Body: { email, name, role, show_name?, password? | user_id? }
//
// Creates the user (if needed), provisions a Sheet + Drive folder via the
// service account, shares them with the user's email, generates an onboarding
// token, and sends a welcome email. Returns the token + URLs.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOnboard(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonError(405, 'Method not allowed');

  let body: OnboardRequest;
  try { body = await request.json() as OnboardRequest; } catch { return jsonError(400, 'Bad JSON'); }

  if (!body.email || !body.name || !body.role) {
    return jsonError(400, 'email, name, role are required');
  }
  if (body.role !== 'sourcebot' && body.role !== 'boothbot') {
    return jsonError(400, "role must be 'sourcebot' or 'boothbot'");
  }
  const showName = (body.show_name ?? 'General').trim() || 'General';

  // 1. Resolve user — either via existing user_id (from Google OAuth) or by registering with email/password
  let userId: string;
  if (body.user_id) {
    const u = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(body.user_id).first<{ id: string }>();
    if (!u) return jsonError(404, 'user_id not found');
    userId = u.id;
  } else if (body.password) {
    // Reuse existing register flow via direct insert (handleRegister writes a JWT etc; we don't need that here).
    const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(body.email).first<{ id: string }>();
    if (existing) {
      userId = existing.id;
    } else {
      const passwordHash = await hashPassword(body.password);
      const inserted = await env.DB.prepare(
        `INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id`
      ).bind(body.email, body.name, passwordHash).first<{ id: string }>();
      if (!inserted?.id) return jsonError(500, 'User insert failed');
      userId = inserted.id;
    }
  } else {
    return jsonError(400, 'Either user_id (from Google OAuth) or password (for email/password signup) is required');
  }

  // 2-3. Provision Drive folder + Sheet + per-role rows.
  let provisioned: ProvisionResult;
  try {
    provisioned = await provisionBuyer({
      userId, email: body.email, name: body.name,
      role: body.role,
      showName,
      referrerCode: body.referrer_code,
      env,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(500, `Sheet/Drive provisioning failed: ${msg}`);
  }
  const sheetUrl  = provisioned.sheetUrl;
  const folderUrl = provisioned.folderUrl;

  // 4. Mint onboarding token
  const onboardingToken = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + ONBOARDING_TOKEN_TTL_SEC;
  await env.DB.prepare(
    `INSERT INTO onboarding_tokens (token, user_id, bot_role, show_name, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(onboardingToken, userId, body.role, showName, expiresAt).run();

  // 5. Send welcome email (logs if Gmail not yet configured)
  await sendWelcomeEmail({
    toEmail:        body.email,
    toName:         body.name,
    botRole:        body.role,
    showName,
    sheetUrl,
    driveFolderUrl: folderUrl,
    onboardingToken,
  }, env);

  // 6. Issue JWT for the email/password path so the frontend lands logged-in.
  // The Google-OAuth path already has its own JWT issued by handleGoogleAuthCallback.
  const JWT_TTL_SECONDS = 60 * 60 * 24 * 7;
  const jwt = await signJwt(
    { sub: userId, email: body.email, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
    env.WEBHOOK_SECRET,
  );

  return new Response(JSON.stringify({
    success: true,
    token: jwt,
    user: { id: userId, email: body.email, name: body.name },
    onboarding_token: onboardingToken,
    sheet_url: sheetUrl,
    drive_folder_url: folderUrl,
  }), { headers: { 'Content-Type': 'application/json' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/me/onboarding-status   (Bearer auth, same JWT as /api/me)
// Returns: { onboarded, role, sheets: [{ show_name, sheet_url, drive_folder_url }] }
// Used by the frontend after Google sign-in to decide whether to show the
// "complete your signup" form or skip straight to the dashboard.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOnboardingStatus(request: Request, env: Env): Promise<Response> {
  const { requireAuth } = await import('./auth');
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  // Look up sourcebot rows
  const sb = await env.DB.prepare(
    `SELECT bs.show_name, bs.sheet_url, bs.drive_folder_url
       FROM sb_buyer_shows bs
       JOIN sb_buyers b ON b.id = bs.buyer_id
      WHERE b.user_id = ?
      ORDER BY bs.created_at DESC`
  ).bind(auth.userId).all<{ show_name: string; sheet_url: string; drive_folder_url: string | null }>();

  // Look up boothbot rows (service-account-owned only — legacy users have user-owned sheets they manage themselves)
  const bb = await env.DB.prepare(
    `SELECT show_name, sheet_url, drive_folder_url
       FROM google_sheets
      WHERE user_id = ? AND owner_type = 'service_account'
      ORDER BY created_at DESC`
  ).bind(auth.userId).all<{ show_name: string; sheet_url: string; drive_folder_url: string | null }>();

  const sheets = [
    ...sb.results.map(r => ({ role: 'sourcebot' as const, show_name: r.show_name, sheet_url: r.sheet_url, drive_folder_url: r.drive_folder_url })),
    ...bb.results.map(r => ({ role: 'boothbot' as const,  show_name: r.show_name, sheet_url: r.sheet_url, drive_folder_url: r.drive_folder_url })),
  ];
  const onboarded = sheets.length > 0;
  const role = sheets[0]?.role ?? null;

  return new Response(JSON.stringify({ onboarded, role, sheets }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Token redemption helper — called from the bot when /start <token> arrives.
// Returns the user_id + bot_role + show_name if the token is valid and unused.
// ─────────────────────────────────────────────────────────────────────────────
export async function consumeOnboardingToken(token: string, env: Env): Promise<{ userId: string; botRole: 'sourcebot' | 'boothbot'; showName: string | null } | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT user_id, bot_role, show_name, expires_at, used_at
     FROM onboarding_tokens WHERE token = ?`
  ).bind(token).first<{ user_id: string; bot_role: 'sourcebot' | 'boothbot'; show_name: string | null; expires_at: number; used_at: number | null }>();

  if (!row) return null;
  if (row.expires_at < now) return null;
  if (row.used_at) return null;

  await env.DB.prepare(
    `UPDATE onboarding_tokens SET used_at = ? WHERE token = ?`
  ).bind(now, token).run();

  return { userId: row.user_id, botRole: row.bot_role, showName: row.show_name };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
}

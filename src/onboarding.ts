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

interface OnboardRequest {
  email:      string;
  name:       string;
  role:       'sourcebot' | 'boothbot';
  show_name?: string;
  password?:  string;       // For email/password signup; omit if Google OAuth already created the user
  user_id?:   string;       // If Google OAuth created the user, pass the id here
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

  // 2. Provision Sheet + Drive folder via service account
  let sheetUrl = '', sheetId = '', folderUrl = '', folderId = '';
  try {
    const token = await getServiceAccountToken(env);
    if (!env.SHARED_DRIVE_ID) {
      return jsonError(500, 'SHARED_DRIVE_ID not configured — service account cannot create files outside a Shared Drive.');
    }
    // Drive folder: "DaGama — {show} ({email})" — created inside the Shared Drive so the SA can own it.
    const folder = await createDriveFolder(`DaGama — ${showName} (${body.email})`, env.SHARED_DRIVE_ID, token);
    folderId  = folder.id;
    folderUrl = folder.url;

    if (body.role === 'sourcebot') {
      const sheet = await createSourceBotSheet(showName, folderId, token);
      sheetId  = sheet.sheetId;
      sheetUrl = sheet.sheetUrl;
    } else {
      const sheet = await createBoothBotSheetInFolder(showName, folderId, token);
      sheetId  = sheet.sheetId;
      sheetUrl = sheet.sheetUrl;
    }

    // Share folder (sheet inherits via Drive permission inheritance)
    await shareDriveItem(folderId, body.email, token, 'writer', true);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(500, `Sheet/Drive provisioning failed: ${msg}`);
  }

  // 3. Persist per-role state
  const now = Math.floor(Date.now() / 1000);
  const passExpiresAt  = now + SHOW_PASS_DURATION_SEC;
  const gracePeriodEnd = passExpiresAt + GRACE_PERIOD_SEC;

  if (body.role === 'sourcebot') {
    const buyer = await env.DB.prepare(
      `INSERT INTO sb_buyers (user_id, email, name) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, name = excluded.name, updated_at = datetime('now')
       RETURNING id`
    ).bind(userId, body.email, body.name).first<{ id: string }>();
    const buyerId = buyer?.id;
    if (!buyerId) return jsonError(500, 'sb_buyers insert failed');

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
    // BoothBot path — pre-populate google_sheets so existing saveLead flow finds it.
    // owner_type='service_account' tells writers to use the service-account token, not user's Gmail.
    await env.DB.prepare(
      `INSERT INTO google_sheets (user_id, show_name, sheet_id, sheet_url, owner_type, drive_folder_id, drive_folder_url)
       VALUES (?, ?, ?, ?, 'service_account', ?, ?)
       ON CONFLICT(user_id, show_name) DO UPDATE SET
         sheet_id = excluded.sheet_id,
         sheet_url = excluded.sheet_url,
         owner_type = 'service_account',
         drive_folder_id = excluded.drive_folder_id,
         drive_folder_url = excluded.drive_folder_url`
    ).bind(userId, showName, sheetId, sheetUrl, folderId, folderUrl).run();

    // Pre-create the show pass so the BoothBot show-pass logic recognizes the user.
    // chat_id is set to 0 here as a placeholder — the bot links the real chat_id on /start.
    await env.DB.prepare(
      `INSERT INTO buyer_shows
         (chat_id, user_id, show_name, status, first_scan_at, pass_expires_at, grace_period_end)
       VALUES (0, ?, ?, 'active', ?, ?, ?)`
    ).bind(userId, showName, now, passExpiresAt, gracePeriodEnd).run();
  }

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

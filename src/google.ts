/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES    = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';
const DRIVE_API        = 'https://www.googleapis.com/drive/v3/files';

// ── Service-account JWT auth ─────────────────────────────────────────────────

export async function getServiceAccountToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: GOOGLE_SCOPES, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 };

  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const signingInput = `${header}.${payload}`;

  const pemBody = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
    .replace(/\\n/g, '\n')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const derBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', derBuffer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );

  const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingInput));
  const sig = b64url(new Uint8Array(sigBuffer));
  const jwt = `${signingInput}.${sig}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json() as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(`Service account token failed: ${data.error ?? JSON.stringify(data)}`);
  return data.access_token;
}

// ── Drive: folder create + share ─────────────────────────────────────────────

export async function createDriveFolder(name: string, parentId: string | null, token: string): Promise<{ id: string; url: string }> {
  const body: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) body.parents = [parentId];

  const res = await fetch(`${DRIVE_API}?fields=id&supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Drive folder create failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { id?: string };
  if (!data.id) throw new Error('Drive folder create returned no id');
  return { id: data.id, url: `https://drive.google.com/drive/folders/${data.id}` };
}

// Share a Drive file/folder with an email address as Editor (works for any
// email — recipient doesn't need a Google account; they get a notification
// and can access via the link).
export async function shareDriveItem(
  fileId: string,
  email: string,
  token: string,
  role: 'reader' | 'writer' = 'writer',
  notify = true,
): Promise<void> {
  const res = await fetch(`${DRIVE_API}/${fileId}/permissions?sendNotificationEmail=${notify}&supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, type: 'user', emailAddress: email }),
  });
  if (!res.ok) throw new Error(`Drive share failed: ${res.status} ${await res.text()}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function b64url(input: string | Uint8Array): string {
  const str = typeof input === 'string' ? input : String.fromCharCode(...input);
  return btoa(str).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

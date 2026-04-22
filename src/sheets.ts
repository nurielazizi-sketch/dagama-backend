/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API  = 'https://www.googleapis.com/drive/v3/files';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

// 30-column header per DaGama master spec
const SHEET_HEADERS = [
  'Timestamp', 'Company', 'Contact Name', 'Title', 'Email',
  'Phone', 'Phone Country', 'Website', 'LinkedIn', 'Industry',
  'Company Size', 'Certifications', 'Geographic Presence',
  'Card Front Photo', 'Card Back Photo', 'Products', 'Price Range',
  'Avg Lead Time', 'Interest Level', 'Notes', 'Voice Note',
  'Email Sent', 'Email Sent At', 'Email Subject', 'Email Status',
  'Reply Received', 'Reply Content', 'Person Photo', 'Person Description',
  'Last Updated',
];

export interface LeadRow {
  timestamp: string;
  company: string;
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  notes?: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getOrCreateSheet(
  userId: string,
  userEmail: string,
  showName: string,
  env: Env
): Promise<{ sheetId: string; sheetUrl: string }> {
  // Check D1 first
  const existing = await env.DB.prepare(
    `SELECT sheet_id, sheet_url FROM google_sheets WHERE user_id = ? AND show_name = ?`
  ).bind(userId, showName).first<{ sheet_id: string; sheet_url: string }>();

  if (existing) return { sheetId: existing.sheet_id, sheetUrl: existing.sheet_url };

  const token = await getServiceAccountToken(env);
  const { sheetId, sheetUrl } = await createSheet(showName, token);
  await shareSheet(sheetId, userEmail, token);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO google_sheets (user_id, show_name, sheet_id, sheet_url)
     VALUES (?, ?, ?, ?)`
  ).bind(userId, showName, sheetId, sheetUrl).run();

  return { sheetId, sheetUrl };
}

export async function appendLeadRow(
  sheetId: string,
  lead: LeadRow,
  env: Env
): Promise<void> {
  const token = await getServiceAccountToken(env);

  const row = [
    lead.timestamp,
    lead.company || '',
    lead.name || '',
    lead.title || '',
    lead.email || '',
    lead.phone || '',
    '', // Phone Country
    '', // Website
    '', // LinkedIn
    '', // Industry
    '', // Company Size
    '', // Certifications
    '', // Geographic Presence
    '', // Card Front Photo
    '', // Card Back Photo
    '', // Products
    '', // Price Range
    '', // Avg Lead Time
    '', // Interest Level
    lead.notes || '',
    '', // Voice Note
    '', // Email Sent
    '', // Email Sent At
    '', // Email Subject
    '', // Email Status
    '', // Reply Received
    '', // Reply Content
    '', // Person Photo
    '', // Person Description
    new Date().toISOString(),
  ];

  await fetch(
    `${SHEETS_API}/${sheetId}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    }
  );
}

export async function getUserSheets(
  userId: string,
  env: Env
): Promise<Array<{ show_name: string; sheet_url: string; created_at: string }>> {
  const rows = await env.DB.prepare(
    `SELECT show_name, sheet_url, created_at FROM google_sheets
     WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(userId).all<{ show_name: string; sheet_url: string; created_at: string }>();

  return rows.results;
}

// ── Sheet creation ────────────────────────────────────────────────────────────

async function createSheet(showName: string, token: string): Promise<{ sheetId: string; sheetUrl: string }> {
  const title = `DaGama — ${showName}`;

  const res = await fetch(SHEETS_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: { title },
      sheets: [{
        properties: { title: showName, sheetId: 0 },
        data: [{
          startRow: 0,
          startColumn: 0,
          rowData: [{
            values: SHEET_HEADERS.map(h => ({
              userEnteredValue: { stringValue: h },
              userEnteredFormat: {
                backgroundColor: { red: 0.106, green: 0.188, blue: 0.314 }, // Ink Navy #1B3050
                textFormat: {
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                  bold: true,
                  fontSize: 10,
                },
              },
            })),
          }],
        }],
      }],
    }),
  });

  const data = await res.json() as { spreadsheetId?: string; spreadsheetUrl?: string };
  if (!data.spreadsheetId) throw new Error('Failed to create Google Sheet');

  // Freeze header row and auto-resize columns
  await fetch(`${SHEETS_API}/${data.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 30 } } },
      ],
    }),
  });

  return {
    sheetId: data.spreadsheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}`,
  };
}

async function shareSheet(sheetId: string, email: string, token: string): Promise<void> {
  await fetch(`${DRIVE_API}/${sheetId}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      role: 'writer',
      type: 'user',
      emailAddress: email,
    }),
  });
}

// ── Service account JWT (RS256) ───────────────────────────────────────────────

async function getServiceAccountToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));

  const signingInput = `${header}.${payload}`;
  const key = await importRsaPrivateKey(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const sigBytes = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${b64urlRaw(new Uint8Array(sigBytes))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new Error('Failed to obtain Google service account token');
  return data.access_token;
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  // Wrangler stores multiline secrets with literal \n — normalize both cases
  const normalized = pem.replace(/\\n/g, '\n');
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '')
    .trim();

  const keyData = Uint8Array.from(atob(body), c => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// ── Base64url helpers ─────────────────────────────────────────────────────────

function b64url(s: string): string {
  return b64urlRaw(new TextEncoder().encode(s));
}

function b64urlRaw(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API  = 'https://www.googleapis.com/drive/v3/files';

const SHEET_HEADERS = [
  'Timestamp', 'Show / Event', 'Company', 'Contact Name', 'Title',
  'Email', 'Phone', 'Country', 'Website', 'LinkedIn',
  'Address', 'Notes',
  'Email Sent', 'Email Sent At', 'Email Subject', 'Email Status',
  'Last Updated', 'Card Photo', 'Card Image',
];

export interface LeadRow {
  timestamp: string;
  showName: string;
  name: string;
  title?: string;
  company?: string;
  email?: string;
  phone?: string;
  country?: string;
  website?: string;
  linkedin?: string;
  address?: string;
  notes?: string;
  cardPhotoUrl?: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getOrCreateSheet(
  userId: string,
  showName: string,
  token: string,
  env: Env
): Promise<{ sheetId: string; sheetUrl: string }> {
  // Check D1 first
  const existing = await env.DB.prepare(
    `SELECT sheet_id, sheet_url FROM google_sheets WHERE user_id = ? AND show_name = ?`
  ).bind(userId, showName).first<{ sheet_id: string; sheet_url: string }>();

  if (existing) return { sheetId: existing.sheet_id, sheetUrl: existing.sheet_url };

  const { sheetId, sheetUrl } = await createSheet(showName, token);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO google_sheets (user_id, show_name, sheet_id, sheet_url)
     VALUES (?, ?, ?, ?)`
  ).bind(userId, showName, sheetId, sheetUrl).run();

  return { sheetId, sheetUrl };
}

export async function appendLeadRow(
  sheetId: string,
  lead: LeadRow,
  token: string,
  env: Env
): Promise<{ rowIndex: number }> {

  const row = [
    lead.timestamp,
    lead.showName || '',
    lead.company || '',
    lead.name || '',
    lead.title || '',
    lead.email || '',
    lead.phone || '',
    lead.country || '',
    lead.website || '',
    lead.linkedin || '',
    lead.address || '',
    lead.notes || '',
    '', // Email Sent
    '', // Email Sent At
    '', // Email Subject
    '', // Email Status
    new Date().toISOString(),
    lead.cardPhotoUrl || '', // Card Photo (R)
    '',                      // Card Image formula (S) — written separately
  ];

  const appendRes = await fetch(
    `${SHEETS_API}/${sheetId}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    }
  );

  // The append response tells us exactly where the row landed
  // (gridProperties.rowCount is the whole sheet's row dimension, not the data row — don't use it)
  const appendData = await appendRes.json() as { updates?: { updatedRange?: string } };
  const updatedRange = appendData.updates?.updatedRange ?? '';
  const rowMatch = updatedRange.match(/![A-Z]+(\d+):/);
  const rowIndex = rowMatch ? parseInt(rowMatch[1], 10) : 2;

  // Write IMAGE formula with USER_ENTERED so Sheets evaluates it.
  // R column holds a direct image URL (lh3.googleusercontent.com/d/{fileId}),
  // which =IMAGE() can consume directly.
  if (lead.cardPhotoUrl) {
    const formula = `=IMAGE(R${rowIndex})`;
    await fetch(
      `${SHEETS_API}/${sheetId}/values/S${rowIndex}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: `S${rowIndex}`, values: [[formula]] }),
      }
    );
  }

  return { rowIndex };
}

export interface EmailStatus {
  emailSent: 'Yes' | 'No';
  emailSentAt: string;
  emailSubject: string;
  emailStatus: string;
}

export async function updateLeadEmailStatus(
  sheetId: string,
  rowIndex: number,
  status: EmailStatus,
  token: string,
  env: Env
): Promise<void> {
  // Columns M:P = Email Sent (13), Email Sent At (14), Email Subject (15), Email Status (16)
  const range = `M${rowIndex}:P${rowIndex}`;
  await fetch(
    `${SHEETS_API}/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range,
        values: [[status.emailSent, status.emailSentAt, status.emailSubject, status.emailStatus]],
      }),
    }
  );
}

export async function updateLeadLinkedIn(
  sheetId: string,
  rowIndex: number,
  linkedinUrl: string,
  token: string,
): Promise<void> {
  // Column J = LinkedIn (0-indexed 9 in SHEET_HEADERS)
  await fetch(
    `${SHEETS_API}/${sheetId}/values/J${rowIndex}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: `J${rowIndex}`, values: [[linkedinUrl]] }),
    },
  );
}

export async function patchLeadNotes(
  sheetId: string,
  rowIndex: number,
  notes: string,
  token: string,
): Promise<void> {
  // Column L = Notes (index 11), Column Q = Last Updated (index 16)
  await fetch(
    `${SHEETS_API}/${sheetId}/values/L${rowIndex}:Q${rowIndex}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        range: `L${rowIndex}:Q${rowIndex}`,
        values: [[notes, '', '', '', '', new Date().toISOString()]],
      }),
    },
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

// Service-account-friendly variant: place the sheet inside an existing Drive folder.
// Used by /api/onboard so the sheet lives in a buyer-specific folder we can share.
export async function createBoothBotSheetInFolder(
  showName: string,
  parentFolderId: string,
  token: string,
): Promise<{ sheetId: string; sheetUrl: string }> {
  return createSheet(showName, token, parentFolderId);
}

async function createSheet(showName: string, token: string, parentFolderId?: string): Promise<{ sheetId: string; sheetUrl: string }> {
  const title = `DaGama — ${showName} Lead list`;

  // Create spreadsheet via Drive API (more permissive than Sheets POST)
  const driveBody: Record<string, unknown> = {
    name: title,
    mimeType: 'application/vnd.google-apps.spreadsheet',
  };
  if (parentFolderId) driveBody.parents = [parentFolderId];

  const driveRes = await fetch(`${DRIVE_API}?fields=id&supportsAllDrives=true`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(driveBody),
  });
  const driveData = await driveRes.json() as { id?: string; error?: { code?: number; message?: string } };
  if (!driveData.id) throw new Error(`Failed to create sheet via Drive: HTTP ${driveRes.status} | ${JSON.stringify(driveData.error ?? driveData)}`);

  const spreadsheetId = driveData.id;

  // Add headers via Sheets API
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}/values/A1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [SHEET_HEADERS] }),
  });

  const data = await res.json() as { spreadsheetId?: string; error?: { code?: number; message?: string; status?: string } };
  if (!res.ok) throw new Error(`Failed to write headers: HTTP ${res.status} | ${JSON.stringify(data.error ?? data)}`);

  // Freeze header row and auto-resize columns
  await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 19 } } },
      ],
    }),
  });

  return {
    sheetId: spreadsheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

// ── Drive photo upload ─────────────────────────────────────────────────────────

export async function uploadCardPhotoToDrive(
  fileName: string,
  imageBuffer: ArrayBuffer,
  mimeType: string,
  token: string,
  showName?: string,
  sharedDriveId?: string,
): Promise<string> {
  const parentFolderId = showName ? await getOrCreateShowFolder(showName, token, sharedDriveId) : undefined;

  const boundary = '--------dagama_boundary';
  const metadata = JSON.stringify({
    name: fileName,
    mimeType,
    ...(parentFolderId ? { parents: [parentFolderId] } : {}),
  });

  const encoder = new TextEncoder();
  const preamble = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const epilogue = encoder.encode(`\r\n--${boundary}--`);
  const imageBytes = new Uint8Array(imageBuffer);
  const body = new Uint8Array(preamble.length + imageBytes.length + epilogue.length);
  body.set(preamble, 0);
  body.set(imageBytes, preamble.length);
  body.set(epilogue, preamble.length + imageBytes.length);

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: body.buffer,
    },
  );
  const uploadData = await uploadRes.json() as { id?: string };
  if (!uploadData.id) throw new Error('Drive photo upload failed');

  const fileId = uploadData.id;

  await fetch(`${DRIVE_API}/${fileId}/permissions?supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  return `https://lh3.googleusercontent.com/d/${fileId}`;
}

async function getOrCreateShowFolder(showName: string, token: string, sharedDriveId?: string): Promise<string> {
  const now = new Date();
  const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const folderName = `${showName} — ${monthYear}`;

  const q = encodeURIComponent(
    `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const searchUrl = new URL(DRIVE_API);
  searchUrl.searchParams.set('q', decodeURIComponent(q));
  searchUrl.searchParams.set('fields', 'files(id)');
  searchUrl.searchParams.set('pageSize', '1');
  searchUrl.searchParams.set('supportsAllDrives', 'true');
  if (sharedDriveId) {
    searchUrl.searchParams.set('includeItemsFromAllDrives', 'true');
    searchUrl.searchParams.set('corpora', 'drive');
    searchUrl.searchParams.set('driveId', sharedDriveId);
  }
  const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
  const searchData = await searchRes.json() as { files?: Array<{ id: string }> };
  if (searchData.files?.length) return searchData.files[0].id;

  const createBody: Record<string, unknown> = { name: folderName, mimeType: 'application/vnd.google-apps.folder' };
  if (sharedDriveId) createBody.parents = [sharedDriveId];
  const createRes = await fetch(`${DRIVE_API}?fields=id&supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(createBody),
  });
  const createData = await createRes.json() as { id?: string };
  if (!createData.id) throw new Error(`Drive folder create failed: ${folderName}`);
  return createData.id;
}


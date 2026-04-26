/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { getServiceAccountToken, createDriveFolder, shareDriveItem } from './google';
import { toSheetsImageUrl } from './sb_sheets';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API  = 'https://www.googleapis.com/drive/v3/files';

// ─────────────────────────────────────────────────────────────────────────────
// DemoBot per-prospect sheet (26 columns per master spec § "Google Sheets &
// Drive Integration"). One sheet is created per scanned card; the freelancer's
// service account owns it; the prospect is shared as Editor and the link is
// embedded in Email 1.
//
//  A=Timestamp · B=Name · C=Title · D=Company · E=Email · F=Phone
//  G=Website · H=LinkedIn · I=Address · J=Industry
//  K=Person Photo · L=Person Description
//  M=Card Front Photo · N=Card Back Photo
//  O=Company Size · P=Certifications · Q=Products/Services · R=Geographic Presence
//  S=Voice Note · T=Notes
//  U=Email Sent · V=Email Subject · W=Email Sent Date
//  X=Follow-up Received · Y=Follow-up Date · Z=Follow-up Content
// ─────────────────────────────────────────────────────────────────────────────

export const DEMOBOT_SHEET_HEADERS = [
  'Timestamp', 'Name', 'Title', 'Company', 'Email',
  'Phone', 'Website', 'LinkedIn', 'Address', 'Industry',
  'Person Photo', 'Person Description', 'Card Front Photo', 'Card Back Photo', 'Company Size',
  'Certifications', 'Products/Services', 'Geographic Presence', 'Voice Note', 'Notes',
  'Email Sent', 'Email Subject', 'Email Sent Date', 'Follow-up Received', 'Follow-up Date',
  'Follow-up Content',
];

export interface DemoBotSheetRow {
  timestamp:           string;
  name:                string;
  title?:              string;
  company:             string;
  email?:              string;
  phone?:              string;
  website?:            string;
  linkedin?:           string;
  address?:            string;
  industry?:           string;
  personPhotoUrl?:     string;
  personDescription?:  string;
  cardFrontUrl?:       string;
  cardBackUrl?:        string;
  companySize?:        string;
  certifications?:     string;
  productsServices?:   string;
  geographicPresence?: string;
  voiceNote?:          string;
  notes?:              string;
}

export interface ProspectAssets {
  driveFolderId:  string;
  driveFolderUrl: string;
  sheetId:        string;
  sheetUrl:       string;
}

// Provision a fresh prospect bundle: Drive folder (with subfolders) + Sheet
// (26 cols, headers row, frozen, photo column auto-IMAGE on later writes),
// shared to the prospect as Editor with notification.
export async function provisionProspectBundle(
  args: {
    showName:        string;        // "HKTDC Electronics 2026"
    companyName:     string;        // root folder + sheet title use this
    prospectEmail?:  string;        // optional — if absent, no share is performed
    prospectName?:   string;        // for the Drive notification title
  },
  env: Env,
): Promise<ProspectAssets> {
  const token = await getServiceAccountToken(env);

  // 1. Root folder = company. Lives under SHARED_DRIVE_ID.
  const safeCompany = args.companyName.trim() || 'Unknown Company';
  const root = await createDriveFolder(safeCompany, env.SHARED_DRIVE_ID, token);

  // 2. Spec subfolders: Cards, Person, Products, Correspondence, Notes.
  //    We don't await sequentially — Drive accepts concurrent folder creates.
  await Promise.all(
    ['Cards', 'Person', 'Products', 'Correspondence', 'Notes'].map(name =>
      createDriveFolder(name, root.id, token).catch(e => {
        console.error('[demobot] subfolder create failed:', name, e);
      }),
    ),
  );

  // 3. Sheet inside the root folder.
  const sheetTitle = `${args.showName} Contacts - ${safeCompany}`;
  const sheetCreate = await fetch(`${DRIVE_API}?fields=id&supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: sheetTitle,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [root.id],
    }),
  });
  const sheetData = await sheetCreate.json() as { id?: string };
  if (!sheetData.id) throw new Error(`DemoBot sheet create failed: ${sheetCreate.status} ${JSON.stringify(sheetData)}`);
  const sheetId = sheetData.id;

  // 4. Rename Sheet1 → "Contact" + write headers.
  await fetch(`${SHEETS_API}/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, title: 'Contact' }, fields: 'title' } },
      ],
    }),
  });

  const headerRes = await fetch(
    `${SHEETS_API}/${sheetId}/values/Contact!A1?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [DEMOBOT_SHEET_HEADERS] }),
    },
  );
  if (!headerRes.ok) throw new Error(`DemoBot header write failed: ${headerRes.status} ${await headerRes.text()}`);

  // 5. Freeze + size header row, widen photo cols, wrap description.
  await fetch(`${SHEETS_API}/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: DEMOBOT_SHEET_HEADERS.length } } },
        // Photo cols K (10) and M/N (12, 13) get a 160px width so IMAGE() previews render.
        { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 10, endIndex: 11 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 12, endIndex: 14 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
        // Person description (L) + Voice Note (S) wrap so long text doesn't overflow.
        { repeatCell: { range: { sheetId: 0, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 11, endColumnIndex: 12 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment' } },
        { repeatCell: { range: { sheetId: 0, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 18, endColumnIndex: 19 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment' } },
      ],
    }),
  });

  // 6. Share to prospect (with Drive notification). If they have no email, skip.
  if (args.prospectEmail) {
    try {
      // Sharing the folder propagates to the sheet (sheet is inside the folder).
      await shareDriveItem(root.id, args.prospectEmail, token, 'writer', true);
    } catch (e) {
      // Don't fail the whole pipeline if share notify bounces — sheet/folder still exist.
      console.error('[demobot] share failed:', args.prospectEmail, e);
    }
  }

  return {
    driveFolderId:  root.id,
    driveFolderUrl: root.url,
    sheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`,
  };
}

// Append the single contact row (most rows on this sheet stay at row 2 — the
// sheet is per-prospect). Photo URLs become IMAGE() formulas so previews render.
export async function writeProspectRow(
  sheetId: string,
  row: DemoBotSheetRow,
  env: Env,
): Promise<void> {
  const token = await getServiceAccountToken(env);
  const values = [
    row.timestamp,
    row.name,
    row.title              ?? '',
    row.company,
    row.email              ?? '',
    row.phone              ?? '',
    row.website            ?? '',
    row.linkedin           ?? '',
    row.address            ?? '',
    row.industry           ?? '',
    '',                                            // K: Person Photo (formula written below)
    row.personDescription  ?? '',
    '',                                            // M: Card Front Photo (formula below)
    '',                                            // N: Card Back Photo (formula below)
    row.companySize        ?? '',
    row.certifications     ?? '',
    row.productsServices   ?? '',
    row.geographicPresence ?? '',
    row.voiceNote          ?? '',
    row.notes              ?? '',
    '',                                            // U: Email Sent (set by Email 1 dispatcher)
    '',                                            // V: Email Subject
    '',                                            // W: Email Sent Date
    '',                                            // X: Follow-up Received
    '',                                            // Y: Follow-up Date
    '',                                            // Z: Follow-up Content
  ];

  // RAW append at A2 so the headers stay intact.
  const appendRes = await fetch(
    `${SHEETS_API}/${sheetId}/values/Contact!A2:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    },
  );
  if (!appendRes.ok) throw new Error(`DemoBot row append failed: ${appendRes.status} ${await appendRes.text()}`);

  // Image formulas in K/M/N — only if URLs were provided.
  const updates: Array<{ col: string; url: string }> = [];
  if (row.personPhotoUrl) updates.push({ col: 'K', url: row.personPhotoUrl });
  if (row.cardFrontUrl)   updates.push({ col: 'M', url: row.cardFrontUrl });
  if (row.cardBackUrl)    updates.push({ col: 'N', url: row.cardBackUrl });

  for (const u of updates) {
    await fetch(
      `${SHEETS_API}/${sheetId}/values/Contact!${u.col}2?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[`=IMAGE("${toSheetsImageUrl(u.url)}")`]] }),
      },
    );
  }
}

// Patch website-derived columns (O Company Size, P Certifications, Q Products/Services,
// R Geographic Presence) on row 2 after the background enrichment finishes.
// Empty values are skipped (we don't blank out a freelancer's manual edit).
export async function patchProspectWebsiteFields(
  sheetId: string,
  fields: { companySize?: string; certifications?: string; productsServices?: string; geographicPresence?: string },
  env: Env,
): Promise<void> {
  const token = await getServiceAccountToken(env);
  const cur = await fetch(`${SHEETS_API}/${sheetId}/values/Contact!O2:R2`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json()) as { values?: string[][] };
  const existing = cur.values?.[0] ?? [];
  const merged = [
    fields.companySize        ?? existing[0] ?? '',
    fields.certifications     ?? existing[1] ?? '',
    fields.productsServices   ?? existing[2] ?? '',
    fields.geographicPresence ?? existing[3] ?? '',
  ];
  await fetch(
    `${SHEETS_API}/${sheetId}/values/Contact!O2:R2?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [merged] }),
    },
  );
}

// Mark Email 1 as sent on the sheet (cols U, V, W on row 2).
export async function markProspectEmailSent(
  sheetId: string,
  args: { subject: string; sentAt: string },
  env: Env,
): Promise<void> {
  const token = await getServiceAccountToken(env);
  await fetch(
    `${SHEETS_API}/${sheetId}/values/Contact!U2:W2?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Yes', args.subject, args.sentAt]] }),
    },
  );
}

// Update the Voice Note column (S) — appended to whatever's there (so a second
// voice note adds, doesn't overwrite).
export async function appendProspectVoiceNote(
  sheetId: string,
  newTranscript: string,
  env: Env,
): Promise<void> {
  const token = await getServiceAccountToken(env);

  const cur = await fetch(`${SHEETS_API}/${sheetId}/values/Contact!S2`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json()) as { values?: string[][] };
  const existing = cur.values?.[0]?.[0] ?? '';
  const merged = existing ? `${existing}\n---\n${newTranscript}` : newTranscript;

  await fetch(
    `${SHEETS_API}/${sheetId}/values/Contact!S2?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[merged]] }),
    },
  );
}

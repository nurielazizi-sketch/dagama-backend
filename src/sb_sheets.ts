/// <reference types="@cloudflare/workers-types" />

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API  = 'https://www.googleapis.com/drive/v3/files';

// SourceBot 30-column sheet schema (per master doc).
// Order matters — column letters in helpers below depend on this layout.
//   A=Timestamp · B=Company · C=Contact Name · D=Title · E=Email · F=Phone
//   G=Phone Country · H=Website · I=LinkedIn · J=Industry · K=Company Size
//   L=Certifications · M=Geographic Presence · N=Card Front Photo · O=Card Back Photo
//   P=Products · Q=Price Range · R=Avg Lead Time · S=Interest Level · T=Notes
//   U=Voice Note · V=Email Sent · W=Email Sent At · X=Email Subject · Y=Email Status
//   Z=Reply Received · AA=Reply Content · AB=Person Photo · AC=Person Description
//   AD=Last Updated
export const SB_SHEET_HEADERS = [
  'Timestamp', 'Company', 'Contact Name', 'Title', 'Email',
  'Phone', 'Phone Country', 'Website', 'LinkedIn', 'Industry',
  'Company Size', 'Certifications', 'Geographic Presence', 'Card Front Photo', 'Card Back Photo',
  'Products', 'Price Range', 'Avg Lead Time', 'Interest Level', 'Notes',
  'Voice Note', 'Email Sent', 'Email Sent At', 'Email Subject', 'Email Status',
  'Reply Received', 'Reply Content', 'Person Photo', 'Person Description', 'Last Updated',
];

export interface SbSupplierRow {
  timestamp:           string;
  company:             string;
  contactName:         string;
  title?:              string;
  email?:              string;
  phone?:              string;
  phoneCountry?:       string;
  website?:            string;
  linkedin?:           string;
  industry?:           string;
  companySize?:        string;
  certifications?:     string;
  geographicPresence?: string;
  cardFrontUrl?:       string;
  cardBackUrl?:        string;
  notes?:              string;
}

// Create a SourceBot Sheet inside a Drive folder. Returns the spreadsheet id+url.
export async function createSourceBotSheet(
  showName: string,
  parentFolderId: string,
  token: string,
): Promise<{ sheetId: string; sheetUrl: string }> {
  const title = `DaGama — ${showName} Supplier list`;

  // Create as a Drive file inside the buyer's show folder
  const driveRes = await fetch(`${DRIVE_API}?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: title,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [parentFolderId],
    }),
  });
  const driveData = await driveRes.json() as { id?: string };
  if (!driveData.id) throw new Error(`Sheet create failed: ${driveRes.status} ${JSON.stringify(driveData)}`);
  const spreadsheetId = driveData.id;

  // Write headers
  const headerRes = await fetch(`${SHEETS_API}/${spreadsheetId}/values/A1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [SB_SHEET_HEADERS] }),
  });
  if (!headerRes.ok) throw new Error(`Header write failed: ${headerRes.status} ${await headerRes.text()}`);

  // Freeze header row + auto-resize columns A:AD (30 columns)
  await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: SB_SHEET_HEADERS.length } } },
      ],
    }),
  });

  return {
    sheetId: spreadsheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

// Append a supplier+contact row. Returns the row index for later updates.
export async function appendSupplierRow(
  sheetId: string,
  row: SbSupplierRow,
  token: string,
): Promise<{ rowIndex: number }> {
  const values = [
    row.timestamp,
    row.company,
    row.contactName,
    row.title             ?? '',
    row.email             ?? '',
    row.phone             ?? '',
    row.phoneCountry      ?? '',
    row.website           ?? '',
    row.linkedin          ?? '',
    row.industry          ?? '',
    row.companySize       ?? '',
    row.certifications    ?? '',
    row.geographicPresence?? '',
    row.cardFrontUrl      ?? '',  // N: Card Front Photo URL
    row.cardBackUrl       ?? '',  // O: Card Back Photo URL
    '',                            // P: Products
    '',                            // Q: Price Range
    '',                            // R: Avg Lead Time
    '',                            // S: Interest Level
    row.notes             ?? '',
    '',                            // U: Voice Note
    '',                            // V: Email Sent
    '',                            // W: Email Sent At
    '',                            // X: Email Subject
    '',                            // Y: Email Status
    '',                            // Z: Reply Received
    '',                            // AA: Reply Content
    '',                            // AB: Person Photo
    '',                            // AC: Person Description
    new Date().toISOString(),     // AD: Last Updated
  ];

  const appendRes = await fetch(
    `${SHEETS_API}/${sheetId}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    },
  );
  const appendData = await appendRes.json() as { updates?: { updatedRange?: string } };
  const rowMatch = (appendData.updates?.updatedRange ?? '').match(/![A-Z]+(\d+):/);
  const rowIndex = rowMatch ? parseInt(rowMatch[1], 10) : 2;

  // Render the card front photo as IMAGE() in column N for inline preview.
  if (row.cardFrontUrl) {
    await fetch(`${SHEETS_API}/${sheetId}/values/N${rowIndex}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: `N${rowIndex}`, values: [[`=IMAGE("${row.cardFrontUrl}")`]] }),
    });
  }

  return { rowIndex };
}

// Update the Email Sent / Sent At / Subject / Status columns (V, W, X, Y).
export async function updateSupplierEmailStatus(
  sheetId: string,
  rowIndex: number,
  args: { sent: 'Yes' | 'No'; sentAt: string; subject: string; status: string },
  token: string,
): Promise<void> {
  await fetch(
    `${SHEETS_API}/${sheetId}/values/V${rowIndex}:Y${rowIndex}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        range: `V${rowIndex}:Y${rowIndex}`,
        values: [[args.sent, args.sentAt, args.subject, args.status]],
      }),
    },
  );
}

// Update the Voice Note column (U) on an existing supplier row. Aggregates all
// captured voice transcripts for the supplier — caller passes the concatenated text.
export async function updateSupplierVoiceNote(
  sheetId: string,
  rowIndex: number,
  voiceText: string,
  token: string,
): Promise<void> {
  await fetch(
    `${SHEETS_API}/${sheetId}/values/U${rowIndex}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: `U${rowIndex}`, values: [[voiceText]] }),
    },
  );
}

// Update the Products / Price Range / Avg Lead Time columns (P, Q, R) on an existing supplier row.
export async function updateSupplierProducts(
  sheetId: string,
  rowIndex: number,
  args: { productsText: string; priceRange: string; avgLeadTime: string },
  token: string,
): Promise<void> {
  await fetch(
    `${SHEETS_API}/${sheetId}/values/P${rowIndex}:R${rowIndex}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        range: `P${rowIndex}:R${rowIndex}`,
        values: [[args.productsText, args.priceRange, args.avgLeadTime]],
      }),
    },
  );
}

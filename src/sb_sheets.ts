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

// SourceBot "Products" tab — one row per product so each has its own image,
// dedicated price column, dedicated MOQ column, etc.
//   A=Timestamp · B=Supplier · C=Product Name · D=Image · E=Description
//   F=Price · G=MOQ · H=Lead Time · I=Tone · J=Notes · K=Last Updated
export const SB_PRODUCT_HEADERS = [
  'Timestamp', 'Supplier', 'Product Name', 'Image', 'Description',
  'Price', 'MOQ', 'Lead Time', 'Tone', 'Notes', 'Last Updated',
];

const PRODUCTS_TAB_NAME = 'Products';
const NO_DETAILS_PLACEHOLDER = '— no details yet (reply on Telegram with text or voice) —';

// Create a SourceBot Sheet inside a Drive folder. Returns the spreadsheet id+url.
export async function createSourceBotSheet(
  showName: string,
  parentFolderId: string,
  token: string,
): Promise<{ sheetId: string; sheetUrl: string }> {
  const title = `DaGama — ${showName} Supplier list`;

  // Create as a Drive file inside the buyer's show folder
  const driveRes = await fetch(`${DRIVE_API}?fields=id&supportsAllDrives=true`, {
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

  // Rename Sheet1 → "Suppliers", write supplier headers, add a Products tab
  await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, title: 'Suppliers' }, fields: 'title' } },
        { addSheet: { properties: { title: PRODUCTS_TAB_NAME } } },
      ],
    }),
  });

  // Suppliers headers
  const sHeaderRes = await fetch(`${SHEETS_API}/${spreadsheetId}/values/Suppliers!A1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [SB_SHEET_HEADERS] }),
  });
  if (!sHeaderRes.ok) throw new Error(`Supplier header write failed: ${sHeaderRes.status} ${await sHeaderRes.text()}`);

  // Products headers
  const pHeaderRes = await fetch(`${SHEETS_API}/${spreadsheetId}/values/${PRODUCTS_TAB_NAME}!A1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [SB_PRODUCT_HEADERS] }),
  });
  if (!pHeaderRes.ok) throw new Error(`Product header write failed: ${pHeaderRes.status} ${await pHeaderRes.text()}`);

  // Freeze headers + auto-size on both tabs. Products tab id we have to look up.
  const meta = await fetch(`${SHEETS_API}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json()) as { sheets?: Array<{ properties?: { sheetId: number; title: string } }> };
  const productsSheetId = meta.sheets?.find(s => s.properties?.title === PRODUCTS_TAB_NAME)?.properties?.sheetId ?? null;

  await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: SB_SHEET_HEADERS.length } } },
        ...(productsSheetId !== null ? [
          { updateSheetProperties: { properties: { sheetId: productsSheetId, gridProperties: { frozenRowCount: 1, rowCount: 1000, columnCount: SB_PRODUCT_HEADERS.length } }, fields: 'gridProperties.frozenRowCount,gridProperties.rowCount,gridProperties.columnCount' } },
          // Set a sensible default row height so image previews fit
          { updateDimensionProperties: { range: { sheetId: productsSheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1000 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
          // Image column wide enough for a thumbnail
          { updateDimensionProperties: { range: { sheetId: productsSheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
        ] : []),
      ],
    }),
  });

  return {
    sheetId: spreadsheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

// Lazy: ensure the "Products" tab exists on an already-created sheet (for
// buyers whose sheet was provisioned before the tab was introduced).
export async function ensureProductsTab(sheetId: string, token: string): Promise<void> {
  const meta = await fetch(`${SHEETS_API}/${sheetId}?fields=sheets.properties(sheetId,title)`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json()) as { sheets?: Array<{ properties?: { sheetId: number; title: string } }> };
  const exists = meta.sheets?.some(s => s.properties?.title === PRODUCTS_TAB_NAME);
  if (exists) return;

  await fetch(`${SHEETS_API}/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: PRODUCTS_TAB_NAME } } }],
    }),
  });
  await fetch(`${SHEETS_API}/${sheetId}/values/${PRODUCTS_TAB_NAME}!A1?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [SB_PRODUCT_HEADERS] }),
  });
  // Reload to get the new sheet id, then set frozen header + image col width
  const meta2 = await fetch(`${SHEETS_API}/${sheetId}?fields=sheets.properties(sheetId,title)`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json()) as { sheets?: Array<{ properties?: { sheetId: number; title: string } }> };
  const productsSheetId = meta2.sheets?.find(s => s.properties?.title === PRODUCTS_TAB_NAME)?.properties?.sheetId;
  if (productsSheetId !== undefined) {
    await fetch(`${SHEETS_API}/${sheetId}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          { updateSheetProperties: { properties: { sheetId: productsSheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
          { updateDimensionProperties: { range: { sheetId: productsSheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1000 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
          { updateDimensionProperties: { range: { sheetId: productsSheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
        ],
      }),
    });
  }
}

export interface SbProductRow {
  timestamp:    string;
  supplier:     string;
  productName:  string;
  imageUrl?:    string;  // raw Drive URL (e.g. lh3.googleusercontent.com/d/<id>) — wrapped in IMAGE() via toSheetsImageUrl
  description?: string;
  price?:       string;
  moq?:         string;
  leadTime?:    string;
  tone?:        string;
  notes?:       string;
}

// Append a product row to the Products tab. Returns the 1-based row index.
export async function appendProductRow(sheetId: string, row: SbProductRow, token: string): Promise<{ rowIndex: number }> {
  const placeholder = NO_DETAILS_PLACEHOLDER;
  const values = [
    row.timestamp,
    row.supplier,
    row.productName,
    '',                                       // D image — written via formula below
    row.description || placeholder,
    row.price       || '—',
    row.moq         || '—',
    row.leadTime    || '—',
    row.tone        || '',
    row.notes       || '',
    new Date().toISOString(),
  ];

  const appendRes = await fetch(
    `${SHEETS_API}/${sheetId}/values/${PRODUCTS_TAB_NAME}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    },
  );
  const appendData = await appendRes.json() as { updates?: { updatedRange?: string } };
  const rowMatch = (appendData.updates?.updatedRange ?? '').match(/!?[A-Z]+(\d+):/);
  const rowIndex = rowMatch ? parseInt(rowMatch[1], 10) : 2;

  // Write the IMAGE() formula in column D
  if (row.imageUrl) {
    await fetch(`${SHEETS_API}/${sheetId}/values/${PRODUCTS_TAB_NAME}!D${rowIndex}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[`=IMAGE("${toSheetsImageUrl(row.imageUrl)}")`]] }),
    });
  }

  return { rowIndex };
}

// Update an existing product row's cells (E:Last Updated). Empty/blank values
// fall through to the placeholder so the row visibly invites the user to add details.
export async function updateProductRow(
  sheetId: string,
  rowIndex: number,
  fields: { description?: string; price?: string; moq?: string; leadTime?: string; tone?: string; notes?: string },
  token: string,
): Promise<void> {
  const placeholder = NO_DETAILS_PLACEHOLDER;
  const values = [
    fields.description?.trim() || placeholder,
    fields.price?.trim()       || '—',
    fields.moq?.trim()         || '—',
    fields.leadTime?.trim()    || '—',
    fields.tone               ?? '',
    fields.notes              ?? '',
    new Date().toISOString(),
  ];
  await fetch(
    `${SHEETS_API}/${sheetId}/values/${PRODUCTS_TAB_NAME}!E${rowIndex}:K${rowIndex}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    },
  );
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
      body: JSON.stringify({ range: `N${rowIndex}`, values: [[`=IMAGE("${toSheetsImageUrl(row.cardFrontUrl)}")`]] }),
    });
  }

  return { rowIndex };
}

// Google Sheets =IMAGE() can't reliably load `lh3.googleusercontent.com/d/<id>`
// URLs (often returns #REF!). The `drive.google.com/thumbnail?id=<id>` endpoint
// works in both Sheets and HTML <img> tags.
export function toSheetsImageUrl(driveUrl: string): string {
  const m = driveUrl.match(/\/d\/([^/?#]+)/);
  if (!m) return driveUrl;
  return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w800`;
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

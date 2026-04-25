/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { getServiceAccountToken } from './google';

// ─────────────────────────────────────────────────────────────────────────────
// PDF generation via Google Drive: build HTML → upload as Google Doc (Drive
// converts on import) → export as PDF → save the PDF binary back to Drive in
// the supplier or show folder. Pure-API approach so no PDF library is needed.
// ─────────────────────────────────────────────────────────────────────────────

interface GeneratedPdf { docUrl: string; pdfUrl: string }

export async function generateSupplierPdf(companyId: string, env: Env): Promise<GeneratedPdf | null> {
  const company = await env.DB.prepare(
    `SELECT id, buyer_id, name, show_name, sheet_row, cards_folder_id FROM sb_companies WHERE id = ?`
  ).bind(companyId).first<{ id: string; buyer_id: string; name: string; show_name: string; sheet_row: number | null; cards_folder_id: string | null }>();
  if (!company?.cards_folder_id) return null;

  const contacts = await env.DB.prepare(
    `SELECT name, title, email, phone, linkedin_url, address, card_front_url, card_back_url, person_photo_url, person_description, notes
       FROM sb_contacts WHERE company_id = ? ORDER BY created_at`
  ).bind(companyId).all<{ name: string | null; title: string | null; email: string | null; phone: string | null; linkedin_url: string | null; address: string | null; card_front_url: string | null; card_back_url: string | null; person_photo_url: string | null; person_description: string | null; notes: string | null }>();

  const products = await env.DB.prepare(
    `SELECT name, description, price, moq, lead_time, image_url FROM sb_products WHERE company_id = ? ORDER BY created_at`
  ).bind(companyId).all<{ name: string; description: string | null; price: string | null; moq: string | null; lead_time: string | null; image_url: string | null }>();

  const voiceNotes = await env.DB.prepare(
    `SELECT transcript, extracted_price, extracted_moq, extracted_lead_time, extracted_tone, created_at FROM sb_voice_notes WHERE company_id = ? ORDER BY created_at`
  ).bind(companyId).all<{ transcript: string; extracted_price: string | null; extracted_moq: string | null; extracted_lead_time: string | null; extracted_tone: string | null; created_at: string }>();

  const html = renderSupplierHtml({ company, contacts: contacts.results, products: products.results, voiceNotes: voiceNotes.results });

  return uploadDocAndExportPdf({
    html,
    docName: `DaGama — ${company.name} summary`,
    pdfName: `${safe(company.name)}_summary.pdf`,
    parentFolderId: company.cards_folder_id,
    env,
  });
}

export async function generateShowPdf(buyerId: string, showName: string, env: Env): Promise<GeneratedPdf | null> {
  const pass = await env.DB.prepare(
    `SELECT id, drive_folder_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
  ).bind(buyerId, showName).first<{ id: string; drive_folder_id: string | null }>();
  if (!pass?.drive_folder_id) return null;

  const buyer = await env.DB.prepare(`SELECT name, email FROM sb_buyers WHERE id = ?`).bind(buyerId).first<{ name: string; email: string }>();

  const companies = await env.DB.prepare(
    `SELECT id, name FROM sb_companies WHERE buyer_id = ? AND show_name = ? ORDER BY created_at`
  ).bind(buyerId, showName).all<{ id: string; name: string }>();

  const sections: string[] = [];
  for (const c of companies.results) {
    const contacts = await env.DB.prepare(
      `SELECT name, title, email, phone, card_front_url FROM sb_contacts WHERE company_id = ? ORDER BY created_at`
    ).bind(c.id).all<{ name: string | null; title: string | null; email: string | null; phone: string | null; card_front_url: string | null }>();
    const products = await env.DB.prepare(
      `SELECT name, price, moq, lead_time, image_url FROM sb_products WHERE company_id = ? ORDER BY created_at`
    ).bind(c.id).all<{ name: string; price: string | null; moq: string | null; lead_time: string | null; image_url: string | null }>();
    sections.push(renderSupplierSectionHtml({ company: c, contacts: contacts.results, products: products.results }));
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(showName)} — DaGama recap</title>` +
    `<style>body{font-family:Arial,Helvetica,sans-serif;color:#0F172A}h1{margin:0 0 4px}h2{border-top:1px solid #E2E8F0;padding-top:24px;margin-top:32px}img{max-width:240px;border-radius:6px}.kv{color:#475569}.products{margin:8px 0}.product{margin:8px 0;padding:8px;border:1px solid #E2E8F0;border-radius:6px}</style>` +
    `</head><body>` +
    `<h1>${escapeHtml(showName)}</h1>` +
    `<p class="kv">Buyer: ${escapeHtml(buyer?.name ?? '')} · ${escapeHtml(buyer?.email ?? '')}</p>` +
    `<p class="kv">${companies.results.length} suppliers captured.</p>` +
    sections.join('') +
    `</body></html>`;

  return uploadDocAndExportPdf({
    html,
    docName: `DaGama — ${showName} recap`,
    pdfName: `${safe(showName)}_recap.pdf`,
    parentFolderId: pass.drive_folder_id,
    env,
  });
}

// ── HTML renderers ───────────────────────────────────────────────────────────

interface SupplierData {
  company:    { name: string; show_name: string };
  contacts:   Array<{ name: string | null; title: string | null; email: string | null; phone: string | null; linkedin_url: string | null; address: string | null; card_front_url: string | null; card_back_url: string | null; person_photo_url: string | null; person_description: string | null; notes: string | null }>;
  products:   Array<{ name: string; description: string | null; price: string | null; moq: string | null; lead_time: string | null; image_url: string | null }>;
  voiceNotes: Array<{ transcript: string; extracted_price: string | null; extracted_moq: string | null; extracted_lead_time: string | null; extracted_tone: string | null; created_at: string }>;
}

function renderSupplierHtml(d: SupplierData): string {
  const c = d.contacts[0];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(d.company.name)}</title>` +
    `<style>body{font-family:Arial,Helvetica,sans-serif;color:#0F172A;max-width:800px;margin:0 auto}h1{margin:0 0 4px}h2{border-top:1px solid #E2E8F0;padding-top:24px}img{max-width:280px;border-radius:6px}.kv{color:#475569}.product{margin:12px 0;padding:10px;border:1px solid #E2E8F0;border-radius:6px}</style>` +
    `</head><body>` +
    `<h1>${escapeHtml(d.company.name)}</h1>` +
    `<p class="kv">Captured at ${escapeHtml(d.company.show_name)}</p>` +
    (c ? `<h2>Contact</h2>
      <p><b>${escapeHtml(c.name ?? '')}</b>${c.title ? ' — ' + escapeHtml(c.title) : ''}<br>` +
      (c.email ? `📧 ${escapeHtml(c.email)}<br>` : '') +
      (c.phone ? `📞 ${escapeHtml(c.phone)}<br>` : '') +
      (c.linkedin_url ? `🔗 <a href="${escapeAttr(c.linkedin_url)}">${escapeHtml(c.linkedin_url)}</a><br>` : '') +
      (c.address ? `📍 ${escapeHtml(c.address)}<br>` : '') +
      `</p>` +
      (c.card_front_url ? `<img src="${imgSrc(c.card_front_url)}" alt="Card front">` : '') +
      (c.card_back_url  ? `<img src="${imgSrc(c.card_back_url)}"  alt="Card back" style="margin-left:8px">` : '') +
      (c.person_photo_url ? `<div style="margin-top:8px"><img src="${imgSrc(c.person_photo_url)}" alt="Person">${c.person_description ? `<p class="kv">${escapeHtml(c.person_description)}</p>` : ''}</div>` : '')
      : '') +
    (d.products.length ? `<h2>Products (${d.products.length})</h2>` +
      d.products.map(p => `<div class="product">
        <b>${escapeHtml(p.name)}</b>` +
        (p.description ? `<br><span class="kv">${escapeHtml(p.description)}</span>` : '') +
        (p.price     ? `<br>💰 ${escapeHtml(p.price)}`     : '') +
        (p.moq       ? `<br>📊 MOQ ${escapeHtml(p.moq)}`   : '') +
        (p.lead_time ? `<br>⏱ ${escapeHtml(p.lead_time)}` : '') +
        (p.image_url ? `<br><img src="${imgSrc(p.image_url)}" alt="${escapeAttr(p.name)}">` : '') +
        `</div>`).join('') : '') +
    (d.voiceNotes.length ? `<h2>Notes</h2>` +
      d.voiceNotes.map(v => `<p>📝 <i>"${escapeHtml(v.transcript)}"</i><br><span class="kv">${escapeHtml(v.created_at)}</span></p>`).join('') : '') +
    `</body></html>`;
}

function renderSupplierSectionHtml(d: { company: { id: string; name: string }; contacts: Array<{ name: string | null; title: string | null; email: string | null; phone: string | null; card_front_url: string | null }>; products: Array<{ name: string; price: string | null; moq: string | null; lead_time: string | null; image_url: string | null }> }): string {
  const c = d.contacts[0];
  return `<h2>${escapeHtml(d.company.name)}</h2>` +
    (c ? `<p><b>${escapeHtml(c.name ?? '')}</b>${c.title ? ' — ' + escapeHtml(c.title) : ''}` +
      (c.email ? `<br>📧 ${escapeHtml(c.email)}` : '') +
      (c.phone ? `<br>📞 ${escapeHtml(c.phone)}` : '') +
      (c.card_front_url ? `<br><img src="${imgSrc(c.card_front_url)}">` : '') +
      `</p>` : '') +
    (d.products.length ? `<div class="products">` + d.products.map(p =>
      `<div class="product"><b>${escapeHtml(p.name)}</b>` +
      (p.price     ? ` — ${escapeHtml(p.price)}`     : '') +
      (p.moq       ? ` · MOQ ${escapeHtml(p.moq)}`   : '') +
      (p.lead_time ? ` · ${escapeHtml(p.lead_time)}` : '') +
      (p.image_url ? `<br><img src="${imgSrc(p.image_url)}" alt="${escapeAttr(p.name)}">` : '') +
      `</div>`).join('') + `</div>` : '');
}

// ── Drive plumbing ───────────────────────────────────────────────────────────

interface UploadArgs {
  html:           string;
  docName:        string;
  pdfName:        string;
  parentFolderId: string;
  env:            Env;
}

async function uploadDocAndExportPdf(args: UploadArgs): Promise<GeneratedPdf | null> {
  const tok = await getServiceAccountToken(args.env);

  // 1. Multipart upload: html bytes → Drive imports as Google Doc (mimeType conversion)
  const boundary = `----dagama_${crypto.randomUUID()}`;
  const meta = JSON.stringify({
    name:     args.docName,
    mimeType: 'application/vnd.google-apps.document',
    parents:  [args.parentFolderId],
  });
  const enc = new TextEncoder();
  const preamble = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`
  );
  const htmlBytes = enc.encode(args.html);
  const epilogue = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(preamble.length + htmlBytes.length + epilogue.length);
  body.set(preamble, 0);
  body.set(htmlBytes, preamble.length);
  body.set(epilogue, preamble.length + htmlBytes.length);

  const docRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: body.buffer,
  });
  if (!docRes.ok) { console.error('[pdf] Doc upload failed', docRes.status, await docRes.text()); return null; }
  const docData = await docRes.json() as { id?: string };
  if (!docData.id) return null;
  const docId = docData.id;

  // 2. Export as PDF
  const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=application/pdf`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!exportRes.ok) { console.error('[pdf] Doc export failed', exportRes.status); return null; }
  const pdfBytes = await exportRes.arrayBuffer();

  // 3. Upload the PDF binary back into the same folder
  const boundary2 = `----dagama_${crypto.randomUUID()}`;
  const meta2 = JSON.stringify({ name: args.pdfName, mimeType: 'application/pdf', parents: [args.parentFolderId] });
  const preamble2 = enc.encode(
    `--${boundary2}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta2}\r\n` +
    `--${boundary2}\r\nContent-Type: application/pdf\r\n\r\n`
  );
  const epilogue2 = enc.encode(`\r\n--${boundary2}--`);
  const pdfBytesU8 = new Uint8Array(pdfBytes);
  const body2 = new Uint8Array(preamble2.length + pdfBytesU8.length + epilogue2.length);
  body2.set(preamble2, 0);
  body2.set(pdfBytesU8, preamble2.length);
  body2.set(epilogue2, preamble2.length + pdfBytesU8.length);

  const pdfRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${boundary2}` },
    body: body2.buffer,
  });
  if (!pdfRes.ok) { console.error('[pdf] PDF upload failed', pdfRes.status); return null; }
  const pdfData = await pdfRes.json() as { id?: string };
  if (!pdfData.id) return null;

  return {
    docUrl: `https://docs.google.com/document/d/${docId}`,
    pdfUrl: `https://drive.google.com/file/d/${pdfData.id}/view`,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function safe(s: string): string { return s.replace(/[^a-z0-9]+/gi, '_').slice(0, 60); }
function imgSrc(driveUrl: string): string {
  const m = driveUrl.match(/\/d\/([^/?#]+)/);
  if (!m) return driveUrl;
  return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w600`;
}
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s: string): string { return escapeHtml(s).replace(/"/g, '&quot;'); }

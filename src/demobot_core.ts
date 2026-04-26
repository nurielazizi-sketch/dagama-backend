/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { ocrThenExtract, type ExtractedContact } from './extract';
import { fetchAndAnalyzeWebsite, type WebsiteAnalysis } from './db_enrich';
import { getServiceAccountToken } from './google';
import { provisionProspectBundle, writeProspectRow, patchProspectWebsiteFields, type ProspectAssets } from './db_sheets';
import { sendDemobotEmail1, scheduleDemobotFollowups } from './db_emails';
import { generateProspectPdf } from './pdf';
import { trackEvent } from './funnel';

// ─────────────────────────────────────────────────────────────────────────────
// Channel-agnostic scan flow used by both Telegram (src/demobot.ts) and
// WhatsApp (src/demobot_wa.ts).
//
// Two phases:
//
//   1. runCardScan — FAST path. Extract → provision sheet/Drive → upload card →
//      insert row → write sheet row → bump rollup → track event. Returns as soon
//      as the freelancer can be told "✅ here's the sheet/folder URL" — typically
//      ~10-15s. The caller renders this into a channel-native reply.
//
//   2. backgroundEnrichProspect — SLOW path. Website analysis (3-5s),
//      Email 1 send (~3s), follow-up scheduling (<1s), PDF generation (5-15s).
//      Caller awaits this AFTER sending the reply, so Telegram/WhatsApp
//      acknowledgement arrives before any of these complete.
//
// Industry classification (Gemini Prompt 2) was dropped from the critical path
// 2026-04-26 — it's vestigial without a curated shows_catalog to match against.
// classifyIndustry() in db_enrich.ts is still exported in case we want to call
// it lazily later.
// ─────────────────────────────────────────────────────────────────────────────

export type ScanResult =
  | {
      ok:        true;
      prospectId: string;
      contact:   ExtractedContact;
      bundle:    ProspectAssets;
    }
  | {
      ok:      false;
      reason:  'no_email' | 'extract_failed' | 'provision_failed' | 'duplicate';
      message: string;
    };

export interface ScanInput {
  freelancerUserId: string;
  showId:           string | null;
  showName:         string;
  cardBytes:        ArrayBuffer;
  cardMimeType?:    string;        // defaults to image/jpeg
  pendingLanguage?: string;
  referrerBuyerId?: string;
  env:              Env;
}

// ─────────────────────────────────────────────────────────────────────────────
// FAST path — returns as soon as the prospect record exists + sheet has a row.
// ─────────────────────────────────────────────────────────────────────────────
export async function runCardScan(input: ScanInput): Promise<ScanResult> {
  const env = input.env;
  const mime = input.cardMimeType ?? 'image/jpeg';
  const base64 = arrayBufferToBase64(input.cardBytes);

  // 1. Extract contact (must complete before reply — without it we have nothing).
  let extracted;
  try {
    extracted = await ocrThenExtract(base64, mime, env);
  } catch (e) {
    console.error('[demobot/core] extract failed:', e);
    return { ok: false, reason: 'extract_failed', message: 'Extraction failed — try a clearer photo.' };
  }
  const c = extracted.contact;
  if (!c.email) {
    return { ok: false, reason: 'no_email', message: 'No email detected on this card. Reply with the email and we\'ll add it.' };
  }

  // 2. Provision Sheet + Drive folder.
  let bundle: ProspectAssets;
  try {
    bundle = await provisionProspectBundle({
      showName:      input.showName,
      companyName:   c.company || c.name || 'Prospect',
      prospectEmail: c.email,
      prospectName:  c.name,
    }, env);
  } catch (e) {
    console.error('[demobot/core] provision failed:', e);
    return { ok: false, reason: 'provision_failed', message: 'Failed to create the prospect sheet. Try again.' };
  }

  // 3. Upload the card photo to the Cards/ subfolder.
  let cardFrontUrl: string | null = null;
  try {
    const saToken = await getServiceAccountToken(env);
    const cardsFolderId = await findChildFolderId(bundle.driveFolderId, 'Cards', saToken);
    if (cardsFolderId) {
      cardFrontUrl = await uploadJpegToDrive(input.cardBytes, sanitize(c.company || c.name || 'card') + '_front', cardsFolderId, mime, saToken);
    }
  } catch (e) {
    console.error('[demobot/core] card upload failed:', e);
  }

  // 4. Persist demobot_prospects row (insert or short-circuit on duplicate).
  const prospectId = await insertProspect({
    freelancerUserId: input.freelancerUserId,
    showId:           input.showId,
    showName:         input.showName,
    contact:          c,
    detectedLanguage: input.pendingLanguage ?? defaultLanguageFromCountry(c.country),
    cardFrontUrl,
    referrerBuyerId:  input.referrerBuyerId ?? null,
    bundle,
  }, env);
  if (!prospectId) {
    return { ok: false, reason: 'duplicate', message: 'Already scanned this prospect at this show — skipping duplicate.' };
  }

  // 5. Write contact row to the sheet (best-effort).
  try {
    await writeProspectRow(bundle.sheetId, {
      timestamp:    new Date().toISOString(),
      name:         c.name,
      title:        c.title,
      company:      c.company || 'Unknown',
      email:        c.email,
      phone:        c.phone,
      website:      c.website,
      linkedin:     c.linkedin,
      address:      c.address,
      cardFrontUrl: cardFrontUrl ?? undefined,
      // Industry / website-derived fields are populated lazily by backgroundEnrichProspect.
    }, env);
  } catch (e) {
    console.error('[demobot/core] sheet row write failed:', e);
  }

  // 6. Per-day rollup + event log (cheap).
  await bumpFreelancerDay(input.freelancerUserId, input.showId, env);
  await trackEvent(env, {
    buyerId: null,
    eventName: 'demobot_demo_conducted',
    properties: {
      prospect_id: prospectId,
      freelancer_user_id: input.freelancerUserId,
      show: input.showName,
      language: input.pendingLanguage ?? null,
      via: 'core',
    },
  });

  return { ok: true, prospectId, contact: c, bundle };
}

// ─────────────────────────────────────────────────────────────────────────────
// SLOW path — runs AFTER the freelancer's confirmation reply has gone out.
// Awaited by the channel handler so the worker stays alive through it; the
// freelancer doesn't see any of this latency directly.
// ─────────────────────────────────────────────────────────────────────────────
export async function backgroundEnrichProspect(prospectId: string, env: Env): Promise<void> {
  // Snapshot the prospect's website + sheet id so we can do website analysis
  // and the email-1 send in parallel.
  const p = await env.DB.prepare(
    `SELECT website, sheet_id FROM demobot_prospects WHERE id = ?`
  ).bind(prospectId).first<{ website: string | null; sheet_id: string | null }>();

  const websitePromise: Promise<void> = (async () => {
    if (!p?.website) return;
    try {
      const analysis = await fetchAndAnalyzeWebsite(p.website, env);
      if (!analysis) return;
      await env.DB.prepare(
        `UPDATE demobot_prospects SET website_summary_json = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(JSON.stringify(analysis), prospectId).run();
      if (p.sheet_id) {
        await patchProspectWebsiteFields(p.sheet_id, {
          companySize:        analysis.companySize,
          certifications:     analysis.certifications,
          productsServices:   analysis.productsServices,
          geographicPresence: analysis.geographicPresence,
        }, env);
      }
    } catch (e) {
      console.error('[demobot/core] website enrich failed:', e);
    }
  })();

  const emailPromise: Promise<void> = (async () => {
    try {
      await sendDemobotEmail1(prospectId, env);
      await scheduleDemobotFollowups(prospectId, env);
    } catch (e) {
      console.error('[demobot/core] email/schedule failed:', e);
    }
  })();

  const pdfPromise: Promise<void> = (async () => {
    try {
      const pdf = await generateProspectPdf(prospectId, env);
      if (pdf) {
        await env.DB.prepare(
          `UPDATE demobot_prospects SET pdf_drive_url = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(pdf.pdfUrl, prospectId).run();
      }
    } catch (e) {
      console.error('[demobot/core] pdf failed:', e);
    }
  })();

  await Promise.allSettled([websitePromise, emailPromise, pdfPromise]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-day rollup + prospect insert helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function bumpFreelancerDay(freelancerUserId: string, showId: string | null, env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO demobot_freelancer_demos (freelancer_user_id, show_id, day_local, demos_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(freelancer_user_id, day_local) DO UPDATE SET
       demos_count = demos_count + 1,
       updated_at  = datetime('now')`
  ).bind(freelancerUserId, showId, today).run();
}

export async function insertProspect(args: {
  freelancerUserId: string;
  showId:           string | null;
  showName:         string;
  contact:          ExtractedContact;
  detectedLanguage: string;
  cardFrontUrl:     string | null;
  referrerBuyerId:  string | null;
  bundle:           ProspectAssets;
}, env: Env): Promise<string | null> {
  const id = crypto.randomUUID().replace(/-/g, '');
  const now = Math.floor(Date.now() / 1000);
  const c = args.contact;

  // Industry / industry_confidence / website_summary_json are filled in lazily
  // by backgroundEnrichProspect — left null on insert.
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO demobot_prospects (
       id, freelancer_user_id, show_id, show_name_raw,
       prospect_email, prospect_name, prospect_title, company, phone,
       website, linkedin, address, detected_country, detected_language,
       card_front_url,
       drive_folder_id, drive_folder_url, sheet_id, sheet_url,
       referrer_buyer_id,
       scanned_at, created_at, updated_at
     ) VALUES (?,?,?,?,  ?,?,?,?,?,  ?,?,?,?,?,  ?,  ?,?,?,?,  ?,  ?, datetime('now'), datetime('now'))`
  ).bind(
    id, args.freelancerUserId, args.showId, args.showName,
    c.email, c.name || null, c.title || null, c.company || null, c.phone || null,
    c.website || null, c.linkedin || null, c.address || null, c.country || null, args.detectedLanguage,
    args.cardFrontUrl,
    args.bundle.driveFolderId, args.bundle.driveFolderUrl, args.bundle.sheetId, args.bundle.sheetUrl,
    args.referrerBuyerId,
    now,
  ).run();

  if ((r.meta.changes ?? 0) === 0) return null;   // duplicate
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function findChildFolderId(parentId: string, name: string, token: string): Promise<string | null> {
  const q = encodeURIComponent(`'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json() as { files?: Array<{ id: string }> };
  return data.files?.[0]?.id ?? null;
}

export async function uploadJpegToDrive(
  buffer: ArrayBuffer,
  baseName: string,
  parentFolderId: string,
  mimeType: string,
  token: string,
): Promise<string> {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const fileName = `${baseName}.${ext}`;
  const boundary = `----dagama_${crypto.randomUUID()}`;
  const meta = JSON.stringify({ name: fileName, mimeType, parents: [parentFolderId] });
  const enc = new TextEncoder();
  const preamble = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const epilogue = enc.encode(`\r\n--${boundary}--`);
  const bytes = new Uint8Array(buffer);
  const body = new Uint8Array(preamble.length + bytes.length + epilogue.length);
  body.set(preamble, 0); body.set(bytes, preamble.length); body.set(epilogue, preamble.length + bytes.length);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: body.buffer,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { id?: string };
  if (!data.id) throw new Error('Drive upload returned no id');

  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions?supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  return `https://lh3.googleusercontent.com/d/${data.id}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers (channel-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
  }
  return btoa(binary);
}

export function sanitize(s: string): string { return s.replace(/[^a-z0-9]+/gi, '_').slice(0, 60); }

export function defaultLanguageFromCountry(country: string): string {
  const c = country.toLowerCase();
  if (c.includes('china') || c.includes('hong kong') || c.includes('taiwan')) return 'zh-CN';
  if (c.includes('germany') || c.includes('austria') || c.includes('switzerland')) return 'de';
  if (/saudi|uae|emirates|qatar|kuwait|bahrain|oman|jordan|egypt|morocco/.test(c)) return 'ar';
  if (c.includes('israel')) return 'he';
  if (c.includes('turkey') || c.includes('türk')) return 'tr';
  if (c.includes('korea')) return 'ko';
  if (/spain|mexico|argentin|colombia|chile|peru/.test(c)) return 'es';
  if (c.includes('france') || c.includes('belgium')) return 'fr';
  if (c.includes('portugal') || c.includes('brazil')) return 'pt';
  return 'en';
}

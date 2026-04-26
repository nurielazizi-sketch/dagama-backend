/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { extractContactFromImage } from './extract';
import { getServiceAccountToken, createDriveFolder } from './google';
import {
  appendSupplierRow,
  updateSupplierCardBack,
  updateSupplierPerson,
  updateSupplierVoiceNote,
  appendProductRow,
  updateProductRow,
  ensureProductsTab,
  updateSupplierProducts,
} from './sb_sheets';
import { scheduleFunnelOnFirstScan, trackEvent } from './funnel';

// ─────────────────────────────────────────────────────────────────────────────
// SourceBot channel-agnostic core (Phase 1 — supplier-card capture only).
//
// Mirrors handleSupplierCard() in src/sourcebot.ts, callable from any channel
// that produces image bytes — WhatsApp inbound media and the web upload
// endpoint, today. Telegram still goes through src/sourcebot.ts unchanged.
//
// A handful of helpers (getActivePass, checkAndConsumeScan, supplier folder
// creation, Drive upload) are intentionally duplicated here so this module
// stays self-contained; Telegram's copy is untouched. They'll be deduplicated
// when we eventually migrate sourcebot.ts onto this core (separate PR).
// ─────────────────────────────────────────────────────────────────────────────

interface ActivePass {
  id:                  string;
  show_name:           string;
  status:              string;
  duration_days:       number;
  first_scan_at:       number | null;
  free_window_ends_at: number | null;
  free_scans_limit:    number | null;
  free_scans_used:     number;
  paid_plan:           string | null;
  sheet_id:            string | null;
  sheet_url:           string | null;
  drive_folder_id:     string | null;
}

interface SupplierFolders { parent: string; cards: string; products: string }

export interface SupplierCaptureInput {
  buyerId:  string;
  channel:  'whatsapp' | 'web';
  media:
    | { kind: 'r2_key'; key: string; mimeType?: string }
    | { kind: 'bytes'; bytes: Uint8Array; mimeType: string };
  caption?: string;
  reply: ReplyTarget;
}

export type ReplyTarget =
  | { channel: 'whatsapp'; phone: string }
  | { channel: 'web' }
  | { channel: 'none' };

export interface SupplierCaptureResult {
  ok:           boolean;
  status:       'success' | 'no_active_show' | 'free_tier_exhausted' | 'extraction_failed' | 'sheet_failed' | 'storage_failed' | 'error';
  companyId?:   string;
  showName?:    string;
  sheetUrl?:    string;
  rowIndex?:    number;
  contact?: {
    name:     string;
    title:    string;
    company:  string;
    email:    string;
    phone:    string;
    website:  string;
    linkedin: string;
    address:  string;
    country:  string;
  };
  error?:       string;
  reason?:      string;             // user-facing reason for non-fatal blocks (e.g. free tier message)
}

// ── Public entry ─────────────────────────────────────────────────────────────

export async function captureSupplierFromPhoto(input: SupplierCaptureInput, env: Env): Promise<SupplierCaptureResult> {
  // 1. Resolve active show pass for this buyer.
  const pass = await getActivePass(input.buyerId, env);
  if (!pass?.sheet_id) {
    const reason = `No active show found for your account. Set one up at ${env.ORIGIN} or contact support.`;
    await sendReply(input.reply, `⚠️ ${reason}`, env);
    return { ok: false, status: 'no_active_show', reason };
  }

  // 2. Free-tier scan budget (paid plans pass through).
  const check = await checkAndConsumeScan(pass, env);
  if (!check.allowed) {
    const reason = check.reason ?? 'Free tier exhausted. Upgrade to keep capturing.';
    await sendReply(input.reply, reason, env);
    return { ok: false, status: 'free_tier_exhausted', reason };
  }

  // 3. Get the raw bytes (and mimeType). The web path arrives as bytes; the
  //    WhatsApp path already cached the bytes in R2, so we read them back.
  let rawBuffer: ArrayBuffer;
  let mimeType:  string;
  try {
    if (input.media.kind === 'bytes') {
      // Copy into a fresh ArrayBuffer (the Uint8Array's underlying buffer is
      // typed ArrayBuffer | SharedArrayBuffer in Workers; we only handle the
      // former here).
      const u8 = input.media.bytes;
      const ab = new ArrayBuffer(u8.byteLength);
      new Uint8Array(ab).set(u8);
      rawBuffer = ab;
      mimeType  = input.media.mimeType;
    } else {
      const obj = await env.R2_BUCKET.get(input.media.key);
      if (!obj) throw new Error(`R2 object missing: ${input.media.key}`);
      rawBuffer = await obj.arrayBuffer();
      mimeType = input.media.mimeType ?? 'image/jpeg';
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot_core] media read failed', { buyerId: input.buyerId, error: msg });
    return { ok: false, status: 'storage_failed', error: msg };
  }

  await sendReply(input.reply, `🔍 Scanning supplier card…`, env);

  // 4. Gemini vision + service-account token, in parallel (both required next).
  let extracted: SupplierCaptureResult['contact'] & object;
  let saToken: string;
  try {
    const base64 = arrayBufferToBase64(rawBuffer);
    const [vision, token] = await Promise.all([
      extractContactFromImage(base64, mimeType, env),
      getServiceAccountToken(env),
    ]);
    saToken = token;
    extracted = {
      name:     vision.contact.name     ?? '',
      title:    vision.contact.title    ?? '',
      company:  vision.contact.company  ?? '',
      email:    vision.contact.email    ?? '',
      phone:    vision.contact.phone    ?? '',
      website:  vision.contact.website  ?? '',
      linkedin: vision.contact.linkedin ?? '',
      address:  vision.contact.address  ?? '',
      country:  vision.contact.country  ?? '',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot_core] extraction failed', { buyerId: input.buyerId, error: msg });
    await sendReply(input.reply, `⚠️ I couldn't read the card. Try a clearer photo.`, env);
    return { ok: false, status: 'extraction_failed', error: msg };
  }

  if (!extracted.company && !extracted.name) {
    await sendReply(input.reply, `⚠️ I couldn't find a supplier name or company on that card. Try a clearer photo.`, env);
    return { ok: false, status: 'extraction_failed', error: 'no_company_or_name' };
  }

  // 5. Upsert sb_companies (find existing by lowercased name + show, else insert).
  const companyName = (extracted.company || extracted.name || 'Unknown').trim();
  const existingCompany = await env.DB.prepare(
    `SELECT id FROM sb_companies WHERE buyer_id = ? AND show_name = ? AND lower(name) = lower(?) LIMIT 1`
  ).bind(input.buyerId, pass.show_name, companyName).first<{ id: string }>();

  const companyId = existingCompany?.id ?? (await env.DB.prepare(
    `INSERT INTO sb_companies (buyer_id, show_name, name, website, industry)
     VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).bind(input.buyerId, pass.show_name, companyName, extracted.website || null, null).first<{ id: string }>())?.id;
  if (!companyId) {
    await sendReply(input.reply, `❌ Failed to save the supplier.`, env);
    return { ok: false, status: 'error', error: 'company_insert_failed' };
  }

  // 6. Per-supplier folder hierarchy: "{Company} — {Month YYYY}" / Cards / Products
  let folders: SupplierFolders | undefined;
  if (pass.drive_folder_id) {
    try {
      folders = await getOrCreateSupplierFolders(companyId, companyName, pass.drive_folder_id, env, saToken);
    } catch (e) {
      console.error('[sourcebot_core] supplier folder create failed', e);
    }
  }

  // 7. Upload card front to Cards/ (or fall back to the show folder).
  let cardUrl: string | undefined;
  try {
    const parent = folders?.cards ?? pass.drive_folder_id ?? undefined;
    if (parent) {
      cardUrl = await uploadCardImage(rawBuffer, extracted.name || 'card', extracted.company, parent, saToken);
    }
  } catch (e) {
    console.error('[sourcebot_core] card upload failed', e);
  }

  // 8. Insert sb_contacts row (one per scan; same supplier can have many).
  await env.DB.prepare(
    `INSERT INTO sb_contacts (company_id, buyer_id, show_name, name, title, email, phone, linkedin_url, address, card_front_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    companyId, input.buyerId, pass.show_name,
    extracted.name     || null,
    extracted.title    || null,
    extracted.email    || null,
    extracted.phone    || null,
    extracted.linkedin || null,
    extracted.address  || null,
    cardUrl || null,
  ).run();

  // 9. Append the supplier row to the sheet (and remember the row index).
  let rowIndex: number | undefined;
  try {
    const folderUrl = folders?.parent ? `https://drive.google.com/drive/folders/${folders.parent}` : undefined;
    const appended = await appendSupplierRow(pass.sheet_id, {
      timestamp:    new Date().toISOString(),
      company:      companyName,
      contactName:  extracted.name    || '',
      title:        extracted.title   || '',
      email:        extracted.email   || '',
      phone:        extracted.phone   || '',
      website:      extracted.website || '',
      linkedin:     extracted.linkedin|| '',
      industry:     '',
      cardFrontUrl: cardUrl,
      folderUrl,
    }, saToken);
    rowIndex = appended.rowIndex;
    if (!existingCompany && rowIndex) {
      await env.DB.prepare(`UPDATE sb_companies SET sheet_row = ? WHERE id = ?`).bind(rowIndex, companyId).run();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot_core] sheet append failed', { companyId, error: msg });
    await sendReply(input.reply, `⚠️ Saved to your database, but couldn't write to your sheet. We'll retry later.`, env);
    return { ok: false, status: 'sheet_failed', error: msg, companyId, showName: pass.show_name };
  }

  // 10. User-facing confirmation. Telegram parity here — same fields, same order
  //     — minus the inline-keyboard buttons (those land in Phase 2 once the
  //     channel-agnostic action dispatch exists).
  const preview =
    `✅ *Supplier saved*\n\n` +
    `📛 *Name:* ${extracted.name    || '—'}\n` +
    `💼 *Title:* ${extracted.title  || '—'}\n` +
    `🏢 *Company:* ${companyName}\n` +
    `📧 *Email:* ${extracted.email  || '—'}\n` +
    `📞 *Phone:* ${extracted.phone  || '—'}\n` +
    (extracted.country  ? `🌍 *Country:* ${extracted.country}\n`   : '') +
    (extracted.website  ? `🌐 *Website:* ${extracted.website}\n`   : '') +
    (extracted.linkedin ? `🔗 *LinkedIn:* ${extracted.linkedin}\n` : '') +
    (extracted.address  ? `📍 *Address:* ${extracted.address}\n`   : '');
  await sendReply(input.reply, preview, env);

  await trackEvent(env, {
    buyerId:    input.buyerId,
    eventName:  'supplier_captured',
    properties: { company: companyName, has_email: !!extracted.email, channel: input.channel },
  });

  return {
    ok:        true,
    status:    'success',
    companyId,
    showName:  pass.show_name,
    sheetUrl:  pass.sheet_url ?? undefined,
    rowIndex,
    contact:   extracted,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Card back + Person photo extensions on an existing supplier.
// Both attach the photo to the latest contact row for the company, store it
// in the per-supplier Cards/ Drive folder, and update the matching sheet
// column (O for card back, AB/AC for person photo + description).
// ─────────────────────────────────────────────────────────────────────────────

export interface SupplierExtensionInput {
  companyId: string;
  buyerId:   string;
  channel:   'whatsapp' | 'web';
  media:
    | { kind: 'r2_key'; key: string; mimeType?: string }
    | { kind: 'bytes'; bytes: Uint8Array; mimeType: string };
  reply: ReplyTarget;
}

export interface SupplierExtensionResult {
  ok:           boolean;
  status:       'success' | 'no_supplier' | 'storage_failed' | 'upload_failed' | 'error';
  url?:         string;
  description?: string;        // person photo only
  error?:       string;
}

export async function attachCardBack(input: SupplierExtensionInput, env: Env): Promise<SupplierExtensionResult> {
  return attachExtensionPhoto(input, 'card_back', env);
}

export async function attachPersonPhoto(input: SupplierExtensionInput, env: Env): Promise<SupplierExtensionResult> {
  return attachExtensionPhoto(input, 'person_photo', env);
}

async function attachExtensionPhoto(
  input: SupplierExtensionInput,
  kind:  'card_back' | 'person_photo',
  env:   Env,
): Promise<SupplierExtensionResult> {
  const company = await env.DB.prepare(
    `SELECT id, name, show_name, sheet_row, buyer_id FROM sb_companies WHERE id = ? AND buyer_id = ?`
  ).bind(input.companyId, input.buyerId).first<{ id: string; name: string; show_name: string; sheet_row: number | null; buyer_id: string }>();
  if (!company) {
    await sendReply(input.reply, `Supplier not found.`, env);
    return { ok: false, status: 'no_supplier' };
  }

  // Read bytes (web → bytes; WA → r2_key cached by media id).
  let rawBuffer: ArrayBuffer;
  try {
    if (input.media.kind === 'bytes') {
      const u8 = input.media.bytes;
      const ab = new ArrayBuffer(u8.byteLength);
      new Uint8Array(ab).set(u8);
      rawBuffer = ab;
    } else {
      const obj = await env.R2_BUCKET.get(input.media.key);
      if (!obj) throw new Error(`R2 object missing: ${input.media.key}`);
      rawBuffer = await obj.arrayBuffer();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot_core] extension media read failed', { companyId: company.id, kind, error: msg });
    return { ok: false, status: 'storage_failed', error: msg };
  }

  // For person_photo we ask Gemini for a one-line description (best-effort).
  let description = '';
  if (kind === 'person_photo') {
    try { description = await describePersonImage(rawBuffer, input.media.kind === 'bytes' ? input.media.mimeType : 'image/jpeg', env); }
    catch (e) { console.error('[sourcebot_core] person description failed', e); }
  }

  // Resolve the per-supplier folder set (Cards/ subfolder).
  const folders = await getSupplierFoldersById(company.id, env, company.show_name, { buyerId: company.buyer_id });
  if (!folders) {
    await sendReply(input.reply, `⚠️ Couldn't locate the supplier's folder. Try again later.`, env);
    return { ok: false, status: 'upload_failed', error: 'no_folders' };
  }

  // Upload + DB update + sheet update.
  let url: string;
  try {
    const tok = await getServiceAccountToken(env);
    const fileLabel = kind === 'card_back' ? `${company.name}_back` : `${company.name}_person`;
    url = await uploadCardImage(rawBuffer, fileLabel, '', folders.cards, tok);

    if (kind === 'card_back') {
      await env.DB.prepare(
        `UPDATE sb_contacts SET card_back_url = ?
          WHERE id = (SELECT id FROM sb_contacts WHERE company_id = ? ORDER BY created_at DESC LIMIT 1)`
      ).bind(url, company.id).run();
      if (company.sheet_row) {
        const sheet = await env.DB.prepare(
          `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
        ).bind(company.buyer_id, company.show_name).first<{ sheet_id: string }>();
        if (sheet?.sheet_id) await updateSupplierCardBack(sheet.sheet_id, company.sheet_row, url, tok);
      }
    } else {
      await env.DB.prepare(
        `UPDATE sb_contacts SET person_photo_url = ?, person_description = ?
          WHERE id = (SELECT id FROM sb_contacts WHERE company_id = ? ORDER BY created_at DESC LIMIT 1)`
      ).bind(url, description || null, company.id).run();
      if (company.sheet_row) {
        const sheet = await env.DB.prepare(
          `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
        ).bind(company.buyer_id, company.show_name).first<{ sheet_id: string }>();
        if (sheet?.sheet_id) await updateSupplierPerson(sheet.sheet_id, company.sheet_row, { personPhotoUrl: url, personDescription: description }, tok);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot_core] extension upload failed', { companyId: company.id, kind, error: msg });
    await sendReply(input.reply, `⚠️ Couldn't save that photo. Try again.`, env);
    return { ok: false, status: 'upload_failed', error: msg };
  }

  const replyText = kind === 'card_back'
    ? `✅ Card back saved for *${company.name}*.`
    : `✅ Photo saved${description ? ` — ${description}` : ''}.`;
  await sendReply(input.reply, replyText, env);

  return { ok: true, status: 'success', url, description: kind === 'person_photo' ? description : undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Voice notes attached to a supplier. Single Gemini call returns the
// verbatim transcript + parsed price/MOQ/lead-time/tone keywords. We persist
// to sb_voice_notes and re-aggregate column U (Voice Note) on the sheet so all
// transcripts for the supplier appear in one cell, timestamped.
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceCaptureInput {
  companyId:     string;
  buyerId:       string;
  channel:       'whatsapp' | 'web';
  media:
    | { kind: 'r2_key'; key: string; mimeType?: string }
    | { kind: 'bytes'; bytes: Uint8Array; mimeType: string };
  durationSec?:  number;          // optional metadata (WA gives this)
  reply: ReplyTarget;
}

export interface VoiceCaptureResult {
  ok:           boolean;
  status:       'success' | 'no_supplier' | 'storage_failed' | 'transcribe_failed' | 'empty_transcript' | 'error';
  transcript?:  string;
  language?:    string;
  price?:       string;
  moq?:         string;
  leadTime?:    string;
  tone?:        string;
  error?:       string;
}

export async function attachVoiceNote(input: VoiceCaptureInput, env: Env): Promise<VoiceCaptureResult> {
  const company = await env.DB.prepare(
    `SELECT id, name, show_name, sheet_row, buyer_id FROM sb_companies WHERE id = ? AND buyer_id = ?`
  ).bind(input.companyId, input.buyerId).first<{ id: string; name: string; show_name: string; sheet_row: number | null; buyer_id: string }>();
  if (!company) {
    await sendReply(input.reply, `Supplier not found.`, env);
    return { ok: false, status: 'no_supplier' };
  }

  // Read bytes (web → already in memory; WA → r2 cache).
  let buffer:   ArrayBuffer;
  let mimeType: string;
  try {
    if (input.media.kind === 'bytes') {
      const u8 = input.media.bytes;
      const ab = new ArrayBuffer(u8.byteLength);
      new Uint8Array(ab).set(u8);
      buffer   = ab;
      mimeType = input.media.mimeType || 'audio/ogg';
    } else {
      const obj = await env.R2_BUCKET.get(input.media.key);
      if (!obj) throw new Error(`R2 object missing: ${input.media.key}`);
      buffer   = await obj.arrayBuffer();
      mimeType = input.media.mimeType ?? 'audio/ogg';
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot_core] voice media read failed', { companyId: company.id, error: msg });
    return { ok: false, status: 'storage_failed', error: msg };
  }

  await sendReply(input.reply, `🎤 Transcribing…`, env);

  // Gemini transcribe + extract.
  let extracted: VoiceExtraction;
  try {
    extracted = await transcribeAndExtract(arrayBufferToBase64(buffer), mimeType, env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot_core] voice transcribe failed', { companyId: company.id, error: msg });
    await sendReply(input.reply, `⚠️ Couldn't transcribe that voice note. Try again with a clearer recording.`, env);
    return { ok: false, status: 'transcribe_failed', error: msg };
  }

  if (!extracted.transcript || !extracted.transcript.trim()) {
    await sendReply(input.reply, `⚠️ I couldn't make out any speech in that voice note.`, env);
    return { ok: false, status: 'empty_transcript' };
  }

  // Persist + aggregate.
  await env.DB.prepare(
    `INSERT INTO sb_voice_notes
       (company_id, buyer_id, show_name, transcript, language, duration_seconds,
        extracted_price, extracted_moq, extracted_lead_time, extracted_tone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    company.id, company.buyer_id, company.show_name,
    extracted.transcript, extracted.language || null,
    input.durationSec ?? null,
    extracted.price || null, extracted.moq || null, extracted.lead_time || null, extracted.tone || null,
  ).run();

  if (company.sheet_row) {
    try {
      const all = await env.DB.prepare(
        `SELECT transcript, created_at FROM sb_voice_notes WHERE company_id = ? ORDER BY created_at`
      ).bind(company.id).all<{ transcript: string; created_at: string }>();
      const aggregated = all.results.map(v => `[${v.created_at}] ${v.transcript}`).join('\n\n');

      const sheet = await env.DB.prepare(
        `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
      ).bind(company.buyer_id, company.show_name).first<{ sheet_id: string }>();
      if (sheet?.sheet_id) {
        const tok = await getServiceAccountToken(env);
        await updateSupplierVoiceNote(sheet.sheet_id, company.sheet_row, aggregated, tok);
      }
    } catch (e) {
      console.error('[sourcebot_core] sheet voice update failed', e);
    }
  }

  // Confirmation reply (parity with sourcebot.ts:2581 minus the inline buttons).
  const extras: string[] = [];
  if (extracted.price)     extras.push(`💰 ${extracted.price}`);
  if (extracted.moq)       extras.push(`📊 MOQ ${extracted.moq}`);
  if (extracted.lead_time) extras.push(`⏱ ${extracted.lead_time}`);
  if (extracted.tone)      extras.push(`🎭 ${extracted.tone}`);
  await sendReply(
    input.reply,
    `✅ Voice note saved for *${company.name}*\n\n` +
    `_"${extracted.transcript.slice(0, 280)}${extracted.transcript.length > 280 ? '…' : ''}"_` +
    (extras.length ? `\n\n${extras.join(' · ')}` : ''),
    env,
  );

  return {
    ok:         true,
    status:     'success',
    transcript: extracted.transcript,
    language:   extracted.language,
    price:      extracted.price,
    moq:        extracted.moq,
    leadTime:   extracted.lead_time,
    tone:       extracted.tone,
  };
}

interface VoiceExtraction {
  transcript: string;
  language:   string;
  price:      string;
  moq:        string;
  lead_time:  string;
  tone:       string;
}

// Single Gemini call — copy of sourcebot.ts:2934 with mime_type parameterised
// so non-Telegram callers can pass audio/webm, audio/mp4, audio/aac, etc.
async function transcribeAndExtract(base64: string, mimeType: string, env: Env): Promise<VoiceExtraction> {
  const prompt =
    `You are processing a voice memo a buyer recorded about a supplier at a trade show. ` +
    `Transcribe the audio verbatim in the original language (do not translate). Then scan the ` +
    `transcript for price, minimum order quantity, lead time, and overall tone. ` +
    `Return ONLY a JSON object with these exact fields:\n` +
    `- transcript (verbatim, full)\n` +
    `- language (best-effort 2-letter code, e.g. "en", "zh", "es"; empty if unsure)\n` +
    `- price (NORMALIZED to standard money format with currency symbol and decimals — e.g. "$5.20" not "$5 and 20 cents", "€12.50" not "twelve fifty euros". Empty if no price mentioned.)\n` +
    `- moq (number with units, e.g. "5,000 pcs", "1 pallet". Empty if not mentioned.)\n` +
    `- lead_time (e.g. "30 days", "4 weeks". Empty if not mentioned.)\n` +
    `- tone (one of: positive, neutral, negative, enthusiastic, skeptical; empty if unclear)`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (!data.candidates?.length) throw new Error(`Gemini voice failed: ${data.error?.message ?? JSON.stringify(data)}`);

  const raw = data.candidates[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as Partial<VoiceExtraction>;
  return {
    transcript: parsed.transcript ?? '',
    language:   parsed.language   ?? '',
    price:      parsed.price      ?? '',
    moq:        parsed.moq        ?? '',
    lead_time:  parsed.lead_time  ?? '',
    tone:       parsed.tone       ?? '',
  };
}

// Gemini one-liner — same prompt as sourcebot.ts:2218.
async function describePersonImage(buffer: ArrayBuffer, mimeType: string, env: Env): Promise<string> {
  const base64 = arrayBufferToBase64(buffer);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: 'Describe this image in ONE short line. It might be the supplier rep, a booth, signage, a product display, or a setup shot. Examples: "Man in blue suit holding a brochure" / "Booth #B12 with red banner reading ACME Lighting" / "Showroom wall of LED panels". Return only the description, no preface.' },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ] }],
    }),
  });
  const d = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return (d.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim().split('\n')[0] ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Products. A product is captured against an active supplier.
//   - attachProductFromPhoto() — upload photo, classify (card vs product),
//     save sb_products row, append a Products-tab row, refresh column P on
//     the Suppliers tab with the aggregated bullet list.
//   - updateProductDetails()    — set/refresh price / MOQ / lead time / notes
//     for an existing product (UPDATE sb_products + UPDATE the product row).
//   - parseProductDetailsText() — Gemini structure-extraction over a free-form
//     reply (price, MOQ, lead time, tone) so a WA text reply can fill fields.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductCaptureInput {
  companyId: string;
  buyerId:   string;
  channel:   'whatsapp' | 'web';
  media:
    | { kind: 'r2_key'; key: string; mimeType?: string }
    | { kind: 'bytes'; bytes: Uint8Array; mimeType: string };
  reply: ReplyTarget;
}

export interface ProductCaptureResult {
  ok:           boolean;
  status:       'success' | 'reclassified_as_card' | 'no_supplier' | 'storage_failed' | 'upload_failed' | 'error';
  productId?:   string;
  productName?: string;
  description?: string;
  imageUrl?:    string;
  error?:       string;
}

export async function attachProductFromPhoto(input: ProductCaptureInput, env: Env): Promise<ProductCaptureResult> {
  const company = await env.DB.prepare(
    `SELECT id, name, show_name, sheet_row, buyer_id FROM sb_companies WHERE id = ? AND buyer_id = ?`
  ).bind(input.companyId, input.buyerId).first<{ id: string; name: string; show_name: string; sheet_row: number | null; buyer_id: string }>();
  if (!company) {
    await sendReply(input.reply, `Supplier not found.`, env);
    return { ok: false, status: 'no_supplier' };
  }

  // Read bytes (web → memory; WA → r2 cache).
  let buffer:   ArrayBuffer;
  let mimeType: string;
  try {
    if (input.media.kind === 'bytes') {
      const u8 = input.media.bytes;
      const ab = new ArrayBuffer(u8.byteLength);
      new Uint8Array(ab).set(u8);
      buffer   = ab;
      mimeType = input.media.mimeType;
    } else {
      const obj = await env.R2_BUCKET.get(input.media.key);
      if (!obj) throw new Error(`R2 object missing: ${input.media.key}`);
      buffer   = await obj.arrayBuffer();
      mimeType = input.media.mimeType ?? 'image/jpeg';
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sourcebot_core] product media read failed', { companyId: company.id, error: msg });
    return { ok: false, status: 'storage_failed', error: msg };
  }

  await sendReply(input.reply, `🔍 Reading the product…`, env);

  // Classify: business_card → caller should re-route to capture (we surface
  // status='reclassified_as_card' so the caller can decide).
  const base64 = arrayBufferToBase64(buffer);
  let productName = 'Product';
  let productDesc = '';
  try {
    const fields = await classifyProductImage(base64, mimeType, env);
    if (fields.type === 'business_card') {
      return {
        ok:     false,
        status: 'reclassified_as_card',
        // No reply here — caller decides whether to re-run as supplier capture.
      };
    }
    productName = fields.name || 'Product';
    productDesc = fields.description || '';
  } catch (e) {
    console.error('[sourcebot_core] product classify failed', e);
  }

  // Upload to per-supplier Products/ subfolder.
  let imageUrl: string | undefined;
  let saToken:  string | undefined;
  try {
    saToken = await getServiceAccountToken(env);
    const folders = await getSupplierFoldersById(company.id, env, company.show_name, { buyerId: company.buyer_id }, saToken);
    if (folders) imageUrl = await uploadCardImage(buffer, productName, '', folders.products, saToken);
  } catch (e) {
    console.error('[sourcebot_core] product drive upload failed', e);
  }

  // Insert sb_products row.
  const product = await env.DB.prepare(
    `INSERT INTO sb_products (company_id, buyer_id, show_name, name, description, image_url)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(company.id, company.buyer_id, company.show_name, productName, productDesc || null, imageUrl || null).first<{ id: string }>();
  if (!product?.id) {
    await sendReply(input.reply, `❌ Failed to save the product.`, env);
    return { ok: false, status: 'error', error: 'product_insert_failed' };
  }

  // Append Products-tab row + refresh supplier aggregate (column P).
  try {
    if (!saToken) saToken = await getServiceAccountToken(env);
    const sheet = await env.DB.prepare(
      `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
    ).bind(company.buyer_id, company.show_name).first<{ sheet_id: string }>();
    if (sheet?.sheet_id) {
      await ensureProductsTab(sheet.sheet_id, saToken);
      const { rowIndex } = await appendProductRow(sheet.sheet_id, {
        timestamp:   new Date().toISOString(),
        supplier:    company.name,
        productName,
        imageUrl,
        description: productDesc,
      }, saToken);
      await env.DB.prepare(`UPDATE sb_products SET sheet_row = ? WHERE id = ?`).bind(rowIndex, product.id).run();

      if (company.sheet_row) {
        const all = await env.DB.prepare(
          `SELECT name FROM sb_products WHERE company_id = ? ORDER BY created_at`
        ).bind(company.id).all<{ name: string }>();
        const productsText = all.results.map(p => `• ${p.name ?? '—'}`).join('\n');
        await updateSupplierProducts(sheet.sheet_id, company.sheet_row, { productsText, priceRange: '', avgLeadTime: '' }, saToken);
      }
    }
  } catch (e) {
    console.error('[sourcebot_core] product sheet append failed', e);
  }

  await sendReply(
    input.reply,
    `✅ *${productName}* saved${productDesc ? `\n_${productDesc}_` : ''}\n\nReply with price, MOQ, lead time, or notes — or send the next product photo.`,
    env,
  );

  await trackEvent(env, {
    buyerId:    company.buyer_id,
    eventName:  'product_captured',
    properties: { product: productName, show: company.show_name, channel: input.channel },
  });

  return { ok: true, status: 'success', productId: product.id, productName, description: productDesc, imageUrl };
}

// ── Product details: structured fields + free-text parse ─────────────────────

export interface ProductDetailsInput {
  productId:  string;
  buyerId:    string;
  price?:     string;
  moq?:       string;
  leadTime?:  string;
  tone?:      string;
  notes?:     string;       // appended (cumulative); blank = no change
}

export interface ProductDetailsResult {
  ok:     boolean;
  status: 'success' | 'no_product' | 'error';
  error?: string;
}

// Update an existing product's details. Mirrors sourcebot.ts:applyProductDetails.
export async function updateProductDetails(input: ProductDetailsInput, env: Env): Promise<ProductDetailsResult> {
  const product = await env.DB.prepare(
    `SELECT p.id, p.company_id, p.sheet_row, p.name, c.buyer_id, c.show_name, c.sheet_row AS company_sheet_row
       FROM sb_products p JOIN sb_companies c ON c.id = p.company_id
      WHERE p.id = ? AND c.buyer_id = ?`
  ).bind(input.productId, input.buyerId).first<{ id: string; company_id: string; sheet_row: number | null; name: string; buyer_id: string; show_name: string; company_sheet_row: number | null }>();
  if (!product) return { ok: false, status: 'no_product' };

  // COALESCE with NULLIF so empty fields don't clobber existing values.
  await env.DB.prepare(
    `UPDATE sb_products
        SET price       = COALESCE(NULLIF(?, ''), price),
            moq         = COALESCE(NULLIF(?, ''), moq),
            lead_time   = COALESCE(NULLIF(?, ''), lead_time),
            description = CASE
              WHEN ? = '' OR ? IS NULL THEN description
              WHEN description IS NULL OR description = '' THEN ?
              ELSE description || char(10) || ?
            END
      WHERE id = ?`
  ).bind(
    input.price ?? '', input.moq ?? '', input.leadTime ?? '',
    input.notes ?? '', input.notes ?? null,
    input.notes ?? '', input.notes ?? '',
    product.id,
  ).run();

  try {
    const tok = await getServiceAccountToken(env);
    const sheet = await env.DB.prepare(
      `SELECT sheet_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
    ).bind(product.buyer_id, product.show_name).first<{ sheet_id: string }>();
    if (sheet?.sheet_id && product.sheet_row) {
      const refreshed = await env.DB.prepare(
        `SELECT description, price, moq, lead_time FROM sb_products WHERE id = ?`
      ).bind(product.id).first<{ description: string | null; price: string | null; moq: string | null; lead_time: string | null }>();
      await updateProductRow(sheet.sheet_id, product.sheet_row, {
        description: refreshed?.description ?? '',
        price:       refreshed?.price       ?? '',
        moq:         refreshed?.moq         ?? '',
        leadTime:    refreshed?.lead_time   ?? '',
        tone:        input.tone             ?? '',
        notes:       input.notes            ?? '',
      }, tok);
    }
  } catch (e) {
    console.error('[sourcebot_core] product details sheet update failed', e);
  }

  return { ok: true, status: 'success' };
}

// Gemini structure-extraction over a free-text reply, mirrors sourcebot.ts:2906.
export async function parseProductDetailsText(text: string, env: Env): Promise<{ price: string; moq: string; lead_time: string; tone: string }> {
  const prompt =
    `Read the following note a buyer wrote about a supplier at a trade show. ` +
    `Pull out: price, minimum order quantity (MOQ), lead time, and overall tone. ` +
    `Return ONLY JSON with these fields:\n` +
    `- price (NORMALIZED to standard money format with currency symbol and decimals — e.g. "$5.20" not "$5 and 20 cents", "€12.50" not "twelve fifty euros". Empty if not mentioned.)\n` +
    `- moq (number with units, e.g. "5,000 pcs", "1 pallet". Empty if not mentioned.)\n` +
    `- lead_time (e.g. "30 days", "4 weeks". Empty if not mentioned.)\n` +
    `- tone (one of: positive, neutral, negative, enthusiastic, skeptical; empty if unclear)\n\n` +
    `NOTE:\n${text}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  if (!data.candidates?.length) return { price: '', moq: '', lead_time: '', tone: '' };
  const raw = data.candidates[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as Partial<{ price: string; moq: string; lead_time: string; tone: string }>;
  return {
    price:     parsed.price     ?? '',
    moq:       parsed.moq       ?? '',
    lead_time: parsed.lead_time ?? '',
    tone:      parsed.tone      ?? '',
  };
}

// Card-vs-product classifier — copy of sourcebot.ts:2977.
async function classifyProductImage(base64: string, mimeType: string, env: Env): Promise<{ type: 'business_card' | 'product'; name: string; description: string }> {
  const prompt =
    `You are looking at a photo a sourcing buyer just took at a trade show. ` +
    `Decide which kind of photo it is: ` +
    `(a) "business_card" — a printed business/contact card (rectangular card, contact details, company logo with email/phone). ` +
    `(b) "product" — a physical product, SKU, sample, or packaging on a booth. ` +
    `Return ONLY JSON: {type: "business_card" | "product", name: string, description: string}. ` +
    `If type is "product", name = short product name (1-6 words), description = one-line description. ` +
    `If type is "business_card", set name and description to empty strings. ` +
    `When unsure between the two, prefer "business_card" only when the photo clearly shows a small rectangular card with multiple lines of contact-like text.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  if (!data.candidates?.length) return { type: 'product', name: '', description: '' };
  const raw = data.candidates[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as { type?: string; name?: string; description?: string };
  const type = parsed.type === 'business_card' ? 'business_card' : 'product';
  return { type, name: parsed.name ?? '', description: parsed.description ?? '' };
}

// ── Resolve buyer helper (for callers that only have user_id) ────────────────

export async function resolveBuyerForUser(userId: string, env: Env): Promise<{ buyerId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id AS buyer_id FROM sb_buyers WHERE user_id = ? LIMIT 1`
  ).bind(userId).first<{ buyer_id: string }>();
  return row ? { buyerId: row.buyer_id } : null;
}

// ── Reply abstraction (mirrors capture.ts ReplyTarget) ───────────────────────

async function sendReply(target: ReplyTarget, text: string, env: Env): Promise<void> {
  if (target.channel === 'whatsapp') {
    // Lazy import so this module stays usable in contexts where WhatsApp is disabled.
    const { sendWhatsAppText } = await import('./whatsapp');
    try { await sendWhatsAppText(target.phone, text, env); }
    catch (e) { console.error('[sourcebot_core] whatsapp reply failed', e); }
  }
  // 'web' and 'none' → no-op. Web caller renders its own preview.
}

// ── Duplicated SourceBot helpers (keep in lockstep with sourcebot.ts) ────────

// getActivePass — copy of sourcebot.ts:1373.
async function getActivePass(buyerId: string, env: Env): Promise<ActivePass | null> {
  const buyerRow = await env.DB.prepare(
    `SELECT current_show_id FROM sb_buyers WHERE id = ?`
  ).bind(buyerId).first<{ current_show_id: string | null }>();

  if (buyerRow?.current_show_id) {
    const r = await env.DB.prepare(
      `SELECT id, show_name, status, duration_days, first_scan_at, free_window_ends_at,
              free_scans_limit, free_scans_used, paid_plan, sheet_id, sheet_url, drive_folder_id
         FROM sb_buyer_shows WHERE id = ?`
    ).bind(buyerRow.current_show_id).first<ActivePass>();
    if (r) return r;
  }
  return env.DB.prepare(
    `SELECT id, show_name, status, duration_days, first_scan_at, free_window_ends_at,
            free_scans_limit, free_scans_used, paid_plan, sheet_id, sheet_url, drive_folder_id
       FROM sb_buyer_shows
      WHERE buyer_id = ? AND status IN ('active','grace')
      ORDER BY created_at DESC LIMIT 1`
  ).bind(buyerId).first<ActivePass>();
}

// checkAndConsumeScan — copy of sourcebot.ts:1399.
// Returns { allowed: true } or { allowed: false, reason }.
interface ScanCheck { allowed: boolean; reason?: string }
async function checkAndConsumeScan(pass: ActivePass, env: Env): Promise<ScanCheck> {
  const now = Math.floor(Date.now() / 1000);

  if (pass.paid_plan) {
    await env.DB.prepare(
      `UPDATE sb_buyer_shows SET total_captures = total_captures + 1, last_capture_at = ? WHERE id = ?`
    ).bind(now, pass.id).run();
    return { allowed: true };
  }

  if (!pass.first_scan_at) {
    const isShortShow = pass.duration_days === 2;
    const windowEnd = isShortShow ? null : now + 24 * 3600;
    const limit     = isShortShow ? 10   : null;
    await env.DB.prepare(
      `UPDATE sb_buyer_shows
          SET first_scan_at = ?, free_window_ends_at = ?, free_scans_limit = ?,
              free_scans_used = 1, total_captures = total_captures + 1, last_capture_at = ?
        WHERE id = ?`
    ).bind(now, windowEnd, limit, now, pass.id).run();

    const buyerRow = await env.DB.prepare(
      `SELECT b.id AS buyer_id FROM sb_buyers b JOIN sb_buyer_shows s ON s.buyer_id = b.id WHERE s.id = ?`
    ).bind(pass.id).first<{ buyer_id: string }>();
    if (buyerRow) {
      await scheduleFunnelOnFirstScan({
        buyerId:      buyerRow.buyer_id,
        showId:       pass.id,
        firstScanAt:  now,
        durationDays: pass.duration_days,
      }, env);
      await trackEvent(env, {
        buyerId:    buyerRow.buyer_id,
        showId:     pass.id,
        eventName:  'show_first_scan',
        properties: { duration_days: pass.duration_days },
      });
    }
    return { allowed: true };
  }

  if (pass.free_window_ends_at && now > pass.free_window_ends_at) {
    return {
      allowed: false,
      reason:  `🆓 Your 24h free window for *${pass.show_name}* ended. Upgrade for unlimited scans + post-show retargeting.`,
    };
  }
  if (pass.free_scans_limit !== null && pass.free_scans_used >= pass.free_scans_limit) {
    return {
      allowed: false,
      reason:  `🆓 You've used all ${pass.free_scans_limit} free scans for *${pass.show_name}*. Upgrade for unlimited.`,
    };
  }

  await env.DB.prepare(
    `UPDATE sb_buyer_shows
        SET free_scans_used = free_scans_used + 1,
            total_captures  = total_captures + 1,
            last_capture_at = ?
      WHERE id = ?`
  ).bind(now, pass.id).run();
  return { allowed: true };
}

// getOrCreateSupplierFolders — copy of sourcebot.ts:2735.
async function getOrCreateSupplierFolders(
  companyId:    string,
  companyName:  string,
  showFolderId: string,
  env:          Env,
  prefetchedToken?: string,
): Promise<SupplierFolders> {
  const row = await env.DB.prepare(
    `SELECT cards_folder_id, cards_subfolder_id, products_subfolder_id FROM sb_companies WHERE id = ?`
  ).bind(companyId).first<{ cards_folder_id: string | null; cards_subfolder_id: string | null; products_subfolder_id: string | null }>();

  let parent   = row?.cards_folder_id     ?? '';
  let cards    = row?.cards_subfolder_id  ?? '';
  let products = row?.products_subfolder_id ?? '';

  const tok = prefetchedToken ?? await getServiceAccountToken(env);

  if (!parent) {
    const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const folder = await createDriveFolder(`${companyName} — ${month}`, showFolderId, tok);
    parent = folder.id;
  }
  if (!cards)    { const f = await createDriveFolder('Cards',    parent, tok); cards    = f.id; }
  if (!products) { const f = await createDriveFolder('Products', parent, tok); products = f.id; }

  await env.DB.prepare(
    `UPDATE sb_companies SET cards_folder_id = ?, cards_subfolder_id = ?, products_subfolder_id = ? WHERE id = ?`
  ).bind(parent, cards, products, companyId).run();

  return { parent, cards, products };
}

// getSupplierFoldersById — copy of sourcebot.ts:2776. Resolves the per-supplier
// folder hierarchy (creates it lazily if the buyer's show folder exists but
// the supplier hierarchy hasn't been populated yet — e.g. card was captured
// pre-folder-rollout).
async function getSupplierFoldersById(
  companyId: string,
  env:       Env,
  showName:  string,
  buyer:     { buyerId: string },
  prefetchedToken?: string,
): Promise<SupplierFolders | undefined> {
  const c = await env.DB.prepare(
    `SELECT name, cards_folder_id, cards_subfolder_id, products_subfolder_id FROM sb_companies WHERE id = ?`
  ).bind(companyId).first<{ name: string; cards_folder_id: string | null; cards_subfolder_id: string | null; products_subfolder_id: string | null }>();
  if (!c?.name) return undefined;

  if (c.cards_folder_id && c.cards_subfolder_id && c.products_subfolder_id) {
    return { parent: c.cards_folder_id, cards: c.cards_subfolder_id, products: c.products_subfolder_id };
  }

  const pass = await env.DB.prepare(
    `SELECT drive_folder_id FROM sb_buyer_shows WHERE buyer_id = ? AND show_name = ?`
  ).bind(buyer.buyerId, showName).first<{ drive_folder_id: string | null }>();
  if (!pass?.drive_folder_id) return undefined;

  return getOrCreateSupplierFolders(companyId, c.name, pass.drive_folder_id, env, prefetchedToken);
}

// uploadCardImage — copy of sourcebot.ts:3021.
async function uploadCardImage(
  buffer: ArrayBuffer,
  contactName:    string,
  company:        string,
  parentFolderId: string,
  token:          string,
): Promise<string> {
  const safe = (s: string) => s.replace(/[^a-z0-9]/gi, '_').slice(0, 60);
  const fileName = `${safe(contactName) || 'card'}${company ? `_${safe(company)}` : ''}.jpg`;

  const boundary = `----dagama_${crypto.randomUUID()}`;
  const meta = JSON.stringify({ name: fileName, mimeType: 'image/jpeg', parents: [parentFolderId] });

  const enc = new TextEncoder();
  const preamble = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  const epilogue = enc.encode(`\r\n--${boundary}--`);
  const bytes = new Uint8Array(buffer);
  const body = new Uint8Array(preamble.length + bytes.length + epilogue.length);
  body.set(preamble, 0);
  body.set(bytes, preamble.length);
  body.set(epilogue, preamble.length + bytes.length);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: body.buffer,
    },
  );
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { id?: string };
  if (!data.id) throw new Error('Drive upload returned no id');

  // Public-readable so =IMAGE() works inside the buyer's sheet.
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions?supportsAllDrives=true`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  return `https://lh3.googleusercontent.com/d/${data.id}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunk) as unknown as number[]));
  }
  return btoa(binary);
}

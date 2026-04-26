/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { ocrThenExtract, type ExtractedContact, type CardBbox } from './extract';
import { getOrCreateSheet, appendLeadRow } from './sheets';
import { getServiceAccountToken } from './google';
import { sendWhatsAppText } from './whatsapp';

// ─────────────────────────────────────────────────────────────────────────────
// Channel-agnostic capture pipeline (Phase A2).
//
// Mirrors the two-phase flow in src/queue.ts (BoothBot's queue worker), but is
// callable directly from any channel that can produce R2 bytes — WhatsApp
// inbound media and the web upload endpoint, today. Telegram still uses its
// own pipeline (telegram.ts → CARD_QUEUE → queue.ts) untouched in this phase
// so the live capture flow stays exactly as it is.
//
// Out of scope here: SourceBot suppliers (multi-step session, multiple sheet
// tabs, voice notes) — that lives in a separate handler once the WhatsApp side
// of SourceBot is wired. BoothBot alone covers the v1 web + WA flip-the-switch
// cases.
// ─────────────────────────────────────────────────────────────────────────────

// Public route on this worker that streams an R2 object as a plain HTTP
// response. cf.image transforms only operate on URLs, so we need this to run
// the scale-down + crop pipeline on bytes that live in R2.
function r2PublicUrl(env: Env, key: string): string {
  // ORIGIN points at api.heydagama.com in production and localhost:8788 in dev.
  // The /_r2/<key> route in src/index.ts is wired in both.
  const base = env.ORIGIN.replace(/\/$/, '');
  return `${base}/_r2/${encodeURIComponent(key)}`;
}

// ── Active-show resolution ───────────────────────────────────────────────────
// Telegram tracks the user's "current show" in session state. WhatsApp + web
// don't have an interactive session yet, so we resolve the show by:
//   1. The most-recently-active row in buyer_shows for this user, then
//   2. The user's most recently created google_sheets entry (set at onboarding).
// Returns null if neither exists — caller should prompt the user.
export async function resolveActiveShow(userId: string, env: Env): Promise<string | null> {
  const active = await env.DB.prepare(
    `SELECT show_name FROM buyer_shows
       WHERE user_id = ? AND status = 'active'
       ORDER BY COALESCE(first_scan_at, 0) DESC, created_at DESC
       LIMIT 1`
  ).bind(userId).first<{ show_name: string }>();
  if (active?.show_name) return active.show_name;

  const sheet = await env.DB.prepare(
    `SELECT show_name FROM google_sheets
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
  ).bind(userId).first<{ show_name: string }>();
  return sheet?.show_name ?? null;
}

// ── Reply abstraction ────────────────────────────────────────────────────────

export type ReplyTarget =
  | { channel: 'whatsapp'; phone: string }
  | { channel: 'web' }                              // web reads the structured result from the response body
  | { channel: 'none' };                            // suppress reply (back-fills, admin re-runs)

export async function sendChannelReply(target: ReplyTarget, text: string, env: Env): Promise<void> {
  if (target.channel === 'whatsapp') {
    await sendWhatsAppText(target.phone, text, env);
    return;
  }
  // 'web' and 'none' are no-ops here — web caller gets the result via the JSON response.
}

// ── Capture types ────────────────────────────────────────────────────────────

export type MediaRef =
  | { kind: 'r2_key'; key: string; mimeType?: string }
  | { kind: 'bytes'; bytes: Uint8Array; mimeType: string; filename?: string };

export interface CardCaptureInput {
  userId:    string;                                 // resolved by caller (already authenticated)
  showName:  string;                                 // active show
  botRole:   'boothbot';                             // 'sourcebot' | 'demobot' will land in follow-ups
  channel:   'whatsapp' | 'web';
  media:     MediaRef;
  caption?:  string;                                 // optional text accompanying the card
  reply:     ReplyTarget;
}

export interface CardCaptureResult {
  ok:        boolean;
  leadId?:   string;                                 // leads.id
  rowIndex?: number;                                 // 1-based sheet row
  contact?:  ExtractedContact;
  sheetUrl?: string;
  status:    'extraction_done' | 'complete' | 'image_failed' | 'error';
  error?:    string;
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function handleCardCapture(input: CardCaptureInput, env: Env): Promise<CardCaptureResult> {
  let r2Key: string;
  let mimeType: string;

  // 1. Make sure bytes live in R2 (cf.image needs a URL it can fetch).
  try {
    if (input.media.kind === 'r2_key') {
      r2Key    = input.media.key;
      mimeType = input.media.mimeType ?? 'image/jpeg';
    } else {
      const ext = mimeToExt(input.media.mimeType);
      r2Key    = `web-uploads/${input.userId}/${crypto.randomUUID()}${ext ? '.' + ext : ''}`;
      mimeType = input.media.mimeType;
      await env.R2_BUCKET.put(r2Key, input.media.bytes, {
        httpMetadata: { contentType: mimeType },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[capture] R2 put failed', { userId: input.userId, error: msg });
    return { ok: false, status: 'error', error: 'storage_failed' };
  }

  const r2Url = r2PublicUrl(env, r2Key);

  // 2. Phase 1 — extraction + DB insert + user reply (must complete).
  let phase1: Phase1Result;
  try {
    phase1 = await runPhase1(input, r2Url, r2Key, mimeType, env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[capture][phase1] failed', { userId: input.userId, error: msg });
    return { ok: false, status: 'error', error: msg };
  }

  // 3. Phase 2 — best-effort Drive upload + Sheet append. Failures are non-fatal.
  const phase2 = await runPhase2(input, r2Url, r2Key, phase1, env);

  return {
    ok:        true,
    leadId:    phase1.leadId,
    rowIndex:  phase2.rowIndex,
    contact:   phase1.contact,
    sheetUrl:  phase2.sheetUrl,
    status:    phase2.status,
    error:     phase2.error,
  };
}

// ── Phase 1: extract + DB insert + reply ─────────────────────────────────────

interface Phase1Result {
  leadId:          string;
  contact:         ExtractedContact;
  optimizedBuffer: ArrayBuffer;
  cardBbox:        CardBbox | null;
  rotation:        0 | 90 | 180 | 270;
}

async function runPhase1(
  input:  CardCaptureInput,
  r2Url:  string,
  r2Key:  string,
  _mimeType: string,
  env:    Env,
): Promise<Phase1Result> {
  // Scale down to a Gemini-friendly size before extraction. Falls back to the
  // raw R2 object if cf.image isn't available (local dev hitting the worker
  // origin without the bound zone).
  let optimizedBuffer: ArrayBuffer;
  const imgRes = await fetch(r2Url, {
    cf: {
      image: {
        metadata: 'none',
        fit: 'scale-down',
        width: 2048,
        format: 'webp',
        quality: 90,
      },
    } as RequestInitCfProperties,
  });
  if (imgRes.ok) {
    optimizedBuffer = await imgRes.arrayBuffer();
  } else {
    console.warn(`[capture][phase1] cf.image scale-down failed status=${imgRes.status} — using raw bytes`);
    const obj = await env.R2_BUCKET.get(r2Key);
    if (!obj) throw new Error(`R2 object missing: ${r2Key}`);
    optimizedBuffer = await obj.arrayBuffer();
  }

  const optimizedBase64 = arrayBufferToBase64(optimizedBuffer);
  const result = await ocrThenExtract(optimizedBase64, 'image/webp', env);
  const contact = result.contact;

  // Insert leads row keyed by user_id (channel-agnostic). chat_id stays NULL
  // for non-Telegram captures; the existing Telegram queue path keeps writing
  // chat_id, so the column remains optional.
  const inserted = await env.DB.prepare(`
    INSERT INTO leads (
      chat_id, show_name, name, company, email, phone, title,
      website, linkedin, address, country, status
    ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extraction_done')
    RETURNING id
  `).bind(
    input.showName,
    contact.name || 'Unknown',
    contact.company || null,
    contact.email   || null,
    contact.phone   || null,
    contact.title   || null,
    contact.website || null,
    contact.linkedin|| null,
    contact.address || null,
    contact.country || null,
  ).first<{ id: string }>();

  if (!inserted?.id) throw new Error('lead insert returned no id');
  const leadId = inserted.id;

  // Send the user-facing confirmation. For web this is a no-op; the caller
  // gets the structured result back and renders the preview itself.
  const replyText =
    `✅ Saved!\n\n` +
    `*${contact.name || 'Unknown'}*` +
    (contact.title   ? `\n${contact.title}`   : '') +
    (contact.company ? `\n${contact.company}` : '') +
    (contact.email   ? `\n📧 ${contact.email}` : '') +
    (contact.phone   ? `\n📞 ${contact.phone}` : '');
  try { await sendChannelReply(input.reply, replyText, env); }
  catch (e) { console.error('[capture][phase1] reply failed', e); /* non-fatal */ }

  return {
    leadId,
    contact,
    optimizedBuffer,
    cardBbox: result.cardBbox,
    rotation: result.rotation,
  };
}

// ── Phase 2: crop + Drive upload + Sheet append ──────────────────────────────

async function runPhase2(
  input:  CardCaptureInput,
  r2Url:  string,
  r2Key:  string,
  phase1: Phase1Result,
  env:    Env,
): Promise<{ rowIndex?: number; sheetUrl?: string; status: 'complete' | 'image_failed'; error?: string }> {
  try {
    const token = await getServiceAccountToken(env);

    // Resolve the user's sheet for this show (creates one if missing).
    const { sheetId, sheetUrl } = await getOrCreateSheet(input.userId, input.showName, token, env);

    // Crop using the bbox from the Phase 1 Gemini call. Same logic as queue.ts
    // — kept here so the channel-agnostic path doesn't depend on Telegram-side
    // assumptions (chat_id, sheet lookup via bot_users, etc).
    let finalBuffer: ArrayBuffer = phase1.optimizedBuffer;
    const bbox = phase1.cardBbox;
    if (bbox && bbox.width > 0 && bbox.height > 0) {
      let origW = 3000, origH = 2000;
      try {
        const metaRes = await fetch(r2Url, { cf: { image: { format: 'json' } } as RequestInitCfProperties });
        if (metaRes.ok) {
          const meta = await metaRes.json() as { original?: { width?: number; height?: number }; width?: number; height?: number };
          const w = meta.original?.width ?? meta.width;
          const h = meta.original?.height ?? meta.height;
          if (w && h && w > 0 && h > 0) { origW = w; origH = h; }
        }
      } catch { /* fall through to defaults */ }

      const trim = {
        left:   Math.max(0, Math.floor((bbox.left   / 100) * origW)),
        top:    Math.max(0, Math.floor((bbox.top    / 100) * origH)),
        right:  Math.max(0, Math.floor(((100 - bbox.left - bbox.width)  / 100) * origW)),
        bottom: Math.max(0, Math.floor(((100 - bbox.top  - bbox.height) / 100) * origH)),
      };
      const imageOps: Record<string, unknown> = {
        metadata: 'none',
        trim,
        fit: 'contain',
        width: 1600,
        height: 1600,
        sharpen: 2,
        format: 'webp',
        quality: 95,
      };
      if (phase1.rotation) imageOps.rotate = phase1.rotation;
      const cropRes = await fetch(r2Url, { cf: { image: imageOps } as RequestInitCfProperties });
      if (cropRes.ok) finalBuffer = await cropRes.arrayBuffer();
      else console.warn(`[capture][phase2] crop fetch failed status=${cropRes.status} — using optimized`);
    }

    // Upload the cropped card to Drive (in the per-show folder).
    const fileName = `${(phase1.contact.name || 'card').replace(/[^a-z0-9]/gi, '_')}.webp`;
    const driveFileId = await uploadToDriveSimple(fileName, finalBuffer, token);
    const driveFileUrl = `https://lh3.googleusercontent.com/d/${driveFileId}`;

    // Append the row using the shared sheets.appendLeadRow helper so column
    // layout stays in lockstep with telegram.ts/queue.ts.
    const { rowIndex } = await appendLeadRow(sheetId, {
      timestamp:    new Date().toISOString(),
      showName:     input.showName,
      name:         phase1.contact.name || 'Unknown',
      title:        phase1.contact.title,
      company:      phase1.contact.company,
      email:        phase1.contact.email,
      phone:        phase1.contact.phone,
      country:      phase1.contact.country,
      website:      phase1.contact.website,
      linkedin:     phase1.contact.linkedin,
      address:      phase1.contact.address,
      notes:        input.caption ?? '',
      cardPhotoUrl: driveFileUrl,
    }, token, env);

    // Mark the lead complete + record the sheet row.
    await env.DB.prepare(
      `UPDATE leads SET sheet_row = ?, status = 'complete' WHERE id = ?`
    ).bind(rowIndex, phase1.leadId).run();

    // Best-effort R2 cleanup. Web/WA don't need the original after Drive upload.
    env.R2_BUCKET.delete(r2Key).catch(e => console.error('[capture][phase2] R2 delete failed:', e));

    return { rowIndex, sheetUrl, status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[capture][phase2] failed', { leadId: phase1.leadId, error: msg });
    await env.DB.prepare(
      `UPDATE leads SET status = 'image_failed' WHERE id = ?`
    ).bind(phase1.leadId).run().catch(() => { /* swallow — lead row exists with extraction data */ });
    return { status: 'image_failed', error: msg };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Drive upload — same multipart/related shape as queue.ts uploadToDrive but
// without the Telegram-side dependencies. Could fold into sheets.ts later.
async function uploadToDriveSimple(fileName: string, imageBuffer: ArrayBuffer, token: string): Promise<string> {
  const boundary = '--------dagama_boundary';
  const metadata = JSON.stringify({ name: fileName, mimeType: 'image/webp' });
  const encoder = new TextEncoder();
  const preamble = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: image/webp\r\n\r\n`,
  );
  const epilogue = encoder.encode(`\r\n--${boundary}--`);
  const imageBytes = new Uint8Array(imageBuffer);
  const body = new Uint8Array(preamble.length + imageBytes.length + epilogue.length);
  body.set(preamble, 0);
  body.set(imageBytes, preamble.length);
  body.set(epilogue, preamble.length + imageBytes.length);

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

  // Public-readable so =IMAGE() works in the Sheet.
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions?supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  return data.id;
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

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png':  return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    default: return '';
  }
}

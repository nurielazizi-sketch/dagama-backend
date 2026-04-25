/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { ocrThenExtract } from './extract';

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const SHEETS_API       = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES    = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';

export interface ProcessCardJob {
  jobId: string;
  showName: string;
  chatId: number;
  messageId: number;
  jobType: 'process_card';
  payload: {
    r2Key: string;
    telegramFileId: string;
  };
  createdAt: number;
  attempts: number;
  status: 'pending';
}

interface CardBbox { left: number; top: number; width: number; height: number }

interface ExtractedContact {
  name: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  address: string | null;
  country: string | null;
  cardBbox: CardBbox | null;
  cardRotation: 0 | 90 | 180 | 270;
}

// ─────────────────────────────────────────────────────────────────────────────
// handleProcessCard — two-phase pipeline:
//   Phase 1 (user-facing, must complete): Gemini extract → D1 insert
//                                         (status='extraction_done') → Telegram reply.
//   Phase 2 (non-fatal, best-effort):     bbox crop → Drive upload → Sheet row
//                                         → D1 update (status='complete' or
//                                         'image_failed') → R2 delete.
//
// The bbox comes from the same Gemini call as the contact extraction — we never
// make a separate Gemini request just for the bounding box.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleProcessCard(job: ProcessCardJob, env: Env): Promise<void> {
  const token = await getServiceAccountToken(env);

  // The /_r2/<key> route in src/index.ts serves raw R2 bytes via HTTP with no
  // transformation — required because cf.image only operates on fetch() responses.
  // If that route is ever removed or returns an error, we fall back to reading
  // the binding directly (which yields raw, uncropped bytes).
  const r2Url = `https://api.heydagama.com/_r2/${job.payload.r2Key}`;

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 1 — extraction + Telegram reply
  // ═════════════════════════════════════════════════════════════════════════

  // Step 1: Cloudflare basic transform (scale-down optimization for Gemini)
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
    // Fallback: read raw bytes from binding (uncropped, unoptimized)
    console.error(`[phase1] _r2 fetch failed status=${imgRes.status} — using binding`);
    const r2Obj = await env.R2_BUCKET.get(job.payload.r2Key);
    if (!r2Obj) throw new Error(`R2 object not found: ${job.payload.r2Key}`);
    optimizedBuffer = await r2Obj.arrayBuffer();
  }
  const optimizedBase64 = arrayBufferToBase64(optimizedBuffer);

  // Step 2: Single Gemini call returning contact fields + cardBbox
  const extracted = await extractContactFieldsAndBbox(optimizedBase64, env);

  // Step 3: Resolve user's linked Google Sheet
  const botUser = await env.DB.prepare(
    `SELECT user_id FROM bot_users WHERE chat_id = ?`
  ).bind(job.chatId).first<{ user_id: string | null }>();
  if (!botUser?.user_id) throw new Error(`No user_id linked for chat_id ${job.chatId}`);

  const sheet = await env.DB.prepare(
    `SELECT sheet_id FROM google_sheets WHERE user_id = ? AND show_name = ?`
  ).bind(botUser.user_id, job.showName).first<{ sheet_id: string }>();
  if (!sheet?.sheet_id) throw new Error(`No sheet for user ${botUser.user_id} show ${job.showName}`);

  // Step 4: Insert lead row into D1 with status='extraction_done' (no sheet_row yet)
  const leadRow = await env.DB.prepare(`
    INSERT INTO leads (
      chat_id, show_name, name, company, email, phone, title,
      website, linkedin, address, country, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extraction_done')
    RETURNING id
  `).bind(
    job.chatId,
    job.showName,
    extracted.name || 'Unknown',
    extracted.company || null,
    extracted.email || null,
    extracted.phone || null,
    extracted.title || null,
    extracted.website || null,
    extracted.linkedin || null,
    extracted.address || null,
    extracted.country || null,
  ).first<{ id: string }>();
  const leadId = leadRow?.id;

  // Step 5: Send Telegram confirmation BEFORE image processing starts
  const replyText =
    `✅ Saved!\n\n` +
    `*${extracted.name || 'Unknown'}*` +
    (extracted.title   ? `\n${extracted.title}`   : '') +
    (extracted.company ? `\n${extracted.company}` : '') +
    (extracted.email   ? `\n📧 ${extracted.email}` : '') +
    (extracted.phone   ? `\n📞 ${extracted.phone}` : '');
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: job.chatId, parse_mode: 'Markdown', text: replyText }),
  });

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 2 — cropping + Drive + Sheet (non-fatal; never retry the whole job)
  // ═════════════════════════════════════════════════════════════════════════
  try {
    // Reuse the cardBbox from the Phase 1 extraction call — no second Gemini request.
    let finalBuffer: ArrayBuffer = optimizedBuffer;
    const bbox = extracted.cardBbox;

    if (bbox && bbox.width > 0 && bbox.height > 0) {
      console.log(`Card bbox detected: ${JSON.stringify(bbox)}`);
      // Fallback to 3000x2000 if dimension lookup fails — a safe default for
      // typical phone camera photos in landscape. Prevents the crop from failing
      // entirely just because cf.image format=json couldn't parse the image.
      let origW = 3000, origH = 2000;
      try {
        const metaRes = await fetch(r2Url, { cf: { image: { format: 'json' } } as RequestInitCfProperties });
        if (metaRes.ok) {
          const meta = await metaRes.json() as { original?: { width?: number; height?: number }; width?: number; height?: number };
          const w = meta.original?.width ?? meta.width;
          const h = meta.original?.height ?? meta.height;
          if (w && h && w > 0 && h > 0) { origW = w; origH = h; }
          else console.log(`[phase2] dims returned null — using fallback ${origW}x${origH}`);
        } else {
          console.log(`[phase2] dims lookup status=${metaRes.status} — using fallback ${origW}x${origH}`);
        }
      } catch (e) {
        console.error(`[phase2] dims lookup threw — using fallback ${origW}x${origH}:`, e);
      }

      const trim = {
        left:   Math.max(0, Math.floor((bbox.left   / 100) * origW)),
        top:    Math.max(0, Math.floor((bbox.top    / 100) * origH)),
        right:  Math.max(0, Math.floor(((100 - bbox.left - bbox.width)  / 100) * origW)),
        bottom: Math.max(0, Math.floor(((100 - bbox.top  - bbox.height) / 100) * origH)),
      };
      // CF order: trim → rotate → fit/scale. So `trim` coords remain in original
      // image space; `rotate` straightens the card after cropping.
      // fit: 'contain' upscales small crops (card region is often only a small
      // portion of a Telegram-compressed 1280x source). Stronger sharpen compensates.
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
      if (extracted.cardRotation) imageOps.rotate = extracted.cardRotation;
      const cropRes = await fetch(r2Url, { cf: { image: imageOps } as RequestInitCfProperties });
      if (cropRes.ok) {
        finalBuffer = await cropRes.arrayBuffer();
        console.log(`[phase2] trim ok orig=${origW}x${origH} trim=${JSON.stringify(trim)} rotate=${extracted.cardRotation}`);
      } else {
        console.error(`[phase2] trim fetch failed status=${cropRes.status} — using optimized`);
      }
    } else {
      console.log('Card bbox not detected, using full image');
    }

    // Drive upload
    const fileName = `${(extracted.name || 'card').replace(/[^a-z0-9]/gi, '_')}.webp`;
    const driveFileId = await uploadToDrive(fileName, finalBuffer, token);
    const driveFileUrl = `https://lh3.googleusercontent.com/d/${driveFileId}`;

    // Sheet append
    const row = [
      new Date().toISOString(),
      job.showName,
      extracted.company || '',
      extracted.name || 'Unknown',
      extracted.title || '',
      extracted.email || '',
      extracted.phone || '',
      extracted.country || '',
      extracted.website || '',
      extracted.linkedin || '',
      extracted.address || '',
      '',                            // notes
      '', '', '', '',                // email status cols
      new Date().toISOString(),      // Last Updated
      driveFileUrl,                  // R: Card Photo URL
      '',                            // S: IMAGE formula (written below)
    ];
    const appendRes = await fetch(
      `${SHEETS_API}/${sheet.sheet_id}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] }),
      },
    );
    const appendData = await appendRes.json() as { updates?: { updatedRange?: string } };
    const updatedRange = appendData.updates?.updatedRange ?? '';
    const rowMatch = updatedRange.match(/![A-Z]+(\d+):/);
    const rowIndex = rowMatch ? parseInt(rowMatch[1], 10) : 2;

    // Write =IMAGE() formula to column S
    await fetch(
      `${SHEETS_API}/${sheet.sheet_id}/values/S${rowIndex}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: `S${rowIndex}`, values: [[`=IMAGE(R${rowIndex})`]] }),
      },
    );

    // Update D1: mark complete + store sheet_row
    if (leadId) {
      await env.DB.prepare(
        `UPDATE leads SET sheet_row = ?, status = 'complete' WHERE id = ?`
      ).bind(rowIndex, leadId).run();
    }

    // R2 cleanup
    env.R2_BUCKET.delete(job.payload.r2Key).catch(e => console.error('[phase2] R2 delete failed:', e));
  } catch (e) {
    // Phase 2 failures are non-fatal — log and mark the lead so it can be retried later.
    console.error('[phase2] image processing failed:', e);
    if (leadId) {
      await env.DB.prepare(
        `UPDATE leads SET status = 'image_failed' WHERE id = ?`
      ).bind(leadId).run().catch(err => console.error('[phase2] status update failed:', err));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Thin shim over the shared OCR + Gemini pipeline in src/extract.ts.
// Returns the queue-local ExtractedContact shape (nullable strings + bbox + rotation).
// ─────────────────────────────────────────────────────────────────────────────
async function extractContactFieldsAndBbox(base64: string, env: Env): Promise<ExtractedContact> {
  // The queue stores the optimized image as image/webp before this is called.
  const result = await ocrThenExtract(base64, 'image/webp', env);
  return {
    name:         result.contact.name     || null,
    title:        result.contact.title    || null,
    company:      result.contact.company  || null,
    email:        result.contact.email    || null,
    phone:        result.contact.phone    || null,
    website:      result.contact.website  || null,
    linkedin:     result.contact.linkedin || null,
    address:      result.contact.address  || null,
    country:      result.contact.country  || null,
    cardBbox:     result.cardBbox,
    cardRotation: result.rotation,
  };
}


// ── Google service account helpers ────────────────────────────────────────────

async function getServiceAccountToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: GOOGLE_SCOPES, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 };

  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = btoa(JSON.stringify(claim)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
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

  const encoder = new TextEncoder();
  const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, encoder.encode(signingInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
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

async function uploadToDrive(fileName: string, imageBuffer: ArrayBuffer, token: string): Promise<string> {
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

  const res = await fetch(DRIVE_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: body.buffer,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { id?: string };
  if (!data.id) throw new Error('Drive upload returned no file ID');

  // Make publicly readable so =IMAGE() works in Sheets
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  return data.id;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
  }
  return btoa(binary);
}

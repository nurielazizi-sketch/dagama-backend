/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { requireAuth } from './auth';
import { handleCardCapture, resolveActiveShow } from './capture';
import {
  captureSupplierFromPhoto,
  resolveBuyerForUser,
  attachCardBack,
  attachPersonPhoto,
  attachVoiceNote,
  attachProductFromPhoto,
  updateProductDetails,
  draftSupplierEmail,
  sendSupplierEmail,
  blastSuppliers,
  findAcrossSupplierData,
  compareProducts,
  exportSupplierPdf,
  exportShowPdf,
} from './sourcebot_core';

// ─────────────────────────────────────────────────────────────────────────────
// Web capture endpoints — third channel alongside Telegram + WhatsApp.
//
// POST /api/upload         multipart upload of one card photo (BoothBot)
// GET  /api/leads          list the authed user's leads (most recent first)
// GET  /api/leads/:id      single lead — used for polling the upload status
// ─────────────────────────────────────────────────────────────────────────────

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;          // 12 MB — covers a phone HEIC

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── POST /api/upload ─────────────────────────────────────────────────────────

export async function handleWebUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  // Accept multipart/form-data with a 'photo' field. Optional 'show' field
  // overrides the user's resolved active show (lets the dashboard switch shows
  // without waiting for a session-state migration).
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data' }, 415);
  }

  let form: FormData;
  try { form = await request.formData(); }
  catch (e) {
    console.error('[web_capture] formData parse failed', e);
    return jsonResponse({ error: 'Invalid multipart body' }, 400);
  }

  // FormData.get returns string | File | null; the Workers types don't expose
  // `File` as a global value, so we duck-type instead of using instanceof.
  const photo = form.get('photo');
  if (photo == null || typeof photo === 'string') {
    return jsonResponse({ error: 'Missing "photo" file field' }, 400);
  }
  const photoBlob = photo as Blob & { name?: string };
  if (photoBlob.size === 0) {
    return jsonResponse({ error: 'Empty file' }, 400);
  }
  if (photoBlob.size > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
  }
  const mimeType = (photoBlob.type || '').toLowerCase();
  if (!mimeType.startsWith('image/')) {
    return jsonResponse({ error: 'Only image uploads accepted' }, 415);
  }

  const bytes = new Uint8Array(await photoBlob.arrayBuffer());
  const notes = (form.get('notes') ?? '').toString() || undefined;

  // Dispatch by bot role. Presence of an sb_buyers row → SourceBot user.
  // Otherwise the user is on BoothBot (the default since BoothBot launch).
  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (buyer) {
    const result = await captureSupplierFromPhoto({
      buyerId: buyer.buyerId,
      channel: 'web',
      media:   { kind: 'bytes', bytes, mimeType },
      caption: notes,
      reply:   { channel: 'web' },
    }, env);
    if (!result.ok) {
      return jsonResponse({
        error:  result.reason ?? result.error ?? 'Capture failed',
        status: result.status,
      }, statusForFailure(result.status));
    }
    return jsonResponse({
      botRole:    'sourcebot',
      companyId:  result.companyId,
      status:     result.status,
      rowIndex:   result.rowIndex,
      sheetUrl:   result.sheetUrl,
      showName:   result.showName,
      contact:    result.contact,
    });
  }

  // BoothBot path (existing).
  const showOverride = (form.get('show') ?? '').toString().trim();
  const resolved     = showOverride || await resolveActiveShow(auth.userId, env);
  if (!resolved) {
    return jsonResponse({ error: 'No active show. Finish onboarding or pass a "show" field.' }, 400);
  }

  const result = await handleCardCapture({
    userId:   auth.userId,
    showName: resolved,
    botRole:  'boothbot',
    channel:  'web',
    media:    { kind: 'bytes', bytes, mimeType, filename: photoBlob.name },
    caption:  notes,
    reply:    { channel: 'web' },
  }, env);

  if (!result.ok) {
    return jsonResponse({ error: result.error ?? 'Capture failed', status: result.status }, 500);
  }

  return jsonResponse({
    botRole:   'boothbot',
    leadId:    result.leadId,
    status:    result.status,
    rowIndex:  result.rowIndex,
    sheetUrl:  result.sheetUrl,
    showName:  resolved,
    contact:   result.contact,
  });
}

// HTTP status mapped from a SupplierCaptureResult.status — keeps the upload
// endpoint honest (e.g. 402-ish for free-tier exhaustion vs 500 for real errors).
function statusForFailure(status: string): number {
  if (status === 'no_active_show')        return 400;
  if (status === 'free_tier_exhausted')   return 402;
  if (status === 'extraction_failed')     return 422;
  if (status === 'sheet_failed')          return 502;
  return 500;
}

// ── GET /api/leads ───────────────────────────────────────────────────────────

export async function handleListLeads(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get('limit'), 25, 1, 100);
  const showFilter = url.searchParams.get('show');

  // Web captures store user_id directly via the Telegram-side bot_users join
  // path. To list both Telegram-captured (chat_id-keyed) and web-captured
  // (chat_id IS NULL) leads for one user, we union across both keys.
  const sql = showFilter
    ? `SELECT l.id, l.show_name, l.name, l.company, l.email, l.phone, l.title, l.country,
              l.website, l.linkedin, l.notes, l.sheet_row, l.status, l.created_at
         FROM leads l
        WHERE (l.chat_id IN (SELECT chat_id FROM bot_users WHERE user_id = ?) OR l.chat_id IS NULL)
          AND l.show_name = ?
        ORDER BY l.created_at DESC
        LIMIT ?`
    : `SELECT l.id, l.show_name, l.name, l.company, l.email, l.phone, l.title, l.country,
              l.website, l.linkedin, l.notes, l.sheet_row, l.status, l.created_at
         FROM leads l
        WHERE (l.chat_id IN (SELECT chat_id FROM bot_users WHERE user_id = ?) OR l.chat_id IS NULL)
        ORDER BY l.created_at DESC
        LIMIT ?`;

  const stmt = showFilter
    ? env.DB.prepare(sql).bind(auth.userId, showFilter, limit)
    : env.DB.prepare(sql).bind(auth.userId, limit);

  const rows = await stmt.all<Record<string, unknown>>();
  return jsonResponse({ leads: rows.results });
}

// ── GET /api/leads/:id ───────────────────────────────────────────────────────
// Single lead, used by the upload UI to poll status until 'complete' (or
// 'image_failed') after the initial /api/upload response.

export async function handleGetLead(request: Request, env: Env, leadId: string): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const lead = await env.DB.prepare(
    `SELECT l.id, l.show_name, l.name, l.company, l.email, l.phone, l.title, l.country,
            l.website, l.linkedin, l.notes, l.sheet_row, l.status, l.created_at, l.chat_id
       FROM leads l
      WHERE l.id = ?
      LIMIT 1`
  ).bind(leadId).first<{
    id: string; show_name: string; name: string | null; company: string | null;
    email: string | null; phone: string | null; title: string | null; country: string | null;
    website: string | null; linkedin: string | null; notes: string | null;
    sheet_row: number | null; status: string; created_at: string; chat_id: number | null;
  }>();

  if (!lead) return jsonResponse({ error: 'Not found' }, 404);

  // Authorization: lead must be captured by this user (chat_id keyed via
  // bot_users) OR it's a web capture (chat_id IS NULL). For the latter we
  // verify the show belongs to a sheet this user owns.
  let owned = false;
  if (lead.chat_id != null) {
    const link = await env.DB.prepare(
      `SELECT 1 AS ok FROM bot_users WHERE chat_id = ? AND user_id = ? LIMIT 1`
    ).bind(lead.chat_id, auth.userId).first<{ ok: number }>();
    owned = !!link?.ok;
  } else {
    const sheet = await env.DB.prepare(
      `SELECT 1 AS ok FROM google_sheets WHERE user_id = ? AND show_name = ? LIMIT 1`
    ).bind(auth.userId, lead.show_name).first<{ ok: number }>();
    owned = !!sheet?.ok;
  }
  if (!owned) return jsonResponse({ error: 'Not found' }, 404);

  // Don't leak chat_id back to the web client.
  const { chat_id: _ignored, ...safe } = lead;
  return jsonResponse({ lead: safe });
}

// ── GET /api/suppliers ───────────────────────────────────────────────────────
// SourceBot equivalent of /api/leads. Returns the authed buyer's most recent
// suppliers (sb_companies), with the latest contact's info denormalised in.

export async function handleListSuppliers(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ suppliers: [], role: 'boothbot' });

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get('limit'), 25, 1, 100);
  const showFilter = url.searchParams.get('show');

  const sql = showFilter
    ? `SELECT c.id, c.name AS company, c.show_name, c.sheet_row, c.cards_folder_id,
              c.created_at,
              (SELECT name  FROM sb_contacts WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS contact_name,
              (SELECT title FROM sb_contacts WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS title,
              (SELECT email FROM sb_contacts WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS email,
              (SELECT phone FROM sb_contacts WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS phone
         FROM sb_companies c
        WHERE c.buyer_id = ? AND c.show_name = ?
        ORDER BY c.created_at DESC
        LIMIT ?`
    : `SELECT c.id, c.name AS company, c.show_name, c.sheet_row, c.cards_folder_id,
              c.created_at,
              (SELECT name  FROM sb_contacts WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS contact_name,
              (SELECT title FROM sb_contacts WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS title,
              (SELECT email FROM sb_contacts WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS email,
              (SELECT phone FROM sb_contacts WHERE company_id = c.id ORDER BY created_at DESC LIMIT 1) AS phone
         FROM sb_companies c
        WHERE c.buyer_id = ?
        ORDER BY c.created_at DESC
        LIMIT ?`;

  const stmt = showFilter
    ? env.DB.prepare(sql).bind(buyer.buyerId, showFilter, limit)
    : env.DB.prepare(sql).bind(buyer.buyerId, limit);

  const rows = await stmt.all<Record<string, unknown>>();
  return jsonResponse({ suppliers: rows.results, role: 'sourcebot' });
}

// ── POST /api/suppliers/:id/card-back  +  /api/suppliers/:id/person-photo ───
// Multipart upload with a single 'photo' field. Authorised via JWT; the
// supplier row's buyer_id must match the buyer linked to this user.

export async function handleSupplierExtension(
  request: Request,
  env:     Env,
  companyId: string,
  kind:    'card_back' | 'person_photo',
): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  const ct = request.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data' }, 415);
  }

  let form: FormData;
  try { form = await request.formData(); }
  catch (e) {
    console.error('[web_capture] extension formData parse failed', e);
    return jsonResponse({ error: 'Invalid multipart body' }, 400);
  }

  const photo = form.get('photo');
  if (photo == null || typeof photo === 'string') {
    return jsonResponse({ error: 'Missing "photo" file field' }, 400);
  }
  const photoBlob = photo as Blob & { name?: string };
  if (photoBlob.size === 0)                       return jsonResponse({ error: 'Empty file' }, 400);
  if (photoBlob.size > MAX_UPLOAD_BYTES)          return jsonResponse({ error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
  const mimeType = (photoBlob.type || '').toLowerCase();
  if (!mimeType.startsWith('image/'))             return jsonResponse({ error: 'Only image uploads accepted' }, 415);

  const bytes = new Uint8Array(await photoBlob.arrayBuffer());
  const fn = kind === 'card_back' ? attachCardBack : attachPersonPhoto;
  const result = await fn({
    companyId,
    buyerId: buyer.buyerId,
    channel: 'web',
    media:   { kind: 'bytes', bytes, mimeType },
    reply:   { channel: 'web' },
  }, env);

  if (!result.ok) {
    return jsonResponse({ error: result.error ?? 'Upload failed', status: result.status }, result.status === 'no_supplier' ? 404 : 500);
  }
  return jsonResponse({
    status:      result.status,
    url:         result.url,
    description: result.description,
  });
}

// ── POST /api/suppliers/:id/voice ────────────────────────────────────────────
// Multipart upload with a single 'audio' field (browser MediaRecorder output —
// typically audio/webm or audio/ogg).

const MAX_VOICE_BYTES = 25 * 1024 * 1024;        // 25 MB — covers ~10min @ 32kbps

export async function handleSupplierVoice(request: Request, env: Env, companyId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  const ct = request.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data' }, 415);
  }

  let form: FormData;
  try { form = await request.formData(); }
  catch (e) {
    console.error('[web_capture] voice formData parse failed', e);
    return jsonResponse({ error: 'Invalid multipart body' }, 400);
  }

  const audio = form.get('audio');
  if (audio == null || typeof audio === 'string') {
    return jsonResponse({ error: 'Missing "audio" file field' }, 400);
  }
  const audioBlob = audio as Blob;
  if (audioBlob.size === 0)              return jsonResponse({ error: 'Empty file' }, 400);
  if (audioBlob.size > MAX_VOICE_BYTES)  return jsonResponse({ error: `File too large (max ${MAX_VOICE_BYTES} bytes)` }, 413);
  const mimeType = (audioBlob.type || 'audio/webm').toLowerCase();
  if (!mimeType.startsWith('audio/'))    return jsonResponse({ error: 'Only audio uploads accepted' }, 415);

  const durationRaw = form.get('duration');
  const durationSec = typeof durationRaw === 'string' ? parseFloat(durationRaw) : NaN;

  const bytes = new Uint8Array(await audioBlob.arrayBuffer());
  const result = await attachVoiceNote({
    companyId,
    buyerId:     buyer.buyerId,
    channel:     'web',
    media:       { kind: 'bytes', bytes, mimeType },
    durationSec: Number.isFinite(durationSec) ? Math.round(durationSec) : undefined,
    reply:       { channel: 'web' },
  }, env);

  if (!result.ok) {
    return jsonResponse({ error: result.error ?? 'Voice note failed', status: result.status }, result.status === 'no_supplier' ? 404 : result.status === 'transcribe_failed' ? 502 : 500);
  }
  return jsonResponse({
    status:     result.status,
    transcript: result.transcript,
    language:   result.language,
    price:      result.price,
    moq:        result.moq,
    leadTime:   result.leadTime,
    tone:       result.tone,
  });
}

// ── POST /api/suppliers/:id/products ─────────────────────────────────────────
// Multipart upload of a product photo against an existing supplier. Returns
// the new productId so the dashboard can immediately PATCH details against it.

export async function handleSupplierProduct(request: Request, env: Env, companyId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  const ct = request.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data' }, 415);
  }

  let form: FormData;
  try { form = await request.formData(); }
  catch { return jsonResponse({ error: 'Invalid multipart body' }, 400); }

  const photo = form.get('photo');
  if (photo == null || typeof photo === 'string') return jsonResponse({ error: 'Missing "photo" file field' }, 400);
  const photoBlob = photo as Blob & { name?: string };
  if (photoBlob.size === 0)              return jsonResponse({ error: 'Empty file' }, 400);
  if (photoBlob.size > MAX_UPLOAD_BYTES) return jsonResponse({ error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
  const mimeType = (photoBlob.type || '').toLowerCase();
  if (!mimeType.startsWith('image/'))    return jsonResponse({ error: 'Only image uploads accepted' }, 415);

  const bytes = new Uint8Array(await photoBlob.arrayBuffer());
  const result = await attachProductFromPhoto({
    companyId,
    buyerId: buyer.buyerId,
    channel: 'web',
    media:   { kind: 'bytes', bytes, mimeType },
    reply:   { channel: 'web' },
  }, env);

  if (!result.ok) {
    const code = result.status === 'no_supplier' ? 404
               : result.status === 'reclassified_as_card' ? 409
               : 500;
    return jsonResponse({ error: result.error ?? result.status, status: result.status }, code);
  }
  return jsonResponse({
    status:      result.status,
    productId:   result.productId,
    productName: result.productName,
    description: result.description,
    imageUrl:    result.imageUrl,
  });
}

// ── PATCH /api/products/:id ──────────────────────────────────────────────────
// JSON body: { price?, moq?, leadTime?, tone?, notes? }. Notes are appended
// (cumulative) per applyProductDetails in sourcebot.ts; other fields overwrite
// when non-empty.

export async function handleUpdateProduct(request: Request, env: Env, productId: string): Promise<Response> {
  if (request.method !== 'PATCH' && request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  let body: { price?: string; moq?: string; leadTime?: string; tone?: string; notes?: string };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const result = await updateProductDetails({
    productId,
    buyerId:  buyer.buyerId,
    price:    body.price,
    moq:      body.moq,
    leadTime: body.leadTime,
    tone:     body.tone,
    notes:    body.notes,
  }, env);

  if (!result.ok) {
    return jsonResponse({ error: result.error ?? result.status, status: result.status }, result.status === 'no_product' ? 404 : 500);
  }
  return jsonResponse({ status: 'success' });
}

// ── GET /api/suppliers/:id/email-draft ───────────────────────────────────────
// Draft a follow-up email to the supplier's primary contact. Returns
// { authUrl } when Gmail isn't connected so the dashboard can prompt OAuth.

export async function handleEmailDraft(request: Request, env: Env, companyId: string): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  const result = await draftSupplierEmail(companyId, buyer.buyerId, env);
  if (!result.ok) {
    if (result.status === 'gmail_not_connected') {
      return jsonResponse({ status: result.status, authUrl: result.authUrl }, 200);
    }
    const code = result.status === 'no_supplier'        ? 404
               : result.status === 'no_contact_email'   ? 422
               : 502;
    return jsonResponse({ error: result.status, status: result.status }, code);
  }
  return jsonResponse({ status: 'success', draft: result.draft });
}

// ── POST /api/suppliers/:id/email ────────────────────────────────────────────
// JSON body: { recipient, subject, body, html? }. Sends via the buyer's Gmail,
// logs sb_emails_sent, updates the sheet's email columns.

export async function handleEmailSend(request: Request, env: Env, companyId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  let body: { recipient?: string; subject?: string; body?: string; html?: string };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  if (!body.recipient || !body.subject || !body.body) {
    return jsonResponse({ error: 'recipient, subject, and body are required' }, 400);
  }

  const result = await sendSupplierEmail(companyId, buyer.buyerId, body.recipient, body.subject, body.body, body.html, env);
  if (!result.ok) {
    const code = result.status === 'no_supplier'        ? 404
               : result.status === 'gmail_not_connected' ? 401
               : 502;
    return jsonResponse({ error: result.error ?? result.status, status: result.status }, code);
  }
  return jsonResponse({ status: 'success', messageId: result.messageId, sentAt: result.sentAt });
}

// ── POST /api/blast ──────────────────────────────────────────────────────────
// Iterate every supplier in the active show with an email + no follow-up sent
// yet, draft + send. Returns counts and per-supplier status for the dashboard.

export async function handleBlast(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  const result = await blastSuppliers(buyer.buyerId, env);
  return jsonResponse(result);
}

// ── GET /api/search?q=... ────────────────────────────────────────────────────
// Cross-table search over the buyer's data (companies + contacts + products +
// voice notes). LIKE %q% matching with table-priority ranking.

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ results: [], role: 'boothbot' });

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return jsonResponse({ results: [], q });

  const results = await findAcrossSupplierData(buyer.buyerId, q, env);
  return jsonResponse({ q, results });
}

// ── POST /api/compare  body { q } ────────────────────────────────────────────
// Returns { matches[], analysis } — the dashboard renders this as a side-by-
// side comparison plus the Gemini summary.

export async function handleCompare(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  let body: { q?: string };
  try { body = await request.json() as typeof body; }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const q = (body.q ?? '').trim();
  if (!q) return jsonResponse({ error: 'q is required' }, 400);

  const result = await compareProducts(buyer.buyerId, q, env);
  return jsonResponse({ q, ...result });
}

// ── POST /api/suppliers/:id/pdf  +  POST /api/show/pdf ───────────────────────

export async function handleSupplierPdf(request: Request, env: Env, companyId: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  const result = await exportSupplierPdf(companyId, buyer.buyerId, env);
  if (!result.ok) return jsonResponse({ error: result.error ?? result.status, status: result.status }, result.status === 'no_supplier' ? 404 : 502);
  return jsonResponse(result);
}

export async function handleShowPdf(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  if (!buyer) return jsonResponse({ error: 'SourceBot account required' }, 403);

  const result = await exportShowPdf(buyer.buyerId, env);
  if (!result.ok) return jsonResponse({ error: result.error ?? result.status, status: result.status }, result.status === 'no_show' ? 404 : 502);
  return jsonResponse(result);
}

// ── GET /api/me/role ─────────────────────────────────────────────────────────
// Lightweight signal so the dashboard can render BoothBot vs SourceBot UI
// without making the user pick again.

export async function handleGetMyRole(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const buyer = await resolveBuyerForUser(auth.userId, env);
  return jsonResponse({ role: buyer ? 'sourcebot' : 'boothbot' });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw == null ? NaN : parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

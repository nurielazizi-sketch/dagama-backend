/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { requireAuth } from './auth';
import { handleCardCapture, resolveActiveShow } from './capture';

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

  const showOverride = (form.get('show') ?? '').toString().trim();
  const resolved     = showOverride || await resolveActiveShow(auth.userId, env);
  if (!resolved) {
    return jsonResponse({ error: 'No active show. Finish onboarding or pass a "show" field.' }, 400);
  }

  const bytes = new Uint8Array(await photoBlob.arrayBuffer());
  const result = await handleCardCapture({
    userId:   auth.userId,
    showName: resolved,
    botRole:  'boothbot',
    channel:  'web',
    media:    { kind: 'bytes', bytes, mimeType, filename: photoBlob.name },
    caption:  (form.get('notes') ?? '').toString() || undefined,
    reply:    { channel: 'web' },
  }, env);

  if (!result.ok) {
    return jsonResponse({ error: result.error ?? 'Capture failed', status: result.status }, 500);
  }

  return jsonResponse({
    leadId:    result.leadId,
    status:    result.status,
    rowIndex:  result.rowIndex,
    sheetUrl:  result.sheetUrl,
    showName:  resolved,
    contact:   result.contact,
  });
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

// ── helpers ──────────────────────────────────────────────────────────────────

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw == null ? NaN : parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

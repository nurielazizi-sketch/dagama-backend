/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Shared OCR + Gemini extraction. Imported by:
//   - src/telegram.ts  (BoothBot scanBusinessCard)
//   - src/queue.ts     (Phase-1 queue extraction)
//   - src/sourcebot.ts (handleSupplierCard)
//
// All three previously had their own near-identical copies; this module is the
// canonical source. Kept dependency-free aside from `Env` so it can be reused
// for future WhatsApp/email/etc. flows.
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GCV_URL    = 'https://vision.googleapis.com/v1/images:annotate';

export interface CardBbox { left: number; top: number; width: number; height: number }

export interface ExtractedContact {
  name:     string;
  title:    string;
  company:  string;
  email:    string;
  phone:    string;
  website:  string;
  linkedin: string;
  address:  string;
  country:  string;
}

export interface OcrResult {
  text:     string;
  bbox:     CardBbox | null;
  rotation: 0 | 90 | 180 | 270;
}

export interface ImageVisionResult {
  contact:    ExtractedContact;
  cardCenter: { x: number; y: number } | null;
  cardBbox:   CardBbox | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// runGcvOcr — Google Cloud Vision DOCUMENT_TEXT_DETECTION.
// Returns the full text plus bbox + rotation derived from word-vertex positions.
// Returns null if the call fails or no text is detected (caller falls back to
// Gemini vision).
// ─────────────────────────────────────────────────────────────────────────────
export async function runGcvOcr(base64: string, env: Env): Promise<OcrResult | null> {
  try {
    const res = await fetch(`${GCV_URL}?key=${env.GCV_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: base64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }],
      }),
    });
    if (!res.ok) {
      console.error(`[gcv] HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as {
      responses?: Array<{
        fullTextAnnotation?: GcvAnnotation;
        error?: { message?: string };
      }>;
    };
    const r0 = data.responses?.[0];
    if (!r0) return null;
    if (r0.error?.message) {
      console.error(`[gcv] api error: ${r0.error.message}`);
      return null;
    }
    const text = r0.fullTextAnnotation?.text ?? '';
    if (!text) return null;
    return {
      text,
      bbox:     computeBboxFromGcv(r0.fullTextAnnotation),
      rotation: detectRotationFromGcv(r0.fullTextAnnotation),
    };
  } catch (e) {
    console.error('[gcv] fetch threw:', e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// extractContactFromText — Gemini structured extraction over plain OCR text.
// Maps the spec's `fullName`/`jobTitle`/`industryContext` field names to our
// canonical `name`/`title`/`country` shape.
// ─────────────────────────────────────────────────────────────────────────────
export async function extractContactFromText(text: string, env: Env): Promise<ExtractedContact> {
  const prompt =
    `You are processing raw OCR text extracted from a business card. ` +
    `Extract all contact information and return ONLY a JSON object with these exact fields:\n` +
    `- fullName\n- jobTitle\n- company\n- email\n- phone\n- website\n- linkedin\n- address\n` +
    `- country (detect from address, phone dial code, website domain, or any clue; use the full English country name; empty string if undetectable)\n\n` +
    `Raw OCR text:\n${text}\n\n` +
    `If a field is not present return empty string. Be strict — only extract what is clearly present.`;
  const parsed = await callGemini([{ text: prompt }], env);
  return {
    name:     getStr(parsed, 'fullName')  || getStr(parsed, 'name'),
    title:    getStr(parsed, 'jobTitle')  || getStr(parsed, 'title'),
    company:  getStr(parsed, 'company'),
    email:    getStr(parsed, 'email'),
    phone:    getStr(parsed, 'phone'),
    website:  getStr(parsed, 'website'),
    linkedin: getStr(parsed, 'linkedin'),
    address:  getStr(parsed, 'address'),
    country:  getStr(parsed, 'country'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractContactFromImage — Gemini vision fallback when OCR fails or is empty.
// Returns the contact fields + cardCenter + cardBbox (Gemini estimates them
// since we don't have GCV's pixel-accurate positions in this branch).
// ─────────────────────────────────────────────────────────────────────────────
export async function extractContactFromImage(base64: string, mimeType: string, env: Env): Promise<ImageVisionResult> {
  const prompt =
    `You are a business card reader. Extract contact information from the image and return ONLY a JSON object with exactly these keys: ` +
    `name, title, company, email, phone, website, linkedin, address, country, cardCenter, cardBbox.\n` +
    `- For country: detect from address, phone dial code, or website domain. Empty string if undetectable.\n` +
    `- For cardCenter: {x, y} as normalized floats 0.0–1.0 marking the center of the business card in the photo.\n` +
    `- For cardBbox: {left, top, width, height} as percentages 0–100 of the total image dimensions for the card's bounding rectangle. left/top are distances from the top-left corner. If you cannot locate the card, set cardBbox to null.\n` +
    `If a contact field is not present, use empty string. Return raw JSON only — no markdown, no code fences.`;
  const parsed = await callGemini(
    [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }],
    env,
  );
  return {
    contact: {
      name:     getStr(parsed, 'fullName')  || getStr(parsed, 'name'),
      title:    getStr(parsed, 'jobTitle')  || getStr(parsed, 'title'),
      company:  getStr(parsed, 'company'),
      email:    getStr(parsed, 'email'),
      phone:    getStr(parsed, 'phone'),
      website:  getStr(parsed, 'website'),
      linkedin: getStr(parsed, 'linkedin'),
      address:  getStr(parsed, 'address'),
      country:  getStr(parsed, 'country'),
    },
    cardCenter: validCardCenter(parsed.cardCenter),
    cardBbox:   validCardBbox(parsed.cardBbox),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ocrThenExtract — convenience wrapper used by all three callers.
// Runs OCR; if successful, uses text-flow Gemini and falls back to image-flow
// only if OCR was empty or text-flow threw. The bbox always comes from GCV
// when the OCR path is used (more accurate than asking Gemini to estimate).
// ─────────────────────────────────────────────────────────────────────────────
export async function ocrThenExtract(
  base64: string,
  mimeType: string,
  env: Env,
): Promise<{
  contact:    ExtractedContact;
  cardCenter: { x: number; y: number } | null;
  cardBbox:   CardBbox | null;
  rotation:   0 | 90 | 180 | 270;
  ocrUsed:    boolean;
}> {
  const ocr = await runGcvOcr(base64, env);
  if (ocr && ocr.text.trim().length > 0) {
    console.log(`GCV OCR complete, text length: ${ocr.text.length} chars, rotation=${ocr.rotation}°`);
    try {
      const contact = await extractContactFromText(ocr.text, env);
      return { contact, cardCenter: null, cardBbox: ocr.bbox, rotation: ocr.rotation, ocrUsed: true };
    } catch (e) {
      console.error('[extract] text-flow Gemini failed, falling back to vision:', e);
    }
  } else {
    console.log('GCV failed or returned empty, falling back to Gemini vision');
  }
  const vision = await extractContactFromImage(base64, mimeType, env);
  return { ...vision, rotation: 0, ocrUsed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// GCV bbox + rotation helpers
// ─────────────────────────────────────────────────────────────────────────────

interface GcvAnnotation {
  text?: string;
  pages?: Array<{
    width?: number; height?: number;
    blocks?: Array<{
      boundingBox?: { vertices?: Array<{ x?: number; y?: number }> };
      paragraphs?: Array<{
        words?: Array<{ boundingBox?: { vertices?: Array<{ x?: number; y?: number }> } }>;
      }>;
    }>;
  }>;
}

// Bbox from the union of all detected text-block positions, padded by 4% of
// the bbox itself (not the image — keeps the crop tight on small cards in
// large frames).
function computeBboxFromGcv(anno?: GcvAnnotation): CardBbox | null {
  const page = anno?.pages?.[0];
  const w = page?.width ?? 0;
  const h = page?.height ?? 0;
  const blocks = page?.blocks ?? [];
  if (w <= 0 || h <= 0 || blocks.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of blocks) {
    for (const v of b.boundingBox?.vertices ?? []) {
      const x = v.x ?? 0, y = v.y ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity || minY === Infinity) return null;

  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const padX = bboxW * 0.04, padY = bboxH * 0.04;
  minX = Math.max(0, minX - padX);
  minY = Math.max(0, minY - padY);
  maxX = Math.min(w, maxX + padX);
  maxY = Math.min(h, maxY + padY);

  return {
    left:   (minX / w) * 100,
    top:    (minY / h) * 100,
    width:  ((maxX - minX) / w) * 100,
    height: ((maxY - minY) / h) * 100,
  };
}

// Detect the dominant text orientation from word-bbox vertex order.
// GCV returns vertices in TL→TR→BR→BL order relative to the text reading
// direction, so the TL→TR vector tells us where the text "forward" points.
// Returns the cf.image rotate value that would straighten the text.
function detectRotationFromGcv(anno?: GcvAnnotation): 0 | 90 | 180 | 270 {
  const page = anno?.pages?.[0];
  if (!page) return 0;

  const tally: Record<0 | 90 | 180 | 270, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const word of para.words ?? []) {
        const verts = word.boundingBox?.vertices ?? [];
        if (verts.length < 2) continue;
        const dx = (verts[1].x ?? 0) - (verts[0].x ?? 0);
        const dy = (verts[1].y ?? 0) - (verts[0].y ?? 0);
        let a = Math.atan2(dy, dx) * 180 / Math.PI;
        if (a < 0) a += 360;
        const snap = (Math.round(a / 90) * 90) % 360 as 0 | 90 | 180 | 270;
        tally[snap]++;
      }
    }
  }

  const winner = (Object.entries(tally) as Array<[string, number]>)
    .sort((a, b) => b[1] - a[1])[0];
  const textAngle = winner && winner[1] > 0 ? Number(winner[0]) as 0 | 90 | 180 | 270 : 0;

  // Map text reading direction → image rotation needed to straighten it
  if (textAngle === 90)  return 270;
  if (textAngle === 180) return 180;
  if (textAngle === 270) return 90;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini call helpers
// ─────────────────────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

async function callGemini(parts: GeminiPart[], env: Env): Promise<Record<string, unknown>> {
  const res = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (!data.candidates?.length) throw new Error(`Gemini returned no candidates: ${data.error?.message ?? JSON.stringify(data)}`);
  const raw = data.candidates[0]?.content?.parts?.[0]?.text ?? '{}';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`Gemini returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

function getStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function validCardCenter(v: unknown): { x: number; y: number } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { x?: unknown; y?: unknown };
  return typeof o.x === 'number' && typeof o.y === 'number' ? { x: o.x, y: o.y } : null;
}

function validCardBbox(v: unknown): CardBbox | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { left?: unknown; top?: unknown; width?: unknown; height?: unknown };
  if (typeof o.left   !== 'number' || typeof o.top    !== 'number' ||
      typeof o.width  !== 'number' || typeof o.height !== 'number') return null;
  if (o.width <= 0 || o.height <= 0) return null;
  return { left: o.left, top: o.top, width: o.width, height: o.height };
}

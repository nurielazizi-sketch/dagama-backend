/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// DemoBot Gemini enrichment prompts (master spec § "Gemini AI Prompts (Locked)").
//
//   Prompt 2 — classifyIndustry        (closed list of 8 industries)
//   Prompt 3 — describePersonPhoto     (conservative — never identifies)
//   Prompt 4 — analyzeWebsite          (extract-only, no inference)
//
// Card extraction (Prompts 1 + 5) lives in extract.ts; we reuse it as-is.
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Prompt 2: closed-list industry classifier.
export const INDUSTRIES = [
  'Electronics & Components',
  'Food & Beverage',
  'Textiles & Apparel',
  'Machinery & Equipment',
  'Chemicals & Materials',
  'Consumer Goods',
  'Logistics & Shipping',
  'Other',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export interface IndustryResult {
  industry:   Industry;
  confidence: 'high' | 'low';
  reasoning:  string;
}

export async function classifyIndustry(
  args: { company: string; title?: string; address?: string; website?: string },
  env: Env,
): Promise<IndustryResult> {
  const system =
    `You are classifying a company by industry based on its business card and extracted information.\n` +
    `Return ONLY JSON with these keys: industry, confidence, reasoning.\n` +
    `industry MUST be one of: ${INDUSTRIES.join(' | ')}.\n` +
    `confidence is "high" if the card or website makes the industry obvious, "low" otherwise.\n` +
    `reasoning is one short sentence explaining the choice.`;

  const user =
    `Company: ${args.company}\n` +
    `Title: ${args.title ?? ''}\n` +
    `Address: ${args.address ?? ''}\n` +
    `Website: ${args.website ?? ''}`;

  const parsed = await callGeminiJson([{ text: system }, { text: user }], env);
  const industry = INDUSTRIES.includes(parsed.industry as Industry)
    ? parsed.industry as Industry
    : 'Other';
  const confidence = parsed.confidence === 'high' ? 'high' : 'low';
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  return { industry, confidence, reasoning };
}

// Prompt 3: person photo description, conservative. Returns null if Gemini
// reports confidence < 0.8 or refuses (per spec — never identify).
export interface PersonPhotoResult {
  description: string;
  confidence:  number;        // 0.0–1.0
}
export async function describePersonPhoto(
  base64: string,
  mimeType: string,
  env: Env,
): Promise<PersonPhotoResult | null> {
  const prompt =
    `You are analyzing a trade show photo of a business professional. ` +
    `Focus only on objective observations: clothing, age range estimate, pose, demeanor. ` +
    `Never identify the person. Never assume ethnicity, cultural background, or attractiveness.\n\n` +
    `Return ONLY JSON: { "description": string, "confidence": float between 0 and 1 }\n` +
    `If your confidence is below 0.8, set description to "Unable to generate reliable description." ` +
    `and confidence to that value.\n` +
    `Format the description as: "Professional [gender], [age range], wearing [clothing]. [demeanor]."`;

  let parsed: Record<string, unknown>;
  try {
    parsed = await callGeminiJson(
      [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }],
      env,
    );
  } catch (e) {
    console.error('[demobot/photo] gemini failed:', e);
    return null;
  }

  const description = typeof parsed.description === 'string' ? parsed.description : '';
  const confidence  = typeof parsed.confidence  === 'number' ? parsed.confidence  : 0;
  if (!description || confidence < 0.8) return null;
  return { description, confidence };
}

// Prompt 4: website analysis. Strict-extraction only — no inference.
export interface WebsiteAnalysis {
  description?:        string;
  productsServices?:   string;
  industrySector?:     string;
  companySize?:        string;
  certifications?:     string;
  geographicPresence?: string;
  keyMetrics?:         string;
  quality:             'high' | 'medium' | 'low';
}

// Fetch the homepage HTML, then ask Gemini to extract 7 fields. 5000 chars max
// per spec. If fetch fails, returns null silently (downstream is allowed to
// proceed without website data).
export async function fetchAndAnalyzeWebsite(websiteUrl: string, env: Env): Promise<WebsiteAnalysis | null> {
  // Normalize the URL — accept "acme.com", "www.acme.com", "https://acme.com".
  let url = websiteUrl.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let html: string;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 DaGama-DemoBot' },
      cf: { cacheTtl: 3600 },
    });
    if (!res.ok) {
      console.log(`[demobot/website] HTTP ${res.status} on ${url}`);
      return null;
    }
    html = await res.text();
  } catch (e) {
    console.log('[demobot/website] fetch threw:', e);
    return null;
  }

  // Strip obvious noise + cap to first 5000 chars.
  const cleaned = stripHtml(html).slice(0, 5000);
  if (cleaned.length < 100) return null;

  const prompt =
    `You are analyzing a company website for business intelligence. ` +
    `Extract ONLY information that is clearly stated on the website. Do not infer or guess. ` +
    `If information is not present, use the literal string "Not found on website.".\n\n` +
    `Return ONLY JSON with these keys: description, productsServices, industrySector, companySize, certifications, geographicPresence, keyMetrics, quality.\n` +
    `quality is "high" / "medium" / "low" reflecting how much was extractable.\n\n` +
    `Website text:\n${cleaned}`;

  let parsed: Record<string, unknown>;
  try {
    parsed = await callGeminiJson([{ text: prompt }], env);
  } catch (e) {
    console.error('[demobot/website] gemini failed:', e);
    return null;
  }

  const out: WebsiteAnalysis = {
    description:        getStrOrUndef(parsed, 'description'),
    productsServices:   getStrOrUndef(parsed, 'productsServices'),
    industrySector:     getStrOrUndef(parsed, 'industrySector'),
    companySize:        getStrOrUndef(parsed, 'companySize'),
    certifications:     getStrOrUndef(parsed, 'certifications'),
    geographicPresence: getStrOrUndef(parsed, 'geographicPresence'),
    keyMetrics:         getStrOrUndef(parsed, 'keyMetrics'),
    quality:            parsed.quality === 'high' ? 'high'
                       : parsed.quality === 'medium' ? 'medium' : 'low',
  };
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice note transcription (Gemini multimodal — same model handles audio).
// Returns the verbatim transcript; caller writes it into the prospect sheet's
// Voice Note column and stores on demobot_prospects.
// ─────────────────────────────────────────────────────────────────────────────
export async function transcribeVoiceNote(
  base64: string,
  mimeType: string,
  env: Env,
): Promise<string> {
  const prompt =
    `Transcribe this voice note verbatim. Output only the transcript text. ` +
    `If the audio is unintelligible, output exactly: [unintelligible].`;

  const res = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    }),
  });
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text.trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

async function callGeminiJson(parts: GeminiPart[], env: Env): Promise<Record<string, unknown>> {
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

function getStrOrUndef(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t || t === 'Not found on website.') return undefined;
  return t;
}

// Strip script/style + tags down to whitespace-collapsed text.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

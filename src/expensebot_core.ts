/// <reference types="@cloudflare/workers-types" />

import { ask } from './gemini';

// ─────────────────────────────────────────────────────────────────────────────
// ExpenseBot core — pure functions for natural-language expense extraction +
// money formatting. Keeping this file free of D1 / fetch / Telegram lets us
// unit-test the parser independently of the runtime.
//
// v0.1 scope: text-only natural-language input. Receipt OCR + multi-line
// breakdown lands in v0.2. FX conversion (amount_usd_cents, fx_rate, fx_date)
// lands in v0.2 as well — for now those columns stay NULL.
// ─────────────────────────────────────────────────────────────────────────────

export type ExpenseContext = 'expedition' | 'basecamp';

export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'HKD', 'CNY', 'JPY', 'SGD', 'AED', 'ILS'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

// Decimal places per currency — JPY is the only zero-decimal currency in our
// supported set. Used for cents conversion (amount * 10^decimals → integer).
export const CURRENCY_DECIMALS: Record<SupportedCurrency, number> = {
  USD: 2, EUR: 2, GBP: 2, HKD: 2, CNY: 2, JPY: 0, SGD: 2, AED: 2, ILS: 2,
};

export const CURRENCY_SYMBOLS: Record<SupportedCurrency, string> = {
  USD: '$', EUR: '€', GBP: '£', HKD: 'HK$', CNY: '¥', JPY: '¥', SGD: 'S$', AED: 'د.إ', ILS: '₪',
};

export interface ExtractedExpense {
  amount:       number;            // user-facing decimal, e.g. 45.50
  currency:     SupportedCurrency;
  description:  string;
  category:     string | null;     // free-form for v1 (e.g. "food", "transport", "supplies")
  contextHint:  ExpenseContext | null; // model's read of expedition vs basecamp; null if uncertain
  confidence:   number;            // 0..1
}

// Marker used by the prompt for clean parsing. The model is instructed to
// output a single JSON object on a line starting with this prefix.
const RESULT_PREFIX = 'RESULT_JSON:';

export function buildExtractionPrompt(message: string, defaultContext: ExpenseContext): string {
  const supportedList = SUPPORTED_CURRENCIES.join(', ');
  return `You are an expense-extraction assistant for ExpenseBot, a chat-based expense logger built for trade-show exhibitors and buyers.

Extract a single expense from the user's message. The user is a busy professional logging quickly between meetings — input may be terse, mixed-language, or contain typos. Be generous in interpretation.

User's message:
"""
${message}
"""

Their default context is: ${defaultContext}
  - "expedition" = work / trade-show expenses (booth supplies, show transport, business meals at the show)
  - "basecamp"   = personal / household expenses (groceries, home utilities, personal transport)

Supported currencies: ${supportedList}
If the user wrote a currency symbol (€, £, HK$, ¥, ₪, د.إ), map it to the ISO 4217 code.
If no currency is mentioned, default to USD.
Decimal handling: "45,50" and "45.50" both mean 45.50.

Respond with EXACTLY ONE LINE in this format (no other text, no markdown, no preamble):

${RESULT_PREFIX} {"amount": <number>, "currency": "<ISO>", "description": "<string>", "category": "<string or null>", "context_hint": "<expedition | basecamp | null>", "confidence": <0..1>}

Rules:
- amount: positive decimal (e.g. 45.5, 1200, 0.99). Never include currency symbols here.
- description: one short clause describing what was bought (e.g. "coffee at the booth", "Uber to convention center").
- category: one of {food, transport, lodging, supplies, communication, entertainment, fees, other} or null if unclear.
- context_hint: "expedition" if message references show/booth/client/trip; "basecamp" if references home/family/personal; null if unclear (the default will be used).
- confidence: 0.9+ if you're sure of the amount AND currency; 0.5-0.7 if either is guessed; below 0.5 if the message doesn't look like an expense at all.

If the message is clearly NOT an expense (e.g. a greeting, a question, a command), respond:
${RESULT_PREFIX} {"amount": 0, "currency": "USD", "description": "", "category": null, "context_hint": null, "confidence": 0}`;
}

export function parseExtractionResponse(raw: string): ExtractedExpense | null {
  const idx = raw.indexOf(RESULT_PREFIX);
  if (idx < 0) return null;
  const tail = raw.slice(idx + RESULT_PREFIX.length).trim();
  // The model occasionally appends a trailing newline + reasoning despite the
  // prompt rule; pull out just the first { ... } JSON object.
  const start = tail.indexOf('{');
  const end   = tail.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(tail.slice(start, end + 1)); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const amount     = typeof o.amount === 'number' ? o.amount : NaN;
  const currency   = typeof o.currency === 'string' ? o.currency.toUpperCase() : '';
  const confidence = typeof o.confidence === 'number' ? o.confidence : 0;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!SUPPORTED_CURRENCIES.includes(currency as SupportedCurrency)) return null;
  if (confidence < 0.4) return null;
  const ctxRaw = o.context_hint;
  const contextHint: ExpenseContext | null =
    ctxRaw === 'expedition' || ctxRaw === 'basecamp' ? ctxRaw : null;
  return {
    amount,
    currency:    currency as SupportedCurrency,
    description: typeof o.description === 'string' ? o.description.trim() : '',
    category:    typeof o.category === 'string' && o.category.trim() ? o.category.trim().toLowerCase() : null,
    contextHint,
    confidence,
  };
}

// Convert decimal amount → integer cents using the currency's decimal_places.
// Math.round protects against floating-point drift (e.g. 45.55 * 100 = 4554.999...).
export function toMinorUnits(amount: number, currency: SupportedCurrency): number {
  const decimals = CURRENCY_DECIMALS[currency];
  return Math.round(amount * Math.pow(10, decimals));
}

export function formatMoney(amountCents: number, currency: SupportedCurrency): string {
  const decimals = CURRENCY_DECIMALS[currency];
  const symbol   = CURRENCY_SYMBOLS[currency];
  const major    = amountCents / Math.pow(10, decimals);
  return `${symbol}${major.toFixed(decimals)} ${currency}`;
}

export interface ExtractOptions {
  apiKey:         string;
  defaultContext: ExpenseContext;
}

export async function extractExpense(message: string, opts: ExtractOptions): Promise<ExtractedExpense | null> {
  const prompt = buildExtractionPrompt(message, opts.defaultContext);
  let raw: string;
  try { raw = await ask(prompt, opts.apiKey); }
  catch (e) { console.error('[expensebot] gemini extract failed:', e); return null; }
  return parseExtractionResponse(raw);
}

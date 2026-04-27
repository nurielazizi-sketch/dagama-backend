/// <reference types="@cloudflare/workers-types" />

// Cloudflare Turnstile bot-mitigation for /api/auth/register.
//
// Why: prevents bots from using our /register endpoint to spam Resend with
// verification emails to victim addresses. Without this, our sender reputation
// can be tanked by abuse → Resend may suspend the account.
//
// Flow:
//   1. /register page embeds the Turnstile widget with TURNSTILE_SITE_KEY.
//   2. User clicks Sign Up → frontend POSTs { email, cf_turnstile_response }.
//   3. Worker calls Cloudflare's siteverify endpoint with TURNSTILE_SECRET_KEY.
//   4. Only on success do we call sendVerificationEmail.
//
// Dev fallback: when TURNSTILE_SECRET_KEY is unset, verifyTurnstile returns
// success with a note. Mirrors how Resend / WhatsApp gracefully degrade locally.

import type { Env } from './types';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  success: boolean;
  error?: string;
  hostname?: string;
  challenge_ts?: string;
  action?: string;
  cdata?: string;
  skipped?: boolean;     // true when verification was bypassed (dev fallback)
}

export function isTurnstileConfigured(env: Env): boolean {
  return !!(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY);
}

export async function verifyTurnstile(
  token: string | undefined | null,
  ip: string | null,
  env: Env,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET_KEY) {
    return { success: true, skipped: true, error: 'turnstile not configured (dev fallback)' };
  }
  if (!token) return { success: false, error: 'missing-input-response' };

  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, { method: 'POST', body });
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { success: false, error: `siteverify ${res.status}` };

  const data = await res.json().catch(() => null) as
    | { success: boolean; 'error-codes'?: string[]; hostname?: string; challenge_ts?: string; action?: string; cdata?: string }
    | null;
  if (!data) return { success: false, error: 'siteverify response not json' };

  if (!data.success) {
    return { success: false, error: (data['error-codes'] ?? []).join(',') || 'turnstile rejected' };
  }
  return {
    success: true,
    hostname: data.hostname,
    challenge_ts: data.challenge_ts,
    action: data.action,
    cdata: data.cdata,
  };
}

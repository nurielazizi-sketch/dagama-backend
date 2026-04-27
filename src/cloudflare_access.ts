/// <reference types="@cloudflare/workers-types" />

// Belt-and-braces verification of Cloudflare Access JWTs.
// CF Access is configured at the edge (Zero Trust dashboard) and intercepts
// requests to /admin* and /api/admin/* before they reach the Worker. Every
// request that does reach the Worker carries:
//   Cf-Access-Jwt-Assertion: <RS256 JWT signed by Cloudflare>
// We re-verify that header here so that even if the edge gate is misconfigured
// or bypassed, the Worker itself enforces auth.
//
// Spec: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import type { Env } from './types';

export interface CfAccessIdentity {
  email: string;
  sub: string;                 // CF user UUID
  aud: string | string[];      // application AUD tag(s)
  iss: string;                 // https://<team>.cloudflareaccess.com
  exp: number;
  iat: number;
  identity_nonce?: string;
  custom?: Record<string, unknown>;
}

interface JwksKey {
  kid: string;
  kty: string;
  alg: string;
  use?: string;
  e: string;
  n: string;
}

let jwksCache: { keys: Map<string, CryptoKey>; expires: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;  // 1h — Cloudflare rotates keys infrequently

export function isCfAccessConfigured(env: Env): boolean {
  return !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD_TAG);
}

async function loadJwks(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (jwksCache && jwksCache.expires > now) return jwksCache.keys;
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cf-access jwks ${res.status}`);
  const data = await res.json() as { keys?: JwksKey[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of data.keys ?? []) {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: k.kty, n: k.n, e: k.e, alg: 'RS256', ext: true } as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(k.kid, cryptoKey);
  }
  jwksCache = { keys, expires: now + JWKS_TTL_MS };
  return keys;
}

function b64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyAccessJwt(jwt: string, env: Env): Promise<CfAccessIdentity | null> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD_TAG) return null;

  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { kid?: string; alg?: string };
  let payload: CfAccessIdentity;
  try {
    header  = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch { return null; }

  if (header.alg !== 'RS256' || !header.kid) return null;

  let keys: Map<string, CryptoKey>;
  try {
    keys = await loadJwks(env.CF_ACCESS_TEAM_DOMAIN);
  } catch {
    return null;
  }
  const key = keys.get(header.kid);
  if (!key) return null;

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlDecode(sigB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
  if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) return null;

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.CF_ACCESS_AUD_TAG)) return null;
  if (typeof payload.email !== 'string' || !payload.email) return null;

  return payload;
}

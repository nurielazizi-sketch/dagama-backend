/// <reference types="@cloudflare/workers-types" />

// Runtime-tunable config backed by the app_config D1 table (migration 029).
// Read at request time via getConfig(env, key, fallback) — wrapped in a
// per-isolate Map cache with a 30s TTL so flipping a flag in /admin takes
// effect within ~30s without redeploy. setConfig() writes both app_config
// and app_config_audit in a single batch and invalidates the local cache.

import type { Env } from './types';

export type ConfigValueType = 'string' | 'number' | 'bool' | 'json';

export interface ConfigRow {
  key: string;
  value: string;
  value_type: ConfigValueType;
  description: string | null;
  updated_at: number;
  updated_by: string | null;
}

interface CacheEntry { value: string; type: ConfigValueType; expires: number }

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

function cast<T>(raw: string, type: ConfigValueType, fallback: T): T {
  try {
    if (type === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? (n as unknown as T) : fallback;
    }
    if (type === 'bool')   return ((raw === 'true' || raw === '1') as unknown as T);
    if (type === 'json')   return JSON.parse(raw) as T;
    return raw as unknown as T;
  } catch {
    return fallback;
  }
}

export async function getConfig<T>(env: Env, key: string, fallback: T): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cast(cached.value, cached.type, fallback);

  const row = await env.DB.prepare(
    `SELECT value, value_type FROM app_config WHERE key = ?`
  ).bind(key).first<{ value: string; value_type: ConfigValueType }>();

  if (!row) return fallback;
  cache.set(key, { value: row.value, type: row.value_type, expires: now + CACHE_TTL_MS });
  return cast(row.value, row.value_type, fallback);
}

export async function listConfig(env: Env): Promise<ConfigRow[]> {
  const res = await env.DB.prepare(
    `SELECT key, value, value_type, description, updated_at, updated_by FROM app_config ORDER BY key ASC`
  ).all<ConfigRow>();
  return res.results ?? [];
}

export interface SetConfigResult {
  ok: boolean;
  error?: string;
  row?: ConfigRow;
}

export async function setConfig(env: Env, key: string, newValue: string, by: string): Promise<SetConfigResult> {
  const existing = await env.DB.prepare(
    `SELECT value, value_type FROM app_config WHERE key = ?`
  ).bind(key).first<{ value: string; value_type: ConfigValueType }>();

  if (!existing) return { ok: false, error: 'unknown key' };

  if (existing.value_type === 'number' && !Number.isFinite(Number(newValue))) {
    return { ok: false, error: 'value must be a finite number' };
  }
  if (existing.value_type === 'bool' && newValue !== 'true' && newValue !== 'false') {
    return { ok: false, error: "value must be 'true' or 'false'" };
  }
  if (existing.value_type === 'json') {
    try { JSON.parse(newValue); } catch { return { ok: false, error: 'value must be valid JSON' }; }
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE app_config SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?`)
          .bind(newValue, now, by, key),
    env.DB.prepare(`INSERT INTO app_config_audit (key, old_value, new_value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)`)
          .bind(key, existing.value, newValue, now, by),
  ]);

  cache.delete(key);
  const row = await env.DB.prepare(
    `SELECT key, value, value_type, description, updated_at, updated_by FROM app_config WHERE key = ?`
  ).bind(key).first<ConfigRow>();
  return { ok: true, row: row ?? undefined };
}

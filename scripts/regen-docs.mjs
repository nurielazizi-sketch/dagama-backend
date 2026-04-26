// Deterministic doc regeneration — keeps the structural sections of
// docs/SCHEMA.md and docs/API.md in sync with source on a daily cron.
//
// What this rewrites:
//   - SCHEMA.md  : the "Migration index" table at the bottom (all rows)
//   - API.md     : the API route table (all rows)
//
// Hand-written prose, per-table notes, and section headings are preserved.
// Auto-regenerated blocks are bounded by HTML comment markers:
//
//   <!-- AUTO:MIGRATIONS:START -->
//   ... rewritten ...
//   <!-- AUTO:MIGRATIONS:END -->
//
//   <!-- AUTO:ROUTES:START -->
//   ... rewritten ...
//   <!-- AUTO:ROUTES:END -->
//
// Usage:  npm run docs            (regenerates both)
//         npm run docs -- --check (exits 1 if anything would change — for CI)

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isCheck = process.argv.includes('--check');

let dirty = false;

function replaceBlock(content, name, replacement) {
  const start = `<!-- AUTO:${name}:START -->`;
  const end   = `<!-- AUTO:${name}:END -->`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`, 'm');
  if (!re.test(content)) {
    // Block missing — append to end of file with a heading.
    return `${content.trimEnd()}\n\n${start}\n${replacement}\n${end}\n`;
  }
  return content.replace(re, `${start}\n${replacement}\n${end}`);
}

function update(path, name, replacement) {
  const before = readFileSync(path, 'utf8');
  const after  = replaceBlock(before, name, replacement);
  if (before !== after) {
    if (isCheck) {
      console.error(`[regen-docs] OUT OF DATE: ${path} :: ${name}`);
      dirty = true;
    } else {
      writeFileSync(path, after);
      console.log(`[regen-docs] updated ${path} :: ${name}`);
    }
  } else {
    console.log(`[regen-docs] up-to-date  ${path} :: ${name}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Migration index — list every migrations/NNN_*.sql with a one-line summary
// pulled from the file's leading `--` comment (or the first DDL statement).
// ───────────────────────────────────────────────────────────────────────────

function buildMigrationIndex() {
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const rows = files.map(f => {
    const num = f.match(/^(\d+)/)?.[1] ?? '';
    const text = readFileSync(join(dir, f), 'utf8');
    let summary = '';
    const firstComment = text.match(/^--\s*(.+)$/m);
    if (firstComment) summary = firstComment[1].trim();
    if (!summary) {
      const firstDdl = text.match(/^(CREATE TABLE[^(]*|ALTER TABLE[^;]*|CREATE INDEX[^;]*);/m);
      if (firstDdl) summary = firstDdl[1].replace(/\s+/g, ' ').slice(0, 80);
    }
    summary = summary.replace(/\|/g, '\\|');
    return `| ${num} | \`${f}\` | ${summary} |`;
  });
  return [
    '| # | File | First-line summary |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// API route table — parsed from the path === '/api/...' dispatch in index.ts
// ───────────────────────────────────────────────────────────────────────────

function buildRouteTable() {
  const src = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
  const lines = src.split('\n');
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // Match  if (path === '/api/foo') ...    or with a method guard
    const m = ln.match(/if\s*\(\s*path\s*===\s*'([^']+)'(?:\s*&&\s*request\.method\s*===\s*'([A-Z]+)')?\s*\)/);
    if (m) {
      const path = m[1];
      let method = m[2] ?? '';
      // Try to grab the handler name from the same line
      const handler = ln.match(/return\s+(?:addCors\(await\s+)?(\w+)\(/)?.[1] ?? '';
      // If no method guard on this line, try to infer from the handler name
      if (!method) {
        if (/Webhook$/i.test(handler) || /Setup$/i.test(handler) || /Reset/i.test(handler)) method = 'POST';
        else if (/Callback$/i.test(handler) || /Get/i.test(handler) || /Status$/i.test(handler) || /^handle(Health|Me|Stats|Insights)$/.test(handler)) method = 'GET';
      }
      rows.push({ method: method || 'ANY', path, handler });
      continue;
    }

    // Path-regex matches (e.g. shows-catalog/:id)
    const re = ln.match(/path\.match\(([^)]+)\)/);
    if (re) {
      // Look ahead a few lines for PUT / DELETE / etc.
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const sub = lines[j].match(/request\.method\s*===\s*'([A-Z]+)'\s*\).*?return\s+(?:addCors\(await\s+)?(\w+)\(/);
        if (sub) {
          rows.push({ method: sub[1], path: '(regex) ' + re[1].trim(), handler: sub[2] });
        }
      }
    }
  }

  return [
    '| Method | Path | Handler |',
    '|---|---|---|',
    ...rows.map(r => `| ${r.method} | \`${r.path}\` | \`${r.handler}\` |`),
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────────────────

update(join(ROOT, 'docs/SCHEMA.md'), 'MIGRATIONS', buildMigrationIndex());
update(join(ROOT, 'docs/API.md'),    'ROUTES',     buildRouteTable());

if (isCheck && dirty) {
  console.error('\n[regen-docs] Run `npm run docs` to refresh.');
  process.exit(1);
}

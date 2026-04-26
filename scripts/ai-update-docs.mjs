// AI-assisted intent-doc updater.
//
// Reads yesterday's source diff and the current prose docs, asks Claude for
// targeted Edit-style patches, and applies them in-place. The GitHub Actions
// workflow (.github/workflows/ai-update-docs.yml) opens a PR with the result
// every night so a human reviews before anything lands on main.
//
// Why Edit-style and not full rewrites?
//   - Cheaper (only the changed regions go in/out of the model)
//   - Minimizes hallucination scope (Claude can't quietly rewrite unrelated
//     paragraphs, only the chunks it explicitly proposed to change)
//   - Easier to review in a PR diff
//
// Usage:
//   ANTHROPIC_API_KEY=... node scripts/ai-update-docs.mjs
//   ANTHROPIC_API_KEY=... node scripts/ai-update-docs.mjs --since="3 days ago"
//   node scripts/ai-update-docs.mjs --dry-run     (skips API call; prints intent)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.env.AI_DOCS_MODEL || 'claude-sonnet-4-6';
const SINCE = process.argv.find(a => a.startsWith('--since='))?.split('=')[1] || '1 day ago';
const DRY = process.argv.includes('--dry-run');
const MAX_DIFF_CHARS = 80_000;     // cap to keep token cost predictable
const MAX_OUTPUT_TOKENS = 8000;

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY && !DRY) {
  console.error('[ai-update-docs] ANTHROPIC_API_KEY not set — skipping (run with --dry-run to preview).');
  process.exit(0);
}

// ── Target docs (intent + prose; NOT the auto-generated SCHEMA.md / API.md) ──
const TARGETS = [
  'docs/ARCHITECTURE.md',
  'docs/SOURCEBOT.md',
  'docs/BOOTHBOT.md',
  'docs/DEMOBOT.md',
  'docs/WEBSITE.md',
  'docs/MARKETING.md',
  'docs/PRICING.md',
  'docs/ROADMAP.md',
].filter(p => existsSync(join(ROOT, p)));

// ── Gather yesterday's source changes ────────────────────────────────────────
function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

const log = sh(`git log --since="${SINCE}" --pretty=format:"%h %s%n%b" --no-merges`);

// Find the SHA of the most-recent commit *before* the SINCE cutoff. Diffing
// against that gives us "everything that happened during the SINCE window".
// We can't use `@{1 day ago}` reflog syntax — CI runners have empty reflogs.
const baseSha = sh(`git rev-list -1 --before="${SINCE}" HEAD`).trim();
let diff = '';
if (baseSha) {
  diff = sh(`git diff --no-color ${baseSha}..HEAD -- src/ migrations/ wrangler.toml`).slice(0, MAX_DIFF_CHARS);
}
const truncated = diff.length === MAX_DIFF_CHARS;

if (!log && !diff) {
  console.log('[ai-update-docs] No source changes since "' + SINCE + '" — nothing to do.');
  process.exit(0);
}

// ── Build the model prompt ──────────────────────────────────────────────────
const docs = TARGETS.map(p => {
  const content = readFileSync(join(ROOT, p), 'utf8');
  return `===== FILE: ${p} =====\n${content}\n===== END ${p} =====`;
}).join('\n\n');

const SYSTEM = `You maintain in-repo documentation for the DaGama backend.

Your job is to keep a small set of intent docs honest with the code. You will receive:
  1. A list of recent commits (subject + body).
  2. A unified diff of source-code changes (src/, migrations/, wrangler.toml).
  3. The current contents of every target doc, verbatim.

You return a JSON object describing exact-match find-and-replace edits to apply.
DO NOT rewrite whole files. DO NOT add new sections unless the diff genuinely demands it. Preserve voice, structure, and links. Only patch what would otherwise be wrong or stale because of the source change.

Output schema (raw JSON, no markdown fences):

{
  "summary": "One sentence describing what changed and why.",
  "edits": [
    {
      "file": "docs/SOURCEBOT.md",
      "old_string": "exact text from the current doc, with enough context to be unique",
      "new_string": "the replacement",
      "reason": "Why this edit reflects the source change (1 short sentence)."
    }
  ]
}

Rules:
  - 'old_string' MUST appear verbatim in the named file. Don't invent text.
  - Include enough surrounding context in 'old_string' to make it unique within the file.
  - Prefer additive edits (new bullets, table rows) over rewrites.
  - If a doc doesn't need updates given the diff, simply omit it from 'edits'.
  - If absolutely nothing needs updating, return {"summary": "no-op", "edits": []}.
  - NEVER touch docs/SCHEMA.md or docs/API.md (they're auto-generated).
  - NEVER touch docs/README.md unless the convention itself changes.
  - Don't fabricate features. If something in the diff is unclear, leave the doc alone.`;

const USER =
`# Recent commits
${log || '(no new commits)'}

# Source diff${truncated ? ' (TRUNCATED — only the first ' + MAX_DIFF_CHARS + ' chars)' : ''}
\`\`\`diff
${diff || '(empty)'}
\`\`\`

# Current docs

${docs}

Return the JSON object now.`;

if (DRY) {
  console.log('[dry-run] would call', MODEL, 'with system + user prompts:');
  console.log('  system: ' + SYSTEM.length + ' chars');
  console.log('  user:   ' + USER.length + ' chars');
  console.log('  targets: ' + TARGETS.length + ' files');
  process.exit(0);
}

// ── Call Claude ──────────────────────────────────────────────────────────────
async function callClaude() {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: USER }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${txt.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text ?? '';
  if (!text) throw new Error('Empty response: ' + JSON.stringify(data).slice(0, 500));
  return text;
}

const raw = await callClaude();

// Parse — be tolerant of leading/trailing whitespace or stray code fences.
function parseJson(s) {
  const cleaned = s.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {
    throw new Error(`Could not parse JSON output:\n${s.slice(0, 600)}\n\nError: ${e.message}`);
  }
}

const out = parseJson(raw);
if (!out || !Array.isArray(out.edits)) {
  console.error('[ai-update-docs] Unexpected shape:', JSON.stringify(out).slice(0, 500));
  process.exit(1);
}

console.log(`[ai-update-docs] ${out.summary || '(no summary)'}`);
console.log(`[ai-update-docs] ${out.edits.length} edit(s) proposed.`);

if (out.edits.length === 0) {
  console.log('[ai-update-docs] No-op.');
  process.exit(0);
}

// ── Apply edits ──────────────────────────────────────────────────────────────
let applied = 0;
let skipped = 0;
for (const e of out.edits) {
  if (!e.file || !e.old_string || typeof e.new_string !== 'string') {
    console.warn('[skip] malformed edit:', JSON.stringify(e).slice(0, 200));
    skipped++; continue;
  }
  if (!TARGETS.includes(e.file)) {
    console.warn('[skip] edit targets non-allowed file: ' + e.file);
    skipped++; continue;
  }
  const path = join(ROOT, e.file);
  const before = readFileSync(path, 'utf8');
  const occurrences = before.split(e.old_string).length - 1;
  if (occurrences === 0) {
    console.warn('[skip] old_string not found in ' + e.file + ' — Claude may have hallucinated.');
    skipped++; continue;
  }
  if (occurrences > 1) {
    console.warn('[skip] old_string appears ' + occurrences + 'x in ' + e.file + ' — too ambiguous.');
    skipped++; continue;
  }
  const after = before.replace(e.old_string, e.new_string);
  writeFileSync(path, after);
  applied++;
  console.log(`[apply] ${e.file} — ${e.reason ?? '(no reason given)'}`);
}

console.log(`[ai-update-docs] applied=${applied} skipped=${skipped}`);
if (applied === 0) process.exit(0);

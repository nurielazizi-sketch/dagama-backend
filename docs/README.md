# DaGama — Documentation Index

This folder is the **canonical spec** for DaGama. Code is the source of truth; these docs reflect what's actually shipped. The pre-launch Google Doc spec is superseded.

---

## Bots

- [SOURCEBOT.md](SOURCEBOT.md) — buyer-side bot. Captures suppliers, products, voice notes, AI follow-ups at sourcing trade shows (Canton Fair, Yiwu, etc.).
- [BOOTHBOT.md](BOOTHBOT.md) — seller-side bot. Booth exhibitors capture buyer leads from business cards, transcribe notes, send Gmail follow-ups.
- [DEMOBOT.md](DEMOBOT.md) — freelancer / demo bot used at shows for white-label and POC engagements; supports Telegram + WhatsApp.

## Product + business

- [MARKETING.md](MARKETING.md) — positioning, target users, value prop, channels, growth loops.
- [WEBSITE.md](WEBSITE.md) — landing / login / register / dashboard / onboard-complete pages, copy, design system, brand voice.
- [PRICING.md](PRICING.md) — every plan, price, gates, billing model.

## Engineering

- [ARCHITECTURE.md](ARCHITECTURE.md) — Cloudflare Workers + D1 + R2 + Queues + Cron + integrations topology.
- [SCHEMA.md](SCHEMA.md) — every D1 table, columns, FKs, indexes.
- [API.md](API.md) — every `/api/*` endpoint, method, auth, request/response shape.

## Process

- [ROADMAP.md](ROADMAP.md) — built ✅ / partial 🟡 / deferred ⏳ — diff against the original spec.

---

## Use with AI tools

These files are written for direct ingestion into NotebookLM, ChatGPT custom GPTs, Claude Projects, Cursor / Windsurf, and any other tool that consumes Markdown. Each file is self-contained, cross-links to siblings, and source-cites to repo paths so a tool can fetch the underlying code if it has filesystem access.

Convention used throughout:
- ✅ shipped · 🟡 partial · ⏳ deferred · 🔄 changed during dev (vs. original spec)
- Source-of-truth links use repo-relative paths (`../src/foo.ts`)
- Tables for data; bullets for flows

---

## How these files stay current

Two-track maintenance so the docs never drift the way the original Google-Docs spec did:

**Track 1 — Structural codegen (automated daily)**
`scripts/regen-docs.mjs` rewrites the auto-marked blocks in [SCHEMA.md](SCHEMA.md) (migration index) and [API.md](API.md) (route table) from source. The GitHub Actions workflow `.github/workflows/regen-docs.yml` runs daily at 21:00 UTC (≈ midnight Israel time) and on every push to `main`; if anything's out of date it commits the regen back. A second workflow `docs-check.yml` blocks PRs whose source change doesn't include the matching doc regen.

Run locally:
```bash
npm run docs         # regenerate
npm run docs:check   # exit 1 if anything would change (used in CI)
```

**Track 2 — Intent docs (manual / AI-assisted)**
The hand-written prose in [ARCHITECTURE.md](ARCHITECTURE.md), [SOURCEBOT.md](SOURCEBOT.md), [BOOTHBOT.md](BOOTHBOT.md), [DEMOBOT.md](DEMOBOT.md), [WEBSITE.md](WEBSITE.md), [MARKETING.md](MARKETING.md), [PRICING.md](PRICING.md), [ROADMAP.md](ROADMAP.md) encodes intent and design rationale, not just structure — codegen can't infer it. Update those by hand or by running Claude Code on the day's diff:
```bash
git log --since="yesterday" --oneline
git diff HEAD~N..HEAD -- src/   # whatever range covers today's work
```
Then ask Claude to "scan the diff and patch the relevant docs in `docs/`".

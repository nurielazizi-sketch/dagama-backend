# DaGama Backend

Trade show intelligence platform on Cloudflare Workers.

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Open http://localhost:8787
```

## Setup

1. Copy `.dev.vars.example` to `.dev.vars`
2. Fill in your actual credentials
3. Run `npm install`
4. Run `npm run dev`

## Tech Stack

- Cloudflare Workers (TypeScript)
- Cloudflare D1 (SQLite)
- Gemini API
- Google APIs (Drive, Sheets, Gmail)
- Telegram Bot API
- Stripe

## Development

```bash
npm run dev              # Start local dev server
npm run build            # Compile TypeScript
npm run type-check       # Check for errors
npm run deploy           # Deploy to production
```

## Learn More

- See `DEVELOPMENT.md` for team setup guide
- See `PHASE_1_ACTION_PLAN.md` for implementation details
- See `DAGAMA_DEVELOPMENT_CHECKPOINT.md` for project overview
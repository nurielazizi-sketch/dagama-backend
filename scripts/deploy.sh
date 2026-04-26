#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# DaGama backend — one-shot deploy.
#
# Usage:  ./scripts/deploy.sh [production]
#   - Applies all migrations in order (idempotent — skips if already applied).
#   - Deploys the worker.
#   - Registers the SourceBot Telegram webhook (idempotent).
#
# Prerequisites (one-time):
#   - npx wrangler login        (or CLOUDFLARE_API_TOKEN env var)
#   - All required secrets set. The script checks and reports any missing.
#
# To set a missing secret, copy the printed command and run it.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

cd "$(dirname "$0")/.."

ENV="${1:-production}"
ORIGIN="${ORIGIN:-https://api.heydagama.com}"

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
green() { color '32' "$1"; }
red()   { color '31' "$1"; }
yellow(){ color '33' "$1"; }
bold()  { color '1'  "$1"; }

step() { echo; echo "▶ $(bold "$1")"; }

# ── 0. Sanity: are we logged in? ─────────────────────────────────────────────
step "checking wrangler auth"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "$(red '✘') wrangler is not authenticated."
  echo "  Run:  $(bold 'npx wrangler login')"
  echo "  Or:   export CLOUDFLARE_API_TOKEN=<token-from-dash.cloudflare.com/profile/api-tokens>"
  exit 1
fi
echo "$(green '✓') wrangler authenticated"

# ── 1. Check required secrets ────────────────────────────────────────────────
step "checking required secrets"
REQUIRED_SECRETS=(
  TELEGRAM_BOT_TOKEN
  TELEGRAM_BOT_TOKEN_SOURCE
  GEMINI_API_KEY
  GCV_API_KEY
  WEBHOOK_SECRET
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GOOGLE_SERVICE_ACCOUNT_EMAIL
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
)
SECRET_LIST="$(npx wrangler secret list --env "$ENV" 2>/dev/null || echo '[]')"
MISSING=()
for s in "${REQUIRED_SECRETS[@]}"; do
  if ! echo "$SECRET_LIST" | grep -q "\"$s\""; then
    MISSING+=("$s")
  fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "$(red '✘') missing secrets:"
  for s in "${MISSING[@]}"; do
    echo "    $(yellow '–') $s"
    echo "      Set it with:  echo \"<value>\" | npx wrangler secret put $s --env $ENV"
  done
  echo
  echo "Set the missing secrets, then re-run this script."
  exit 1
fi
echo "$(green '✓') all required secrets present"

# Optional secrets — warn but don't fail
OPTIONAL_SECRETS=(DAGAMA_NOREPLY_REFRESH_TOKEN DAGAMA_NOREPLY_FROM_EMAIL)
for s in "${OPTIONAL_SECRETS[@]}"; do
  if ! echo "$SECRET_LIST" | grep -q "\"$s\""; then
    echo "$(yellow '⚠') optional secret not set: $s (welcome emails will log to console only)"
  fi
done

# ── 2. Apply migrations in order ─────────────────────────────────────────────
step "applying migrations"
MIGRATIONS=(
  003_gmail_tokens.sql
  004_leads_columns.sql
  005_lead_message_id.sql
  006_buyer_shows.sql
  007_leads_status.sql
  008_sourcebot_schema.sql
  009_google_sheets_owner_type.sql
  010_sb_products.sql
  011_sb_voice_notes.sql
  012_sb_emails_sent.sql
  013_sb_per_supplier_folder.sql
  014_sb_subfolders_corrections.sql
  015_sb_show_metadata_plans.sql
  016_funnel_events.sql
  017_referrals_language.sql
  018_interest_soft_delete.sql
  019_sb_tg_updates_seen.sql
  020_demobot.sql
  021_whatsapp.sql
  022_demobot_self_serve.sql
  023_demobot_whatsapp.sql
)

for m in "${MIGRATIONS[@]}"; do
  printf '  %-40s ' "$m"
  if [ ! -f "migrations/$m" ]; then
    echo "$(yellow 'SKIP') (file missing)"
    continue
  fi
  OUT=$(npx wrangler d1 execute dagama --env "$ENV" --remote --file="migrations/$m" 2>&1) && RC=0 || RC=$?
  if [ $RC -eq 0 ]; then
    echo "$(green 'OK')"
  elif echo "$OUT" | grep -qiE "duplicate column name|already exists|table .* already exists"; then
    echo "$(yellow 'already applied')"
  else
    echo "$(red 'FAILED')"
    echo "$OUT" | sed 's/^/      /'
    exit 1
  fi
done

# ── 3. Deploy ────────────────────────────────────────────────────────────────
step "deploying worker"
npx wrangler deploy --env "$ENV"

# ── 4. Smoke check (give CF a few seconds to propagate) ──────────────────────
step "post-deploy smoke check"
sleep 4
HEALTH=$(curl -fsS "$ORIGIN/api/health" 2>&1) || {
  echo "$(red '✘') /api/health failed — worker may not be live yet."
  echo "$HEALTH" | sed 's/^/    /'
  exit 1
}
if echo "$HEALTH" | grep -q '"status": "ok"'; then
  echo "$(green '✓') /api/health → ok"
else
  echo "$(yellow '⚠') /api/health → degraded:"
  echo "$HEALTH" | sed 's/^/    /'
fi

# ── 5. Register SourceBot webhook (idempotent) ───────────────────────────────
step "registering SourceBot webhook"
RESP=$(curl -fsS -X POST "$ORIGIN/api/sourcebot/setup" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"$ORIGIN\"}" 2>&1) || {
    echo "$(red '✘') sourcebot webhook registration failed:"
    echo "$RESP" | sed 's/^/    /'
    exit 1
  }
echo "$(green '✓') sourcebot webhook registered"
echo "    $RESP"

# ── 6. Register DemoBot webhook (only if token is set) ───────────────────────
if echo "$SECRET_LIST" | grep -q '"TELEGRAM_BOT_TOKEN_DEMO"'; then
  step "registering DemoBot webhook"
  RESP=$(curl -fsS -X POST "$ORIGIN/api/demobot/setup" 2>&1) || {
    echo "$(yellow '⚠') demobot webhook registration failed (worker may not have picked up the route yet):"
    echo "$RESP" | sed 's/^/    /'
  }
  echo "$(green '✓') demobot webhook registered"
  echo "    $RESP"
else
  echo "$(yellow '⚠') TELEGRAM_BOT_TOKEN_DEMO not set — skipping DemoBot webhook registration"
fi

echo
echo "$(green '✅ deploy complete')  env=$ENV"

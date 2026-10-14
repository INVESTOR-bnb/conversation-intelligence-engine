#!/usr/bin/env bash
# Stage 2A-6d — one command for the guarded single-case PAID synthetic analysis on STAGING,
# for a GitHub Codespace on Android. Run from recovery-prototype/, ONLY after the founder's
# separate approval of the paid run (docs/stage-2a/DEPLOY-STAGE-2A-6D.md):
#   bash supabase/scripts/paid-pipeline-e2e.sh             the run
#   bash supabase/scripts/paid-pipeline-e2e.sh --paid-off  recovery: spending off, paid models
#                                                          inactive, provider key and paid settings deleted
# Values are asked at prompts (passwords, the access token and the provider key hidden). They
# exist only inside this script's process and are gone when it ends: nothing is written to
# disk, shell history or the output.
set -euo pipefail
[ -f supabase/scripts/paid-pipeline-e2e.mjs ] || { echo "run this from recovery-prototype/" >&2; exit 2; }
[ -d node_modules/@supabase/supabase-js ] || npm ci --no-audit --no-fund >/dev/null

echo "Staging project: aqwdwswpmbnzmkvyuqil (synthetic data only)"
read -rs -p 'Scoped Supabase access token (sbp_…, hidden): ' SUPABASE_ACCESS_TOKEN; echo
export SUPABASE_ACCESS_TOKEN
if [ "${1:-}" != --paid-off ]; then
  RRE_SUPABASE_URL=https://aqwdwswpmbnzmkvyuqil.supabase.co
  read -r  -p 'Publishable key (sb_publishable_…): ' RRE_PUBLISHABLE_KEY
  read -r  -p 'Client A email: '     CLIENT_A_EMAIL
  read -rs -p 'Client A password: '  CLIENT_A_PASSWORD; echo
  read -r  -p 'Client B email: '     CLIENT_B_EMAIL
  read -rs -p 'Client B password: '  CLIENT_B_PASSWORD; echo
  read -r  -p 'Founder email: '      FOUNDER_EMAIL
  read -rs -p 'Founder password: '   FOUNDER_PASSWORD; echo
  read -rs -p 'Anthropic API key for the limited evaluation workspace (sk-ant-…, hidden): ' ANTHROPIC_API_KEY; echo
  read -r  -p 'Analyst model (claude-sonnet-5-5 or claude-opus-5-5): '  PAID_ANALYST_MODEL
  read -r  -p 'Reviewer model (claude-sonnet-5-5 or claude-opus-5-5): ' PAID_REVIEWER_MODEL
  read -r  -p 'The spending limit you set on that Anthropic workspace, in USD (at most 15): ' PROVIDER_LIMIT_USD
  read -r  -p 'Budget for this single run, in USD (at most 3) [3]: ' RUN_BUDGET_USD
  RUN_BUDGET_USD="${RUN_BUDGET_USD:-3}"
  export RRE_SUPABASE_URL RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD \
         ANTHROPIC_API_KEY PAID_ANALYST_MODEL PAID_REVIEWER_MODEL PROVIDER_LIMIT_USD RUN_BUDGET_USD
fi

set +e
node supabase/scripts/paid-pipeline-e2e.mjs "$@"
code=$?
set -e
unset SUPABASE_ACCESS_TOKEN RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD ANTHROPIC_API_KEY
echo "exit code: $code"
exit "$code"

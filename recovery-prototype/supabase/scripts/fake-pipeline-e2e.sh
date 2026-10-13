#!/usr/bin/env bash
# Stage 2A-5d-4d — one command for the guarded fake-provider end-to-end test on STAGING,
# for a GitHub Codespace on Android. Run from recovery-prototype/:
#   bash supabase/scripts/fake-pipeline-e2e.sh                          the test
#   bash supabase/scripts/fake-pipeline-e2e.sh --disable-spending-only  recovery: spending off
# Values are asked at prompts (passwords and the access token hidden). They exist only
# inside this script's process and are gone when it ends: nothing is written to disk,
# shell history or the output. See docs/stage-2a/DEPLOY-STAGE-2A-5D-4D.md.
set -euo pipefail
[ -f supabase/scripts/fake-pipeline-e2e.mjs ] || { echo "run this from recovery-prototype/" >&2; exit 2; }
[ -d node_modules/@supabase/supabase-js ] || npm ci --no-audit --no-fund >/dev/null

echo "Staging project: aqwdwswpmbnzmkvyuqil (synthetic data only)"
read -rs -p 'Scoped Supabase access token (sbp_…, hidden): ' SUPABASE_ACCESS_TOKEN; echo
export SUPABASE_ACCESS_TOKEN
if [ "${1:-}" != --disable-spending-only ]; then
  RRE_SUPABASE_URL=https://aqwdwswpmbnzmkvyuqil.supabase.co
  read -r  -p 'Publishable key (sb_publishable_…): ' RRE_PUBLISHABLE_KEY
  read -r  -p 'Client A email: '     CLIENT_A_EMAIL
  read -rs -p 'Client A password: '  CLIENT_A_PASSWORD; echo
  read -r  -p 'Client B email: '     CLIENT_B_EMAIL
  read -rs -p 'Client B password: '  CLIENT_B_PASSWORD; echo
  read -r  -p 'Founder email: '      FOUNDER_EMAIL
  read -rs -p 'Founder password: '   FOUNDER_PASSWORD; echo
  export RRE_SUPABASE_URL RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD
fi

set +e
node supabase/scripts/fake-pipeline-e2e.mjs "$@"
code=$?
set -e
unset SUPABASE_ACCESS_TOKEN RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD
echo "exit code: $code"
exit "$code"

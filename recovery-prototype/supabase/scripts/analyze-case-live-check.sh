#!/usr/bin/env bash
# Stage 2A-5d-4c — one command for the analyze-case live check on STAGING, for a
# GitHub Codespace on Android. Run from recovery-prototype/:
#   bash supabase/scripts/analyze-case-live-check.sh
# Asks for the publishable key and the three SYNTHETIC accounts at prompts
# (passwords hidden). The values exist only inside this script's process and are
# gone when it ends: nothing is written to disk, shell history or the output.
# Exit code: 0 all pass; 1 a check failed; 2 stopped (refused, setup problem);
# 3 the platform rejected the founder's session token (report it; do not redeploy
# with --no-verify-jwt).
set -euo pipefail
[ -f supabase/scripts/analyze-case-live-check.mjs ] || { echo "run this from recovery-prototype/" >&2; exit 2; }
[ -d node_modules/@supabase/supabase-js ] || npm ci --no-audit --no-fund >/dev/null

RRE_SUPABASE_URL=https://aqwdwswpmbnzmkvyuqil.supabase.co
echo "Staging project: $RRE_SUPABASE_URL (synthetic accounts only)"
read -r  -p 'Publishable key (sb_publishable_…): ' RRE_PUBLISHABLE_KEY
read -r  -p 'Client A email: '     CLIENT_A_EMAIL
read -rs -p 'Client A password: '  CLIENT_A_PASSWORD; echo
read -r  -p 'Client B email: '     CLIENT_B_EMAIL
read -rs -p 'Client B password: '  CLIENT_B_PASSWORD; echo
read -r  -p 'Founder email: '      FOUNDER_EMAIL
read -rs -p 'Founder password: '   FOUNDER_PASSWORD; echo
export RRE_SUPABASE_URL RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD

set +e
node supabase/scripts/analyze-case-live-check.mjs
code=$?
set -e
unset RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD
echo "exit code: $code"
exit "$code"

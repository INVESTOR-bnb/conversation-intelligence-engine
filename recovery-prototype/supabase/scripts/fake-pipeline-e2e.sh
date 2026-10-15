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
if [ ! -d node_modules/@supabase/supabase-js ]; then
  echo "Installing dependencies (about a minute). Type nothing until the first prompt appears."
  npm ci --no-audit --no-fund >/dev/null
fi

# ask NAME KIND hidden|shown "PROMPT": asks until the answer passes check-input.mjs (at most three
# times), at the SAME prompt. Lines typed before the prompt appeared are discarded first (an
# Enter pressed while waiting, the rest of a paste), so no answer can land on a later prompt.
# The value goes to the checker on stdin only; nothing ever prints it.
ask() {
  local name=$1 kind=$2 mode=$3 label=$4 v problem _discard
  for _ in 1 2 3; do
    if [ -t 0 ]; then while read -r -s -t 0.05 _discard 2>/dev/null; do :; done; fi
    v=''
    if [ "$mode" = hidden ]; then read -rs -p "$label" v || true; echo; else read -r -p "$label" v || true; fi
    if problem="$(printf '%s' "$v" | node supabase/scripts/check-input.mjs "$kind" 2>&1 >/dev/null)"; then
      printf -v "$name" '%s' "$v"; export "${name?}"; v=''; return 0
    fi
    v=''
    echo "  not accepted: ${problem:-invalid} — please answer this same prompt again" >&2
  done
  echo "refused: three answers in a row were not accepted; nothing was sent" >&2
  exit 2
}

echo "Staging project: aqwdwswpmbnzmkvyuqil (synthetic data only)"
echo "Answer each prompt once, then press Enter once. A wrong answer is asked again at the same prompt."
ask SUPABASE_ACCESS_TOKEN pat hidden 'Scoped Supabase access token (sbp_…, hidden): '
if [ "${1:-}" != --disable-spending-only ]; then
  RRE_SUPABASE_URL=https://aqwdwswpmbnzmkvyuqil.supabase.co
  ask RRE_PUBLISHABLE_KEY publishable shown 'Publishable key (sb_publishable_…): '
  ask CLIENT_A_EMAIL    email    shown  'Client A email: '
  ask CLIENT_A_PASSWORD password hidden 'Client A password: '
  ask CLIENT_B_EMAIL    email    shown  'Client B email: '
  ask CLIENT_B_PASSWORD password hidden 'Client B password: '
  ask FOUNDER_EMAIL     email    shown  'Founder email: '
  ask FOUNDER_PASSWORD  password hidden 'Founder password: '
  export RRE_SUPABASE_URL
fi

set +e
node supabase/scripts/fake-pipeline-e2e.mjs "$@"
code=$?
set -e
unset SUPABASE_ACCESS_TOKEN RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD
echo "exit code: $code"
exit "$code"

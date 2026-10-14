#!/usr/bin/env bash
# Stage 2A-6d — deploys the Anthropic-CAPABLE analyze-case Edge Function to the Supabase
# STAGING project, with the FAKE provider configured. Run it yourself, from
# recovery-prototype/ in a GitHub Codespace (docs/stage-2a/DEPLOY-STAGE-2A-6D.md).
# It never runs on its own, never switches the provider, never sets a provider key, and
# never touches the database or spending.
#
#   bash supabase/scripts/deploy-analyze-case-2a6d.sh             deploy this branch's code (fake provider)
#   bash supabase/scripts/deploy-analyze-case-2a6d.sh --rollback  redeploy the previous fake-only code
#                                                                 (commit 9ee3767, what staging runs before 2A-6d)
#
# Before anything is sent it checks, and refuses (exit 2) otherwise:
#   * the checkout is the development branch, clean, identical to the pushed branch, and
#     contains Stage 2A-6c (commit 20cbdf2: approved caps, token count after dispatch);
#   * deploy: the function code passes function-source-guard.mjs (the pinned SDK only, in
#     analyze-case/index.ts; no key-shaped text; no other library; every reviewed safeguard
#     present). Rollback: the pinned fake-only code contains no provider library at all;
#   * you type the staging project reference back exactly (the only project it can target);
#   * the access token you paste (hidden) is shaped like a Supabase access token;
#   * the function's current secrets contain NO paid-provider setting (ANALYSIS_PROVIDER other
#     than fake is impossible to set from here; a key, ALLOW_PAID_PROVIDER or a model choice
#     present means a paid configuration is live: turn it off first with
#     paid-pipeline-e2e.sh --paid-off).
# Then it deploys ONLY analyze-case (never every function, never --prune) with the platform
# JWT check ON (verify_jwt = true; never --no-verify-jwt), bundled by Supabase (--use-api),
# from a throwaway project directory, and sets the fake settings: ANALYSIS_PROVIDER=fake and
# ALLOW_FAKE_PROVIDER=staging-only. The token is passed only in the CLI's environment and is
# never printed, stored or put on a command line.
set -euo pipefail

REF=aqwdwswpmbnzmkvyuqil
BRANCH=claude/revenue-recovery-engine-stage-1-8xg8vf
REQUIRED_COMMIT=20cbdf2593e496b8cce4dc7fbaf8fd4bb198fe0a # Stage 2A-6c
ROLLBACK_COMMIT=9ee3767ffbcca3706709c39469a74a19a033de62 # Stage 2A-5d-3b: the fake-only function deployed before 2A-6d
CLI=supabase@2.117.0
FN=analyze-case
PAID_SECRETS='^(ANTHROPIC_[A-Z0-9_]*|ALLOW_PAID_PROVIDER|ANALYST_MODEL|REVIEWER_MODEL)$'

refuse() { echo "REFUSED (nothing deployed): $*" >&2; exit 2; }
mode=deploy
case "${1:-}" in
  '') ;;
  --rollback) mode=rollback ;;
  *) refuse "unknown option: $1 (only --rollback)" ;;
esac

[ -f "supabase/functions/$FN/index.ts" ] && [ -d supabase/functions/_shared ] || refuse "run this from recovery-prototype/"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || refuse "the checkout is not on $BRANCH"
[ -z "$(git status --porcelain)" ] || refuse "the checkout has uncommitted or untracked changes"
git merge-base --is-ancestor "$REQUIRED_COMMIT" HEAD 2>/dev/null || refuse "the checkout does not contain Stage 2A-6c ($REQUIRED_COMMIT)"
git fetch -q origin "$BRANCH" || refuse "could not fetch $BRANCH to compare"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] || refuse "the checkout differs from the pushed branch (run: git pull --ff-only)"

work="$(mktemp -d)"
token=''
trap 'token=""; rm -rf "$work"' EXIT
mkdir -p "$work/src"
if [ "$mode" = deploy ]; then
  node supabase/scripts/function-source-guard.mjs supabase/functions >&2 || refuse "the function code failed the source guard (listed above)"
  cp -R supabase/functions "$work/src/functions"
  what="this branch's Anthropic-capable code ($(git rev-parse --short HEAD)), FAKE provider configured"
else
  git cat-file -e "$ROLLBACK_COMMIT^{commit}" 2>/dev/null || refuse "the rollback commit $ROLLBACK_COMMIT is not available in this checkout"
  git archive "$ROLLBACK_COMMIT" supabase/functions | tar -x -C "$work/src" || refuse "could not extract the rollback code"
  mv "$work/src/supabase/functions" "$work/src/functions"
  if grep -rqE '@anthropic-ai|api\.anthropic\.com|sk-ant-|ANTHROPIC_API_KEY|openai|x-api-key' "$work/src/functions"; then refuse "the rollback code contains an AI-provider SDK, endpoint or key"; fi
  what="the previous fake-only code (${ROLLBACK_COMMIT:0:7}), FAKE provider configured"
fi

echo "Function:   $FN"
echo "Code:       $what"
echo "Project:    $REF  (Supabase STAGING — the only project this script deploys to)"
echo "Settings:   ANALYSIS_PROVIDER=fake, ALLOW_FAKE_PROVIDER=staging-only; JWT check ON; no provider key; spending unchanged (disabled)"
read -r -p "Type the project reference to confirm: " typed
[ "$typed" = "$REF" ] || refuse "the project reference was not confirmed"
read -rs -p "Supabase access token (hidden): " token; echo
[[ "$token" =~ ^sbp_[A-Za-z0-9_]{20,}$ ]] || { token=''; refuse "that is not a Supabase personal access token (sbp_…)"; }

(cd "$work" && npx --yes "$CLI" init </dev/null >/dev/null) || refuse "the Supabase CLI could not prepare a project directory"
mkdir -p "$work/supabase/functions"
cp -R "$work/src/functions/$FN" "$work/src/functions/_shared" "$work/supabase/functions/"
printf '\n[functions.%s]\nverify_jwt = true\n' "$FN" >> "$work/supabase/config.toml"

cli() { SUPABASE_ACCESS_TOKEN="$token" npx --yes "$CLI" "$@" --project-ref "$REF" --workdir "$work"; }

echo "== Checking the function's current settings (names only)"
names="$(cli secrets list -o json | node -e '
  let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    try { const a = JSON.parse(s); if (!Array.isArray(a)) throw 0; console.log(a.map((x) => String(x && x.name)).join("\n")); }
    catch { process.exit(1); }
  });')" || refuse "could not read the function settings to check them (nothing deployed)"
if grep -qE "$PAID_SECRETS" <<<"$names"; then
  refuse "a paid-provider setting is present on the project ($(grep -cE "$PAID_SECRETS" <<<"$names") found; values not shown). Turn it off first: bash supabase/scripts/paid-pipeline-e2e.sh --paid-off"
fi

echo "== Deploying $FN to $REF"
cli functions deploy "$FN" --use-api || { echo "DEPLOY FAILED: nothing else was changed. Send this output." >&2; exit 1; }
echo "== Setting the function's provider settings (fake, staging only)"
cli secrets set ANALYSIS_PROVIDER=fake ALLOW_FAKE_PROVIDER=staging-only \
  || { echo "SETTINGS FAILED: the function is deployed; if it answers PROVIDER_NOT_CONFIGURED, re-run this script. Send this output." >&2; exit 1; }
echo "Done: $FN deployed to $REF ($what)."
echo "Next: bash supabase/scripts/analyze-case-live-check.sh (security check), then the fake e2e test if approved."

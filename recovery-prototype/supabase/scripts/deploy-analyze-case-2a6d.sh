#!/usr/bin/env bash
# Deploys the analyze-case Edge Function CODE to the Supabase STAGING project
# (docs/stage-2a/DEPLOY-STAGE-2A-6D.md). It never runs on its own, never touches the database
# or spending, never sets a provider key, and never enables a paid provider.
#
#   bash supabase/scripts/deploy-analyze-case-2a6d.sh             deploy this branch's code; the function's
#                                                                 provider settings are LEFT AS THEY ARE
#   bash supabase/scripts/deploy-analyze-case-2a6d.sh --set-fake  deploy this branch's code AND set the fake
#                                                                 provider (refused while a paid setting is present)
#   bash supabase/scripts/deploy-analyze-case-2a6d.sh --rollback  redeploy the previous fake-only code (commit
#                                                                 9ee3767) with the fake settings (refused likewise)
#
# A plain deploy never replaces a paid (Kimi) configuration with the fake provider: it does not
# write any setting. If the function has no provider settings at all it refuses every call
# (503 PROVIDER_NOT_CONFIGURED: fail closed); the script says so. Switching from a paid provider
# to the fake one is always explicit: turn the paid settings off first (the staging-paid
# workflow's "deactivate-and-remove-key", or paid-pipeline-e2e.sh --paid-off), then --set-fake.
#
# Before anything is sent it checks, and refuses (exit 2) otherwise:
#   * the checkout is the development branch, clean, and contains Stage 2A-6c (commit 20cbdf2);
#     interactively it must equal the pushed branch; non-interactively (GitHub Actions) it must
#     be exactly the commit the workflow was started for ($GITHUB_SHA);
#   * deploy: the function code passes function-source-guard.mjs. Rollback: the pinned fake-only
#     code contains no provider library at all;
#   * the project reference is confirmed exactly (typed, or CONFIRM_PROJECT_REF non-interactively);
#   * the access token (typed hidden, or SUPABASE_ACCESS_TOKEN non-interactively) is shaped like a
#     Supabase access token;
#   * --set-fake / --rollback: the function's current secrets contain NO paid-provider setting.
# Then it deploys ONLY analyze-case (never every function, never --prune) with the platform
# JWT check ON (verify_jwt = true; never --no-verify-jwt), bundled by Supabase (--use-api),
# from a throwaway project directory. The token is passed only in the CLI's environment and is
# never printed, stored or put on a command line.
#
# Non-interactive mode (GitHub Actions only): RRE_NONINTERACTIVE=1 with CONFIRM_PROJECT_REF and
# SUPABASE_ACCESS_TOKEN in the environment (never on the command line).
set -euo pipefail

REF=aqwdwswpmbnzmkvyuqil
BRANCH=claude/revenue-recovery-engine-stage-1-8xg8vf
REQUIRED_COMMIT=20cbdf2593e496b8cce4dc7fbaf8fd4bb198fe0a # Stage 2A-6c
ROLLBACK_COMMIT=9ee3767ffbcca3706709c39469a74a19a033de62 # Stage 2A-5d-3b: the fake-only function deployed before 2A-6d
CLI=supabase@2.117.0
FN=analyze-case
PAID_SECRETS='^(ANTHROPIC_[A-Z0-9_]*|KIMI_[A-Z0-9_]*|ALLOW_PAID_PROVIDER|ANALYST_MODEL|REVIEWER_MODEL)$'

refuse() { echo "REFUSED (nothing deployed): $*" >&2; exit 2; }
mode=deploy
set_fake=0
case "${1:-}" in
  '') ;;
  --set-fake) set_fake=1 ;;
  --rollback) mode=rollback; set_fake=1 ;;
  *) refuse "unknown option: $1 (only --set-fake or --rollback)" ;;
esac
[ "$#" -le 1 ] || refuse "only one option at a time"
noninteractive=0
[ "${RRE_NONINTERACTIVE:-}" = 1 ] && noninteractive=1

[ -f "supabase/functions/$FN/index.ts" ] && [ -d supabase/functions/_shared ] || refuse "run this from recovery-prototype/"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || refuse "the checkout is not on $BRANCH"
[ -z "$(git status --porcelain)" ] || refuse "the checkout has uncommitted or untracked changes"
git merge-base --is-ancestor "$REQUIRED_COMMIT" HEAD 2>/dev/null || refuse "the checkout does not contain Stage 2A-6c ($REQUIRED_COMMIT)"
if [ "$noninteractive" = 1 ]; then
  [ -n "${GITHUB_SHA:-}" ] && [ "$(git rev-parse HEAD)" = "$GITHUB_SHA" ] || refuse "non-interactive mode: the checkout is not the commit this workflow run was started for"
else
  git fetch -q origin "$BRANCH" || refuse "could not fetch $BRANCH to compare"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] || refuse "the checkout differs from the pushed branch (run: git pull --ff-only)"
fi

work="$(mktemp -d)"
token=''
trap 'token=""; rm -rf "$work"' EXIT
mkdir -p "$work/src"
if [ "$mode" = deploy ]; then
  node supabase/scripts/function-source-guard.mjs supabase/functions >&2 || refuse "the function code failed the source guard (listed above)"
  cp -R supabase/functions "$work/src/functions"
  what="this branch's code ($(git rev-parse --short HEAD))"
else
  git cat-file -e "$ROLLBACK_COMMIT^{commit}" 2>/dev/null || refuse "the rollback commit $ROLLBACK_COMMIT is not available in this checkout"
  git archive "$ROLLBACK_COMMIT" supabase/functions | tar -x -C "$work/src" || refuse "could not extract the rollback code"
  mv "$work/src/supabase/functions" "$work/src/functions"
  if grep -rqE '@anthropic-ai|api\.anthropic\.com|sk-ant-|ANTHROPIC_API_KEY|api\.moonshot\.ai|KIMI_API_KEY|openai|x-api-key' "$work/src/functions"; then refuse "the rollback code contains an AI-provider SDK, endpoint or key"; fi
  what="the previous fake-only code (${ROLLBACK_COMMIT:0:7})"
fi

if [ "$set_fake" = 1 ]; then settings="SET to the fake provider (ANALYSIS_PROVIDER=fake, ALLOW_FAKE_PROVIDER=staging-only)"
else settings="UNCHANGED (whatever provider is configured stays configured)"; fi
echo "Function:   $FN"
echo "Code:       $what"
echo "Project:    $REF  (Supabase STAGING — the only project this script deploys to)"
echo "Settings:   $settings; JWT check ON; no provider key written; spending untouched"
if [ "$noninteractive" = 1 ]; then
  typed="${CONFIRM_PROJECT_REF:-}"
  token="${SUPABASE_ACCESS_TOKEN:-}"
else
  read -r -p "Type the project reference to confirm: " typed
fi
[ "$typed" = "$REF" ] || refuse "the project reference was not confirmed"
[ "$noninteractive" = 1 ] || { read -rs -p "Supabase access token (hidden): " token; echo; }
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
paid_present=$(grep -cE "$PAID_SECRETS" <<<"$names" || true)
if [ "$set_fake" = 1 ] && [ "$paid_present" -gt 0 ]; then
  refuse "a paid-provider setting is present on the project ($paid_present found; values not shown). The fake provider is never set over a paid configuration: turn it off first (staging-paid workflow: deactivate-and-remove-key, or bash supabase/scripts/paid-pipeline-e2e.sh --paid-off)"
fi

echo "== Deploying $FN to $REF"
cli functions deploy "$FN" --use-api || { echo "DEPLOY FAILED: nothing else was changed. Send this output." >&2; exit 1; }
if [ "$set_fake" = 1 ]; then
  echo "== Setting the function's provider settings (fake, staging only) — requested with $1"
  cli secrets set ANALYSIS_PROVIDER=fake ALLOW_FAKE_PROVIDER=staging-only \
    || { echo "SETTINGS FAILED: the function is deployed; if it answers PROVIDER_NOT_CONFIGURED, re-run this script. Send this output." >&2; exit 1; }
  echo "Done: $FN deployed to $REF ($what), fake provider set."
else
  if grep -qx 'ANALYSIS_PROVIDER' <<<"$names"; then
    echo "Done: $FN deployed to $REF ($what). Provider settings untouched ($paid_present paid setting(s) present; values not shown)."
  else
    echo "Done: $FN deployed to $REF ($what). WARNING: no ANALYSIS_PROVIDER is set, so the function refuses every call (503 PROVIDER_NOT_CONFIGURED) until a provider is configured."
  fi
fi

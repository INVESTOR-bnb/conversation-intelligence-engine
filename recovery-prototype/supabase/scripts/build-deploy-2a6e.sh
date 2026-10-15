#!/usr/bin/env bash
# Builds supabase/deploy/stage2a6e_deploy.sql: the Stage 2A-6e migration,
# byte-for-byte, wrapped in ONE transaction with a preflight and a post-install
# self-check. Run with --check to verify the committed file is up to date.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/deploy/stage2a6e_deploy.sql"
MIGRATION=20261021120000_stage2a6e_kimi_price.sql

generate() {
  local hash; hash="$(sha256sum "$HERE/migrations/$MIGRATION" | cut -d' ' -f1)"
  cat <<HEADER
-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6e DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a6e.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-6a. Adds ONE price row to private.ai_model_prices, INACTIVE:
-- kimi-k3 (USD 3 input / 15 output per million tokens; no cached-input
-- discount), output cap 8000. An inactive model cannot be reserved, so nothing
-- can be spent on it. Changes no function, table, policy, privilege, setting,
-- existing price or data; the budget (20), stop (18), per-analysis limit (1)
-- and the DISABLED state stay. No AI is connected. All-or-nothing. Contains no
-- credentials. Refuses to run unless 2A-6a is applied and spending is
-- disabled, or if the row already exists. Independent of Stage 2A-6c.
-- Undo: deploy/stage2a6e_rollback.sql. Check: deploy/stage2a6e_verify.sql.
--
-- Source migration (sha256):
--   $MIGRATION  $hash
-- ===================================================================

begin;

HEADER
  cat "$HERE/deploy/parts-2a6e/10_preflight.sql"
  echo
  echo "-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION $MIGRATION >>>>>>>>>>>>>>>>>>>>"
  cat "$HERE/migrations/$MIGRATION"
  echo "-- <<<<<<<<<<<<<<<<<<<< END MIGRATION $MIGRATION <<<<<<<<<<<<<<<<<<<<"
  echo
  cat "$HERE/deploy/parts-2a6e/90_postcheck.sql"
  echo
  echo "insert into public.audit_log (actor, actor_role, action, details)"
  echo "values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-6e', 'migrations', jsonb_build_array("
  echo "  jsonb_build_object('file', '$MIGRATION', 'sha256', '$hash'))));"
  echo
  echo "commit;"
  echo "-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run."
}

if [ "${1:-}" = "--check" ]; then
  if diff -q <(generate) "$OUT" >/dev/null; then echo "deploy file is up to date"; else echo "deploy file is OUT OF DATE: run supabase/scripts/build-deploy-2a6e.sh"; exit 1; fi
else
  generate > "$OUT"; echo "wrote $OUT"
fi

#!/usr/bin/env bash
# Builds supabase/deploy/stage2a5d3a_deploy.sql: the Stage 2A-5d-3a migration,
# byte-for-byte, wrapped in ONE transaction with a preflight and a post-install
# self-check. Run with --check to verify the committed file is up to date.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/deploy/stage2a5d3a_deploy.sql"
MIGRATION=20261018120000_stage2a5d3a_ai_spending.sql

generate() {
  local hash; hash="$(sha256sum "$HERE/migrations/$MIGRATION" | cut -d' ' -f1)"
  cat <<HEADER
-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5d-3a DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a5d3a.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-5d-2. AI spending controls (database only): three private
-- tables (configuration, model prices, spending ledger), reservation before
-- any provider call, a dispatch record before each call, settlement from that
-- record, a founder-only summary. Spending is DISABLED after deployment (USD 20
-- budget, stop at USD 18, USD 1 per analysis, 10/founder/24h, 3/case/24h, 10/case).
-- internal_complete_analysis and founder_abandon_analysis gain settlement only.
-- No AI is connected; only the fake provider (price 0) is priced. No existing
-- data is changed. All-or-nothing. Contains no credentials.
-- Refuses to run unless 2A-5d-2 is applied and both functions are exactly the
-- reviewed versions, or if 2A-5d-3a is already applied.
-- Undo: deploy/stage2a5d3a_rollback.sql. Check: deploy/stage2a5d3a_verify.sql.
--
-- Source migration (sha256):
--   $MIGRATION  $hash
-- ===================================================================

begin;

HEADER
  cat "$HERE/deploy/parts-2a5d3a/10_preflight.sql"
  echo
  echo "-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION $MIGRATION >>>>>>>>>>>>>>>>>>>>"
  cat "$HERE/migrations/$MIGRATION"
  echo "-- <<<<<<<<<<<<<<<<<<<< END MIGRATION $MIGRATION <<<<<<<<<<<<<<<<<<<<"
  echo
  cat "$HERE/deploy/parts-2a5d3a/90_postcheck.sql"
  echo
  echo "insert into public.audit_log (actor, actor_role, action, details)"
  echo "values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-5d-3a', 'migrations', jsonb_build_array("
  echo "  jsonb_build_object('file', '$MIGRATION', 'sha256', '$hash'))));"
  echo
  echo "commit;"
  echo "-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run."
}

if [ "${1:-}" = "--check" ]; then
  if diff -q <(generate) "$OUT" >/dev/null; then echo "deploy file is up to date"; else echo "deploy file is OUT OF DATE: run supabase/scripts/build-deploy-2a5d3a.sh"; exit 1; fi
else
  generate > "$OUT"; echo "wrote $OUT"
fi

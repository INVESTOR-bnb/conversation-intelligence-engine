#!/usr/bin/env bash
# Builds supabase/deploy/stage2a5d2_deploy.sql: the Stage 2A-5d-2 migration,
# byte-for-byte, wrapped in ONE transaction with a preflight and a post-install
# self-check. Run with --check to verify the committed file is up to date.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/deploy/stage2a5d2_deploy.sql"
MIGRATION=20261017120000_stage2a5d2_adversarial_review.sql

generate() {
  local hash; hash="$(sha256sum "$HERE/migrations/$MIGRATION" | cut -d' ' -f1)"
  cat <<HEADER
-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5d-2 DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a5d2.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-5d-1. Analysis contract rre-analysis/2: an independent
-- adversarial review section (challenges to observations, hypotheses and the
-- recommendation, with severity, evidence references validated against the
-- evidence snapshot, and a verdict). A verdict rejecting the recommendation
-- leaves no contact message stored. rre-analysis/1 stays valid. Replaces the
-- body of one private function (private.analysis_output_problems; same
-- signature and privileges). No table, policy, privilege or trigger changes.
-- Connects no AI. No data is changed. All-or-nothing. Contains no credentials.
-- Refuses to run unless the contract is exactly the reviewed 2A-5d-1
-- version, or if 2A-5d-2 is already applied.
-- Undo: deploy/stage2a5d2_rollback.sql. Check: deploy/stage2a5d2_verify.sql.
--
-- Source migration (sha256):
--   $MIGRATION  $hash
-- ===================================================================

begin;

HEADER
  cat "$HERE/deploy/parts-2a5d2/10_preflight.sql"
  echo
  echo "-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION $MIGRATION >>>>>>>>>>>>>>>>>>>>"
  cat "$HERE/migrations/$MIGRATION"
  echo "-- <<<<<<<<<<<<<<<<<<<< END MIGRATION $MIGRATION <<<<<<<<<<<<<<<<<<<<"
  echo
  cat "$HERE/deploy/parts-2a5d2/90_postcheck.sql"
  echo
  echo "insert into public.audit_log (actor, actor_role, action, details)"
  echo "values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-5d-2', 'migrations', jsonb_build_array("
  echo "  jsonb_build_object('file', '$MIGRATION', 'sha256', '$hash'))));"
  echo
  echo "commit;"
  echo "-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run."
}

if [ "${1:-}" = "--check" ]; then
  if diff -q <(generate) "$OUT" >/dev/null; then echo "deploy file is up to date"; else echo "deploy file is OUT OF DATE: run supabase/scripts/build-deploy-2a5d2.sh"; exit 1; fi
else
  generate > "$OUT"; echo "wrote $OUT"
fi

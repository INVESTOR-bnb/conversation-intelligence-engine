#!/usr/bin/env bash
# Builds supabase/deploy/stage2a4c_deploy.sql: the Stage 2A-4c migration,
# byte-for-byte, wrapped in ONE transaction with a preflight and a post-install
# self-check. Run with --check to verify the committed file is up to date.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/deploy/stage2a4c_deploy.sql"
MIGRATION=20261012120000_stage2a4c_screenshots.sql

generate() {
  local hash; hash="$(sha256sum "$HERE/migrations/$MIGRATION" | cut -d' ' -f1)"
  cat <<HEADER
-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4c DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a4c.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-4b. Adds: the private bucket case-screenshots (5 MB,
-- PNG/JPEG), two storage policies (member upload rule, founder read), three
-- functions, and the nullable column case_screenshots.file_deleted_at.
-- No data is changed. All-or-nothing. Contains no credentials.
-- Refuses to run if 2A-4b is missing, if 2A-4c is already applied, or if
-- storage.objects already has policies.
-- Undo: deploy/stage2a4c_rollback.sql. Check: deploy/stage2a4c_verify.sql.
--
-- Source migration (sha256):
--   $MIGRATION  $hash
-- ===================================================================

begin;

HEADER
  cat "$HERE/deploy/parts-2a4c/10_preflight.sql"
  echo
  echo "-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION $MIGRATION >>>>>>>>>>>>>>>>>>>>"
  cat "$HERE/migrations/$MIGRATION"
  echo "-- <<<<<<<<<<<<<<<<<<<< END MIGRATION $MIGRATION <<<<<<<<<<<<<<<<<<<<"
  echo
  cat "$HERE/deploy/parts-2a4c/90_postcheck.sql"
  echo
  echo "insert into public.audit_log (actor, actor_role, action, details)"
  echo "values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-4c', 'migrations', jsonb_build_array("
  echo "  jsonb_build_object('file', '$MIGRATION', 'sha256', '$hash'))));"
  echo
  echo "commit;"
  echo "-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run."
}

if [ "${1:-}" = "--check" ]; then
  if diff -q <(generate) "$OUT" >/dev/null; then echo "deploy file is up to date"; else echo "deploy file is OUT OF DATE: run supabase/scripts/build-deploy-2a4c.sh"; exit 1; fi
else
  generate > "$OUT"; echo "wrote $OUT"
fi

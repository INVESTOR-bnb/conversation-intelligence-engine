#!/usr/bin/env bash
# Builds supabase/deploy/stage2a1_deploy.sql: the three Stage 2A-1 migrations,
# byte-for-byte, wrapped in ONE transaction with a preflight guard and a
# post-install self-check. Run with --check to verify the committed file is
# up to date (used by the test suite).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/deploy/stage2a1_deploy.sql"
MIGRATIONS=(
  20261009120000_stage2a1_schema.sql
  20261009120100_stage2a1_security.sql
  20261009120200_stage2a1_functions.sql
)

generate() {
  local hashes=()
  for m in "${MIGRATIONS[@]}"; do hashes+=("$(sha256sum "$HERE/migrations/$m" | cut -d' ' -f1)"); done
  cat <<HEADER
-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-1 DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query.
-- All-or-nothing: if anything fails, nothing is changed.
-- Creates no users, no founder, no data; contains no credentials.
-- Refuses to run if Stage 2A-1 is already installed or schema public is not empty.
--
-- Source migrations (sha256):
HEADER
  for i in "${!MIGRATIONS[@]}"; do echo "--   ${MIGRATIONS[$i]}  ${hashes[$i]}"; done
  echo "-- ==================================================================="
  echo
  echo "begin;"
  echo
  cat "$HERE/deploy/parts/10_preflight_guard.sql"
  for i in "${!MIGRATIONS[@]}"; do
    echo
    echo "-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION ${MIGRATIONS[$i]} >>>>>>>>>>>>>>>>>>>>"
    cat "$HERE/migrations/${MIGRATIONS[$i]}"
    echo "-- <<<<<<<<<<<<<<<<<<<< END MIGRATION ${MIGRATIONS[$i]} <<<<<<<<<<<<<<<<<<<<"
  done
  echo
  cat "$HERE/deploy/parts/90_postinstall_check.sql"
  echo
  echo "insert into public.audit_log (actor, actor_role, action, details)"
  echo "values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-1', 'migrations', jsonb_build_array("
  for i in "${!MIGRATIONS[@]}"; do
    sep=","; [ "$i" = "$((${#MIGRATIONS[@]} - 1))" ] && sep=""
    echo "  jsonb_build_object('file', '${MIGRATIONS[$i]}', 'sha256', '${hashes[$i]}')$sep"
  done
  echo ")));"
  echo
  echo "commit;"
  echo "-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run."
}

if [ "${1:-}" = "--check" ]; then
  if diff -q <(generate) "$OUT" >/dev/null; then echo "deploy file is up to date"; else echo "deploy file is OUT OF DATE: run supabase/scripts/build-deploy.sh"; exit 1; fi
else
  generate > "$OUT"; echo "wrote $OUT"
fi

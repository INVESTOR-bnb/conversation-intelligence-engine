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

KNOWN="$HERE/deploy/known/rls_auto_enable.verified.sql"

# Function body (prosrc) of the verified pre-existing helper: the text between
# "AS $function$" and the closing "$function$" of the pg_get_functiondef output.
verified_body() {
  python3 -I - "$KNOWN" <<'PY'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
start = src.find("AS $function$")
end = src.rfind("$function$")
if start < 0 or end <= start + len("AS $function$"):
    sys.exit("verified definition is malformed: " + sys.argv[1])
body = src[start + len("AS $function$"):end]
if "$verified_rls_auto_enable$" in body or "__VERIFIED_RLS_AUTO_ENABLE_BODY__" in body:
    sys.exit("verified body contains a reserved delimiter")
sys.stdout.write(body)
PY
}

guard() {
  python3 -I - "$HERE/deploy/parts/10_preflight_guard.sql" <(verified_body) <<'PY'
import sys
guard = open(sys.argv[1], encoding="utf-8").read()
body = open(sys.argv[2], encoding="utf-8").read()
if guard.count("__VERIFIED_RLS_AUTO_ENABLE_BODY__") != 1 or not body.strip():
    sys.exit("cannot inject verified body into the preflight guard")
sys.stdout.write(guard.replace("__VERIFIED_RLS_AUTO_ENABLE_BODY__", body))
PY
}

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
  echo "-- Verified pre-existing object (left unchanged):"
  echo "--   deploy/known/rls_auto_enable.verified.sql  $(sha256sum "$KNOWN" | cut -d' ' -f1)"
  echo "-- ==================================================================="
  echo
  echo "begin;"
  echo
  guard
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
  echo "), 'preexisting_rls_auto_enable', case when current_setting('rre.rls_auto_enable_fingerprint', true) <> '' then"
  echo "  jsonb_build_object('fingerprint', current_setting('rre.rls_auto_enable_fingerprint', true),"
  echo "                     'body_md5', current_setting('rre.rls_auto_enable_body_md5', true)) end));"
  echo
  echo "commit;"
  echo "-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run."
}

if [ "${1:-}" = "--check" ]; then
  if diff -q <(generate) "$OUT" >/dev/null; then echo "deploy file is up to date"; else echo "deploy file is OUT OF DATE: run supabase/scripts/build-deploy.sh"; exit 1; fi
else
  generate > "$OUT"; echo "wrote $OUT"
fi

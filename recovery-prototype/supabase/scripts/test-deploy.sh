#!/usr/bin/env bash
# Tests the all-or-nothing deployment file and the verification script against
# throwaway local PostgreSQL databases with the minimal Supabase emulation.
# No network, no secrets. Cannot prove Supabase-specific behaviour (see docs).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$HERE/deploy/stage2a1_deploy.sql"
VERIFY="$HERE/deploy/stage2a1_verify.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54330}"
WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi
cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUNAS[@]}" "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -X -q)
# Statement-by-statement execution (stops at the first error).
run_file() { "${PSQL[@]}" -d "$1" -v ON_ERROR_STOP=1 < "$2" 2>&1; }
# Whole file as ONE query message (simple-query protocol), like a web SQL editor.
run_single() { "${PSQL[@]}" -d "$1" -c "$(cat "$2")" 2>&1; }
sql() { "${PSQL[@]}" -d "$1" -At -c "$2"; }
snapshot() { "${RUNAS[@]}" "$PGBIN/pg_dump" -h "$WORK" -p "$PORT" -U postgres --schema-only "$1" | grep -v '^\\restrict\|^\\unrestrict' | md5sum | cut -d' ' -f1; }
installed_objects() { sql "$1" "select (to_regclass('public.cases') is not null)::int + (to_regnamespace('private') is not null)::int + (to_regtype('public.workflow_state') is not null)::int"; }
verify_overall() { "${PSQL[@]}" -d "$1" -At -F '|' < "$VERIFY" | awk -F'|' '$2=="OVERALL"{print $3" ("$4")"}'; }
verify_status_of() { "${PSQL[@]}" -d "$1" -At -F '|' < "$VERIFY" | awk -F'|' -v n="$2" '$1==n{print $3}'; }

# Called via $(...) (a subshell), so names must be unique without shared state.
# Fails loudly rather than silently reusing a database.
fresh_db() {
  local db="t_$(date +%s%N)_$RANDOM"
  sql postgres "create database $db" >/dev/null || { echo "cannot create database" >&2; exit 1; }
  if [ "${1:-emulate}" = emulate ]; then run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }; fi
  echo "$db"
}

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

# Roles are cluster-wide: use a copy of the emulation whose CREATE ROLEs tolerate re-runs.
EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 3 ] || { echo "could not prepare emulation copy"; exit 1; }

echo "== Generated file"
check "deploy file matches the three migrations (build --check)" '"$HERE/scripts/build-deploy.sh" --check >/dev/null'
check "deploy file contains exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$DEPLOY")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$DEPLOY")" = 1 ]'
check "deploy file creates no users and contains no credentials" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|eyJhbGci" "$DEPLOY" >/dev/null'
check "deploy file never disables RLS or triggers" '! grep -niE "disable row level security|disable trigger|no force row level|session_replication_role" "$DEPLOY" >/dev/null'

echo "== Verification script before deployment"
db=$(fresh_db)
check "verification runs on an empty database and reports OVERALL FAIL" '[[ "$(verify_overall "$db")" == FAIL* ]]'

echo "== Clean deployment (statement mode)"
db=$(fresh_db); before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "schema fingerprint is real (empty and deployed databases differ; dump not empty)" '[ "$(snapshot "$db")" != "$before" ] && [ "$before" != "$(printf "" | md5sum | cut -d" " -f1)" ]'
check "deployment succeeds" '[ "$(installed_objects "$db")" = 3 ] && ! grep -q ERROR <<<"$out"'
check "preflight and post-install self-check both ran" 'grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "verification: OVERALL PASS with 0 fail" '[[ "$(verify_overall "$db")" == "PASS ("*" 0 fail"* ]]'
check "no users, founders or business data created" '[ "$(sql "$db" "select (select count(*) from auth.users)+(select count(*) from public.founders)+(select count(*) from public.businesses)+(select count(*) from public.cases)")" = 0 ]'
check "deployment recorded once in the audit log with migration hashes" '[ "$(sql "$db" "select count(*) from public.audit_log where action = '"'"'SCHEMA_DEPLOYED'"'"' and jsonb_array_length(details->'"'"'migrations'"'"') = 3")" = 1 ]'
installed="$db"

echo "== Re-running on an installed database"
snap=$(snapshot "$installed")
out=$(run_file "$installed" "$DEPLOY" || true)
check "second run is refused as already installed" 'grep -q "already installed" <<<"$out"'
check "refused run changed nothing" '[ "$(snapshot "$installed")" = "$snap" ]'
out=$(run_single "$installed" "$DEPLOY" || true)
check "refused in single-message mode too, nothing changed" 'grep -q "already installed" <<<"$out" && [ "$(snapshot "$installed")" = "$snap" ]'

echo "== Clean deployment (single-message mode, like the SQL Editor)"
db=$(fresh_db)
out=$(run_single "$db" "$DEPLOY" || true)
check "single-message deployment succeeds and verifies" '[ "$(installed_objects "$db")" = 3 ] && [[ "$(verify_overall "$db")" == "PASS ("*" 0 fail"* ]]'

echo "== Deliberate failures roll back everything"
broken="$WORK/broken.sql"
# Failure late in the file: after all three migrations, just before the self-check.
awk '/POST-INSTALL SELF-CHECK/ && !done {print "select 1/0; -- deliberate failure"; done=1} {print}' "$DEPLOY" > "$broken"
check "deliberate failure was injected after the migrations" '[ "$(grep -c "deliberate failure" "$broken")" = 1 ] && [ "$(grep -n "deliberate failure" "$broken" | cut -d: -f1)" -gt "$(grep -n "END MIGRATION 20261009120200" "$broken" | cut -d: -f1)" ]'
for mode in run_file run_single; do
  db=$(fresh_db); before=$(snapshot "$db")
  out=$($mode "$db" "$broken" || true)
  check "[$mode] late failure reports an error" 'grep -q "division by zero" <<<"$out"'
  check "[$mode] late failure leaves the database exactly as before" '[ "$(installed_objects "$db")" = 0 ] && [ "$(snapshot "$db")" = "$before" ]'
done

# Weakened security after the migrations: the post-install self-check must abort.
awk '/POST-INSTALL SELF-CHECK/ && !done {print "grant insert on public.cases to authenticated; -- simulated weakness"; done=1} {print}' "$DEPLOY" > "$broken"
db=$(fresh_db); before=$(snapshot "$db")
out=$(run_file "$db" "$broken" || true)
check "self-check aborts a deployment with weakened privileges" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(installed_objects "$db")" = 0 ] && [ "$(snapshot "$db")" = "$before" ]'

# Incomplete copy (as from a truncated paste): everything after the self-check is missing, including COMMIT.
head -n "$(grep -n "POST-INSTALL SELF-CHECK" "$DEPLOY" | head -1 | cut -d: -f1)" "$DEPLOY" > "$broken"
for mode in run_file run_single; do
  db=$(fresh_db); before=$(snapshot "$db")
  $mode "$db" "$broken" >/dev/null 2>&1 || true
  check "[$mode] truncated copy without COMMIT leaves nothing behind" '[ "$(installed_objects "$db")" = 0 ] && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(fresh_db); sql "$db" "create table public.unrelated (id int)" >/dev/null; before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when schema public already holds unrelated objects (and changes nothing)" 'grep -q "schema public is not empty: table unrelated" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(fresh_db noemulate); before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses on a non-Supabase database (no auth schema) and changes nothing" 'grep -q "auth.users is missing" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses"
sql "$installed" "grant insert on public.cases to authenticated" >/dev/null
check "detects a direct write grant (check 5 FAIL, OVERALL FAIL)" '[ "$(verify_status_of "$installed" 5)" = FAIL ] && [[ "$(verify_overall "$installed")" == FAIL* ]]'
sql "$installed" "revoke insert on public.cases from authenticated; alter table public.analyses disable row level security" >/dev/null
check "detects a table with RLS disabled (check 3 FAIL)" '[ "$(verify_status_of "$installed" 3)" = FAIL ]'
sql "$installed" "alter table public.analyses enable row level security; grant execute on function public.client_list_cases() to anon" >/dev/null
check "detects a function executable by anon (check 9 FAIL)" '[ "$(verify_status_of "$installed" 9)" = FAIL ]'
sql "$installed" "revoke execute on function public.client_list_cases() from anon; alter table public.approvals disable trigger approvals_immutable" >/dev/null
check "detects a disabled immutability trigger (check 14 FAIL)" '[ "$(verify_status_of "$installed" 14)" = FAIL ]'
sql "$installed" "alter table public.approvals enable trigger approvals_immutable" >/dev/null
check "verification returns to OVERALL PASS after reverting" '[[ "$(verify_overall "$installed")" == "PASS ("*" 0 fail"* ]]'
check "verification script itself made no changes (read-only)" 's1=$(snapshot "$installed"); verify_overall "$installed" >/dev/null; [ "$(snapshot "$installed")" = "$s1" ]'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

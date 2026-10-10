#!/usr/bin/env bash
# Tests the Stage 2A-4b deployment, verification and rollback files against
# throwaway local PostgreSQL databases that first get Stage 2A-1 installed via
# deploy/stage2a1_deploy.sql. No network, no secrets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$HERE/deploy/stage2a1_deploy.sql"
BASE_VERIFY="$HERE/deploy/stage2a1_verify.sql"
DEPLOY="$HERE/deploy/stage2a4b_deploy.sql"
VERIFY="$HERE/deploy/stage2a4b_verify.sql"
ROLLBACK="$HERE/deploy/stage2a4b_rollback.sql"
KNOWN="$HERE/deploy/known/rls_auto_enable.verified.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54331}"
WORK="$(mktemp -d)"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); chown postgres "$WORK"; fi
cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUNAS[@]}" "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -X -q)
run_file() { "${PSQL[@]}" -d "$1" -v ON_ERROR_STOP=1 < "$2" 2>&1; }
run_single() { "${PSQL[@]}" -d "$1" -c "$(cat "$2")" 2>&1; }
sql() { "${PSQL[@]}" -d "$1" -At -c "$2"; }
snapshot() { "${RUNAS[@]}" "$PGBIN/pg_dump" -h "$WORK" -p "$PORT" -U postgres --schema-only "$1" | grep -v '^\\restrict\|^\\unrestrict' | md5sum | cut -d' ' -f1; }
# The four case-table policies, as the catalog sees them.
policies() { sql "$1" "select string_agg(tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'||roles::text||'|'||qual, E'\n' order by tablename) from pg_policies where schemaname = 'public' and tablename in ('cases','case_messages','case_screenshots','outcomes')"; }
overall() { "${PSQL[@]}" -d "$1" -At -F '|' < "$2" | awk -F'|' '$2=="OVERALL"{print $3" ("$4")"}'; }
status_of() { "${PSQL[@]}" -d "$1" -At -F '|' < "$VERIFY" | awk -F'|' -v n="$2" '$1==n{print $3}'; }
base_status_of() { "${PSQL[@]}" -d "$1" -At -F '|' < "$BASE_VERIFY" | awk -F'|' -v n="$2" '$1==n{print $3}'; }
data_rows() { sql "$1" "select (select count(*) from public.businesses)||'/'||(select count(*) from public.cases)||'/'||(select count(*) from public.case_messages)||'/'||(select count(*) from public.outcomes)"; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 4 ] || { echo "could not prepare emulation copy"; exit 1; }

# new_db [helper] [no2a1]: emulation (+ optional Supabase helper) + Stage 2A-1.
new_db() {
  local db="t_$(date +%s%N)_$RANDOM"
  sql postgres "create database $db" >/dev/null
  run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }
  if [ "${1:-}" = helper ]; then
    run_file "$db" "$KNOWN" >/dev/null
    sql "$db" "create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable()" >/dev/null
  fi
  if [ "${2:-}" != no2a1 ]; then run_file "$db" "$BASE" >/dev/null || { echo "2A-1 install failed" >&2; exit 1; }; fi
  echo "$db"
}

echo "== Generated file"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a4b.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n contains no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, triggers or grants write access" '! grep -niE "disable row level security|disable trigger|no force row level|session_replication_role|grant (insert|update|delete|all)" "$f" >/dev/null'
  check "$n touches policies only (no table, column, function or data changes)" '! grep -niE "^\s*(alter table|create table|drop table|create (or replace )?function|drop function|update public|delete from)" "$f" >/dev/null'
done

echo "== Before deployment"
db=$(new_db); base_policies=$(policies "$db")
check "2A-4b verification reports FAIL on a 2A-1-only database" '[[ "$(overall "$db" "$VERIFY")" == FAIL* ]] && [ "$(status_of "$db" 1)" = FAIL ]'
fresh21="$db"

echo "== Deployment (statement mode) on 2A-1 with synthetic data"
db=$(new_db)
sql "$db" "insert into public.businesses (name) values ('Synthetic Data Co')" >/dev/null
rows_before=$(data_rows "$db"); before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds; preflight and self-check ran" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "schema changed (policies replaced)" '[ "$(snapshot "$db")" != "$before" ]'
check "2A-4b verification: OVERALL PASS, 0 fail" '[[ "$(overall "$db" "$VERIFY")" == "PASS ("*" 0 fail"* ]]'
check "2A-1 verification still OVERALL PASS" '[[ "$(overall "$db" "$BASE_VERIFY")" == "PASS ("*" 0 fail"* ]]'
check "no data changed" '[ "$(data_rows "$db")" = "$rows_before" ]'
check "deployment recorded once in the audit log" '[ "$(sql "$db" "select count(*) from public.audit_log where action = '"'"'SCHEMA_DEPLOYED'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-4b'"'"'")" = 1 ]'
check "verification script made no changes (read-only)" 's1=$(snapshot "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ]'
deployed="$db"

echo "== Re-running"
snap=$(snapshot "$deployed")
out=$(run_file "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-4b is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_single "$deployed" "$DEPLOY" || true)
check "refused in single-message mode too, nothing changed" 'grep -q "already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'

echo "== Single-message mode (like the SQL Editor)"
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-message deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && [[ "$(overall "$db" "$VERIFY")" == "PASS ("*" 0 fail"* ]]'

echo "== Failures roll back everything"
broken="$WORK/broken.sql"
awk '/POST-INSTALL SELF-CHECK/ && !done {print "select 1/0; -- deliberate failure"; done=1} {print}' "$DEPLOY" > "$broken"
for mode in run_file run_single; do
  db=$(new_db); before=$(snapshot "$db")
  out=$($mode "$db" "$broken" || true)
  check "[$mode] late failure rolls back (policies unchanged)" 'grep -q "division by zero" <<<"$out" && [ "$(snapshot "$db")" = "$before" ] && [ "$(policies "$db")" = "$base_policies" ]'
done
awk '/POST-INSTALL SELF-CHECK/ && !done {print "create policy sneaky on public.cases for select to authenticated using (true); -- simulated weakness"; done=1} {print}' "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
check "self-check aborts if a client-readable policy slips in (rolled back)" 'grep -q "DEPLOYMENT ABORTED (rolled back): cases is not founder-only" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
awk '/POST-INSTALL SELF-CHECK/ && !done {print "grant execute on function public.client_list_cases() to anon; -- simulated weakness"; done=1} {print}' "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
check "self-check aborts if a client function becomes anon-executable (rolled back)" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
head -n "$(grep -n "POST-INSTALL SELF-CHECK" "$DEPLOY" | head -1 | cut -d: -f1)" "$DEPLOY" > "$broken"
for mode in run_file run_single; do
  db=$(new_db); before=$(snapshot "$db"); $mode "$db" "$broken" >/dev/null 2>&1 || true
  check "[$mode] truncated copy without COMMIT leaves nothing behind" '[ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(new_db "" no2a1); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-1, nothing changed" 'grep -q "Stage 2A-1 is not installed" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "create policy extra_read on public.cases for select to authenticated using (true)" >/dev/null; before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when a case table has an unexpected extra policy, nothing changed" 'grep -q "cases has 2 policies" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "drop policy outcomes_select on public.outcomes; create policy outcomes_select on public.outcomes for select to authenticated using (true)" >/dev/null; before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when a policy condition is not the 2A-1 one, nothing changed" 'grep -q "outcomes: unexpected policy condition" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "drop policy cases_select on public.cases; create policy cases_select on public.cases for select to authenticated using ((select private.is_founder()))" >/dev/null; before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses a partially applied state, nothing changed" 'grep -q "1 of 4 policies already changed" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses after deployment"
sql "$deployed" "create policy leak on public.outcomes for select to authenticated using ((select private.is_member(business_id)))" >/dev/null
check "detects a client-readable case table (check 1 FAIL, OVERALL FAIL)" '[ "$(status_of "$deployed" 1)" = FAIL ] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
sql "$deployed" "drop policy leak on public.outcomes; grant execute on function public.client_get_case(uuid) to anon" >/dev/null
check "detects a client function executable by anon (check 6 FAIL)" '[ "$(status_of "$deployed" 6)" = FAIL ]'
sql "$deployed" "revoke execute on function public.client_get_case(uuid) from anon" >/dev/null
check "verification returns to OVERALL PASS after reverting" '[[ "$(overall "$deployed" "$VERIFY")" == "PASS ("*" 0 fail"* ]]'

echo "== Rollback"
rows_before=$(data_rows "$deployed")
out=$(run_file "$deployed" "$ROLLBACK" || true)
check "rollback succeeds with both self-checks" '! grep -q ERROR <<<"$out" && grep -q "Rollback preflight passed" <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback restores the 2A-1 policies exactly (catalog identical to a fresh 2A-1 install)" '[ "$(policies "$deployed")" = "$base_policies" ] && [ -n "$base_policies" ]'
check "after rollback: 2A-1 verification OVERALL PASS; 2A-4b verification FAIL" '[[ "$(overall "$deployed" "$BASE_VERIFY")" == "PASS ("*" 0 fail"* ]] && [ "$(status_of "$deployed" 1)" = FAIL ]'
check "rollback changed no data and was audited" '[ "$(data_rows "$deployed")" = "$rows_before" ] && [ "$(sql "$deployed" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"'")" = 1 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-4b is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
before=$(snapshot "$fresh21"); out=$(run_single "$fresh21" "$ROLLBACK" || true)
check "rollback on a 2A-1-only database refused, nothing changed" 'grep -q "ROLLBACK REFUSED" <<<"$out" && [ "$(snapshot "$fresh21")" = "$before" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploying after a rollback works and verifies" '! grep -q ERROR <<<"$out" && [[ "$(overall "$deployed" "$VERIFY")" == "PASS ("*" 0 fail"* ]]'

echo "== Alongside Supabase's verified rls_auto_enable helper"
db=$(new_db helper)
helper_before=$(sql "$db" "select md5(p.prosrc||coalesce(p.proacl::text,'')||p.prosecdef::text) from pg_proc p where p.oid = to_regprocedure('public.rls_auto_enable()')")
out=$(run_single "$db" "$DEPLOY" || true)
check "deploys alongside the helper; helper unchanged; both verifications pass" '! grep -q ERROR <<<"$out" && [ "$(sql "$db" "select md5(p.prosrc||coalesce(p.proacl::text,'"''"')||p.prosecdef::text) from pg_proc p where p.oid = to_regprocedure('"'"'public.rls_auto_enable()'"'"')")" = "$helper_before" ] && [[ "$(overall "$db" "$VERIFY")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$db" "$BASE_VERIFY")" == "PASS ("*" 0 fail"* ]]'
# Regression: 2A-4b adds a newer SCHEMA_DEPLOYED row without a helper fingerprint;
# 2A-1 verification row 20 must still compare against the 2A-1 deployment entry.
check "2A-1 verification row 20 is PASS (not INFO) after 2A-4b with the helper unchanged" '[ "$(base_status_of "$db" 20)" = PASS ]'
sql "$db" "revoke execute on function public.rls_auto_enable() from anon" >/dev/null
check "row 20 FAILs after 2A-4b if the helper's privileges change (OVERALL FAIL)" '[ "$(base_status_of "$db" 20)" = FAIL ] && [[ "$(overall "$db" "$BASE_VERIFY")" == FAIL* ]]'
sql "$db" "grant execute on function public.rls_auto_enable() to anon" >/dev/null
check "row 20 returns to PASS when the helper is restored" '[ "$(base_status_of "$db" 20)" = PASS ]'
sql "$db" "alter event trigger ensure_rls disable" >/dev/null
check "row 20 FAILs after 2A-4b if the event trigger ensure_rls is disabled" '[ "$(base_status_of "$db" 20)" = FAIL ]'
sql "$db" "alter event trigger ensure_rls enable" >/dev/null
check "row 20 PASS again after re-enabling the event trigger" '[ "$(base_status_of "$db" 20)" = PASS ]'
out=$(run_single "$db" "$ROLLBACK" || true)
check "rollback alongside the helper restores 2A-1 policies" '! grep -q ERROR <<<"$out" && [ "$(policies "$db")" = "$base_policies" ]'

echo "== Read-only client view check (deploy/stage2a4b_client_view_check.sql)"
CHECK="$HERE/deploy/stage2a4b_client_view_check.sql"
cid=00000000-0000-4000-8000-0000000000c1
seed_client() {
  sql "$1" "insert into auth.users (id, email) values ('$cid', 'client-check@synthetic.test');
    insert into public.businesses (id, name) values ('10000000-0000-4000-8000-0000000000c1', 'Synthetic Check Co');
    insert into public.business_members (business_id, user_id) values ('10000000-0000-4000-8000-0000000000c1', '$cid');
    insert into public.cases (id, business_id, reference, product_service, lead_source, conversation_source, idempotency_key)
      values ('20000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000c1', 'CHK-1', 'Synthetic', 'Referral', 'TEXT', gen_random_uuid());
    insert into public.case_messages (case_id, business_id, kind, body) values ('20000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000c1', 'PASTED_CONVERSATION', 'Prospect: synthetic check text');
    insert into public.outcomes (case_id, business_id, state, note, recorded_by_role) values ('20000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000c1', 'PAUSED', 'SECRET', 'FOUNDER')" >/dev/null
}
view() { sed "s/REPLACE_WITH_CLIENT_USER_ID/$cid/" "$CHECK" > "$WORK/view.sql"; "${PSQL[@]}" -d "$1" -At -F '|' -c "$(cat "$WORK/view.sql")" 2>&1 | grep -E '^[0-9]+\|'; }
db=$(new_db); seed_client "$db"; before_view=$(view "$db")
check "before 2A-4b the check exposes the leak (client reads case, outcome, message rows)" '[ "$before_view" = "1|1|1|0|1|CLIENT" ]'
run_file "$db" "$DEPLOY" >/dev/null; s1=$(snapshot "$db"); rows=$(data_rows "$db")
after_view=$(view "$db")
check "after 2A-4b: 0 direct rows, case still visible through client_list_cases" '[ "$after_view" = "0|0|0|0|1|CLIENT" ]'
check "the check itself changes nothing" '[ "$(snapshot "$db")" = "$s1" ] && [ "$(data_rows "$db")" = "$rows" ]'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

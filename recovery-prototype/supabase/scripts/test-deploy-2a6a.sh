#!/usr/bin/env bash
# Tests the Stage 2A-6a deployment (read-only reservation terms), verification and
# rollback against throwaway local PostgreSQL databases that first get Stage 2A-1
# through 2A-5d-3a via their deployment files. Storage is a local emulation
# (tests/local/00_supabase_emulation.sql). No network, no secrets, no provider.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a6a_deploy.sql"; VERIFY="$D/stage2a6a_verify.sql"; ROLLBACK="$D/stage2a6a_rollback.sql"
V3A="$D/stage2a5d3a_verify.sql"; ROLLBACK3A="$D/stage2a5d3a_rollback.sql"
EARLIER=("$D/stage2a5d3a_verify.sql" "$D/stage2a5d2_verify.sql" "$D/stage2a5d1_verify.sql" "$D/stage2a5b_verify.sql" "$D/stage2a5a_verify.sql"
         "$D/stage2a4c1_verify.sql" "$D/stage2a4c_verify.sql" "$D/stage2a4b_verify.sql" "$D/stage2a1_verify.sql")
MIGRATION="$HERE/migrations/20261019120000_stage2a6a_reservation_terms.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
FN="public.internal_ai_reservation_terms(uuid)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54342}"
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
overall() { "${PSQL[@]}" -d "$1" -At -F '|' < "$2" 2>/dev/null | awk -F'|' '$2=="OVERALL"{print $3" ("$4")"}'; }
row() { "${PSQL[@]}" -d "$1" -At -F '|' < "$2" | awk -F'|' -v n="$3" '$1==n{print $3}'; }
passes() { [[ "$(overall "$1" "$2")" == "PASS ("*" 0 fail"* ]]; }
earlier_pass() { local v; for v in "${EARLIER[@]}"; do passes "$1" "$v" || return 1; done; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 4 ] || { echo "could not prepare emulation copy"; exit 1; }

# new_db [no3a]
new_db() {
  local db="t_$(date +%s%N)_$RANDOM" f
  sql postgres "create database $db" >/dev/null
  run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }
  for f in stage2a1 stage2a4b stage2a4c stage2a4c1 stage2a5a stage2a5b stage2a5d1 stage2a5d2; do
    run_file "$db" "$D/${f}_deploy.sql" >/dev/null || { echo "$f failed" >&2; exit 1; }
  done
  if [ "${1:-}" != no3a ]; then run_file "$db" "$D/stage2a5d3a_deploy.sql" >/dev/null || { echo "2A-5d-3a failed" >&2; exit 1; }; fi
  echo "$db"
}

A_USER=00000000-0000-4000-8000-0000000000a1; F_USER=00000000-0000-4000-8000-0000000000f1
A_BIZ=10000000-0000-4000-8000-0000000000a1
as() {
  local role=authenticated claims
  case "$2" in
    service) role=service_role; claims='{"role": "service_role"}';;
    service-noclaim) role=service_role; claims='{}';;
    anon) role=anon; claims='{"role": "anon"}';;
    *) claims="{\"sub\": \"$2\", \"role\": \"authenticated\"}";;
  esac
  "${PSQL[@]}" -d "$1" -At -c "set role $role; select set_config('request.jwt.claims', '$claims', false);" -c "$3" 2>&1 | tail -n +2 || true
}
seed() {
  sql "$1" "insert into auth.users (id, email) values ('$A_USER', 'a@synthetic.test'), ('$F_USER', 'f@synthetic.test');
    insert into public.founders (user_id) values ('$F_USER');
    insert into public.businesses (id, name) values ('$A_BIZ', 'Synthetic A');
    insert into public.business_members (business_id, user_id) values ('$A_BIZ', '$A_USER')" >/dev/null
}
# reserved_case <db>: a submitted synthetic case, a started analysis and a reservation; prints the analysis id.
reserved_case() {
  local c a
  c=$(as "$1" "$A_USER" "select public.client_create_case(gen_random_uuid(), 'RT-$RANDOM', 'Synthetic', 'Referral', 'TEXT', rpad('Prospect: synthetic ', 100, 'x'))" | tail -1)
  as "$1" "$A_USER" "select public.client_submit_case('$c')" >/dev/null
  a=$(as "$1" "$F_USER" "select public.founder_start_analysis('$c')" | tail -1)
  as "$1" service "select public.internal_reserve_ai_spend('$a', 'test-cheap', 'test-dear')" >/dev/null
  echo "$a"
}
enable_test_prices() {
  sql "$1" "update private.ai_spend_config set enabled = true where id;
    insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note) values
    ('test-cheap', 1, 5, 1000, true, 'synthetic'), ('test-dear', 10, 50, 2000, true, 'synthetic')" >/dev/null
}
fingerprint() {
  sql "$1" "select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.proname <> 'internal_ai_reservation_terms'"
}
data_rows() { sql "$1" "select (select count(*) from public.cases)||'/'||(select count(*) from public.analyses)||'/'||(select count(*) from private.ai_spend_ledger)||'/'||(select count(*) from public.audit_log where action not in ('SCHEMA_DEPLOYED', 'SCHEMA_ROLLED_BACK'))||'/'||(select md5(string_agg(m::text, '' order by model)) from private.ai_model_prices m)||'/'||(select enabled from private.ai_spend_config)"; }

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a6a.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|sb_secret_|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, changes policies, tables, triggers or views" '! grep -niE "disable row level security|session_replication_role|create policy|drop policy|alter policy|create table|alter table|drop table|create trigger|drop trigger|create view|create or replace view|alter default privileges" "$f" >/dev/null'
  check "$n never deletes or rewrites rows" '! grep -niE "^\s*(delete from|truncate|update )" "$f" >/dev/null'
  check "$n grants nothing to anon, authenticated or public" '! grep -niE "^grant .* to (anon|authenticated|public)" "$f" >/dev/null'
done
check "the migration creates exactly one function, granted to the service role only" \
  '[ "$(grep -cE "^create (or replace )?(function|table|trigger|policy|view|type)" "$MIGRATION")" = 1 ] && grep -q "^create or replace function public.internal_ai_reservation_terms(p_analysis_id uuid) returns jsonb" "$MIGRATION" && [ "$(grep -cE "^grant " "$MIGRATION")" = 1 ] && grep -q "^grant execute on function public.internal_ai_reservation_terms(uuid) to service_role;" "$MIGRATION"'
check "the deploy file drops nothing; the rollback drops only this function" \
  '! grep -niE "^\s*drop " "$DEPLOY" >/dev/null && [ "$(grep -ciE "^\s*drop " "$ROLLBACK")" = 1 ] && grep -q "^drop function public.internal_ai_reservation_terms(uuid);" "$ROLLBACK"'
check "the new function is STABLE: it cannot write" 'grep -q "language plpgsql stable security definer set search_path = '"''"' as" "$MIGRATION"'

echo "== Control: Stage 2A-5d-3a only"
ctl=$(new_db); seed "$ctl"; enable_test_prices "$ctl"
a=$(reserved_case "$ctl")
out=$(as "$ctl" service "select public.internal_ai_reservation_terms('$a')")
check "control: no reservation-terms function before deployment" 'grep -q "does not exist" <<<"$out"'
check "control: verification reports FAIL before deployment" '[[ "$(overall "$ctl" "$VERIFY")" == FAIL* ]]'

echo "== Deployment"
db=$(new_db); seed "$db"; enable_test_prices "$db"
a=$(reserved_case "$db"); rows=$(data_rows "$db"); fp=$(fingerprint "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "2A-6a verify: PASS (4 pass, 0 fail, 1 info)" '[ "$(overall "$db" "$VERIFY")" = "PASS (4 pass, 0 fail, 1 info)" ]'
check "2A-5d-3a and every earlier verification still OVERALL PASS" 'earlier_pass "$db"'
check "2A-5d-3a verify still PASS (8 pass, 0 fail, 2 info)" '[ "$(overall "$db" "$V3A")" = "PASS (8 pass, 0 fail, 2 info)" ]'
check "deployment changed no data, setting, price or existing function" '[ "$(data_rows "$db")" = "$rows" ] && [ "$(fingerprint "$db")" = "$fp" ]'
check "verification is read-only" 's1=$(snapshot "$db"); d1=$(data_rows "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ] && [ "$(data_rows "$db")" = "$d1" ]'
deployed="$db"

echo "== Behaviour on the deployed database"
t=$(as "$db" service "select public.internal_ai_reservation_terms('$a')" | tail -1)
check "the service role reads the per-call terms of an existing reservation" \
  '[ "$(sql "$db" "select ('"'"'$t'"'"'::jsonb -> '"'"'analyst'"'"') = '"'"'{\"model\": \"test-cheap\", \"max_output_tokens\": 1000, \"input_bound\": 8664, \"input_usd_per_mtok\": 1.000000, \"output_usd_per_mtok\": 5.000000}'"'"'::jsonb and ('"'"'$t'"'"'::jsonb -> '"'"'reviewer'"'"' ->> '"'"'input_bound'"'"')::int = 10664 and ('"'"'$t'"'"'::jsonb ->> '"'"'reserved_usd'"'"')::numeric = 0.2204")" = t ]'
for who in "$F_USER" "$A_USER" anon; do
  out=$(as "$db" "$who" "select public.internal_ai_reservation_terms('$a')")
  check "$( [ "$who" = anon ] && echo anonymous || ([ "$who" = "$F_USER" ] && echo "the founder session" || echo "a business user")) cannot read reservation terms" 'grep -q "permission denied" <<<"$out"'
done
out=$(as "$db" service-noclaim "select public.internal_ai_reservation_terms('$a')")
check "the service role without the service_role claim is refused (FORBIDDEN)" 'grep -q "FORBIDDEN" <<<"$out"'
out=$(as "$db" service "select public.internal_ai_reservation_terms(gen_random_uuid())")
check "an unknown reservation is refused (NOT_RESERVED)" 'grep -q "NOT_RESERVED" <<<"$out"'
check "reading terms writes nothing" 'd1=$(data_rows "$db"); as "$db" service "select public.internal_ai_reservation_terms('"'"'$a'"'"')" >/dev/null; [ "$(data_rows "$db")" = "$d1" ]'
out=$(as "$db" service "select public.internal_ai_dispatch('$a', 'ANALYST')")
check "the existing dispatch path is unchanged (still returns model and cap only)" 'grep -q "\"model\": \"test-cheap\", \"max_output_tokens\": 1000}" <<<"$out"'

echo "== Re-running, single-query mode, failures"
snap=$(snapshot "$deployed"); out=$(run_single "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-6a is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && passes "$db" "$VERIFY" && earlier_pass "$db"'
broken="$WORK/broken.sql"
for weak in "grant execute on function $FN to authenticated" \
            "grant execute on function $FN to anon" \
            "alter function $FN volatile" \
            "alter function $FN reset all" \
            "alter function public.internal_ai_dispatch(uuid, text) reset all" \
            "grant execute on function private.ai_reconcile(uuid, numeric, text) to service_role" \
            "create policy leak on private.ai_spend_ledger for select to authenticated using (true)" \
            "update private.ai_model_prices set input_usd_per_mtok = 0.5 where model = 'FAKE-PROVIDER-NOT-AI'"; do
  awk -v w="$weak; -- weakness" '/POST-INSTALL SELF-CHECK/ && !done {print w; done=1} {print}' "$DEPLOY" > "$broken"
  db=$(new_db); before=$(snapshot "$db"); bdata=$(data_rows "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts and rolls back: ${weak:0:66}…" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ] && [ "$(data_rows "$db")" = "$bdata" ]'
done
# Rules present in the text but broken are caught by the behaviour self-test.
FROMS=("'input_bound', v_l.reviewer_input_bound," "  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then" "'input_usd_per_mtok', v_l.analyst_in_price,")
TOS=("'input_bound', v_l.analyst_input_bound," "  if false then" "'input_usd_per_mtok', v_l.reviewer_in_price,")
EXPECTS=("reviewer gets the analyst's bound" "the service-role check removed" "the analyst gets the reviewer's price")
for i in 0 1 2; do
  python3 -I -c 'import sys; s=open(sys.argv[1]).read(); assert s.count(sys.argv[2])==1, sys.argv[2]; open(sys.argv[3],"w").write(s.replace(sys.argv[2], sys.argv[4]))' "$DEPLOY" "${FROMS[$i]}" "$broken" "${TOS[$i]}"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts on a sabotaged body: ${EXPECTS[$i]}" 'grep -q "does not behave as reviewed" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(new_db no3a); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-5d-3a" 'grep -q "Stage 2A-5d-3a (AI spending controls) is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses"
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "grant execute on function $FN to authenticated" >/dev/null
check "callable by signed-in users: row 2 FAIL, OVERALL FAIL" '[ "$(row "$db" "$VERIFY" 2)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "alter function $FN volatile" >/dev/null
check "no longer STABLE: row 1 FAIL" '[ "$(row "$db" "$VERIFY" 1)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "do \$x\$ begin execute replace(pg_get_functiondef('$FN'::regprocedure), 'if coalesce((select auth.jwt()) ->> ''role'', '''') <> ''service_role'' then', 'if false then'); end \$x\$" >/dev/null
check "service-role check removed from the body: row 3 FAIL" '[ "$(row "$db" "$VERIFY" 3)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'

echo "== Rollback"
before=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK3A" || true)
check "2A-5d-3a rollback is refused while 2A-6a is installed (nothing changed)" 'grep -q "run stage2a6a_rollback.sql first" <<<"$out" && [ "$(snapshot "$deployed")" = "$before" ]'
rows=$(data_rows "$deployed"); fp=$(fingerprint "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "2A-6a rollback succeeds with its self-check" '! grep -q ERROR <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback removed the function and changed nothing else (data, settings, prices, every other function)" \
  '[ "$(sql "$deployed" "select to_regprocedure('"'"'$FN'"'"') is null")" = t ] && [ "$(data_rows "$deployed")" = "$rows" ] && [ "$(fingerprint "$deployed")" = "$fp" ]'
check "after rollback: 2A-5d-3a and earlier verifications PASS; 2A-6a verify FAILs" 'earlier_pass "$deployed" && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
check "after rollback the existing reservation path still works" '[ -n "$(reserved_case "$deployed")" ] && [ "$(sql "$deployed" "select count(*) from private.ai_spend_ledger")" -ge 2 ]'
check "rollback is audited" '[ "$(sql "$deployed" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-6a'"'"'")" = 1 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-6a is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploying after rollback works" '! grep -q ERROR <<<"$out" && passes "$deployed" "$VERIFY"'
out=$(run_file "$deployed" "$ROLLBACK" || true); out2=$(run_file "$deployed" "$ROLLBACK3A" || true)
check "full reverse order works: 2A-6a rollback, then 2A-5d-3a rollback" '! grep -q ERROR <<<"$out" && ! grep -q ERROR <<<"$out2" && grep -q "Rollback self-check passed" <<<"$out2"'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

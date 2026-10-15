#!/usr/bin/env bash
# Tests the Stage 2A-6e deployment (one INACTIVE kimi-k3 price row), verification and
# rollback against throwaway local PostgreSQL databases that first get Stage 2A-1 through
# 2A-6a (and, where stated, 2A-6c) via their deployment files. Storage is a local emulation
# (tests/local/00_supabase_emulation.sql). No network, no secrets, no provider, no AI call.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a6e_deploy.sql"; VERIFY="$D/stage2a6e_verify.sql"; ROLLBACK="$D/stage2a6e_rollback.sql"; V6C="$D/stage2a6c_verify.sql"; DEPLOY6C="$D/stage2a6c_deploy.sql"; ROLLBACK6C="$D/stage2a6c_rollback.sql"
V6A="$D/stage2a6a_verify.sql"; V3A="$D/stage2a5d3a_verify.sql"; ROLLBACK6A="$D/stage2a6a_rollback.sql"; ROLLBACK3A="$D/stage2a5d3a_rollback.sql"
EARLIER=("$D/stage2a6a_verify.sql" "$D/stage2a5d3a_verify.sql" "$D/stage2a5d2_verify.sql" "$D/stage2a5d1_verify.sql" "$D/stage2a5b_verify.sql"
         "$D/stage2a5a_verify.sql" "$D/stage2a4c1_verify.sql" "$D/stage2a4c_verify.sql" "$D/stage2a4b_verify.sql" "$D/stage2a1_verify.sql")
MIGRATION="$HERE/migrations/20261021120000_stage2a6e_kimi_price.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54345}"
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
snapshot() { "${RUNAS[@]}" "$PGBIN/pg_dump" -h "$WORK" -p "$PORT" -U postgres "$1" | grep -v '^\\restrict\|^\\unrestrict' | md5sum | cut -d' ' -f1; }
overall() { "${PSQL[@]}" -d "$1" -At -F '|' < "$2" 2>/dev/null | awk -F'|' '$2=="OVERALL"{print $3" ("$4")"}'; }
row() { "${PSQL[@]}" -d "$1" -At -F '|' < "$2" | awk -F'|' -v n="$3" '$1==n{print $3}'; }
passes() { [[ "$(overall "$1" "$2")" == "PASS ("*" 0 fail"* ]]; }
earlier_pass() { local v; for v in "${EARLIER[@]}"; do passes "$1" "$v" || return 1; done; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 4 ] || { echo "could not prepare emulation copy"; exit 1; }

# new_db [no6a|with6c]
new_db() {
  local db="t_$(date +%s%N)_$RANDOM" f
  sql postgres "create database $db" >/dev/null
  run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }
  for f in stage2a1 stage2a4b stage2a4c stage2a4c1 stage2a5a stage2a5b stage2a5d1 stage2a5d2 stage2a5d3a; do
    run_file "$db" "$D/${f}_deploy.sql" >/dev/null || { echo "$f failed" >&2; exit 1; }
  done
  if [ "${1:-}" != no6a ]; then run_file "$db" "$D/stage2a6a_deploy.sql" >/dev/null || { echo "2A-6a failed" >&2; exit 1; }; fi
  if [ "${1:-}" = with6c ]; then run_file "$db" "$DEPLOY6C" >/dev/null || { echo "2A-6c failed" >&2; exit 1; }; fi
  echo "$db"
}

A_USER=00000000-0000-4000-8000-0000000000a1; B_USER=00000000-0000-4000-8000-0000000000b1; F_USER=00000000-0000-4000-8000-0000000000f1
A_BIZ=10000000-0000-4000-8000-0000000000a1
as() {
  local role=authenticated claims
  case "$2" in
    service) role=service_role; claims='{"role": "service_role"}';;
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
# started_case <db> <bytes>: a submitted synthetic text case of that size and a started analysis; prints the analysis id.
started_case() {
  local c a
  sql "$1" "begin; set local session_replication_role = replica; update public.cases set created_at = created_at - interval '2 days';
            update private.ai_spend_ledger set created_at = created_at - interval '25 hours'; commit;" >/dev/null
  c=$(as "$1" "$A_USER" "select public.client_create_case(gen_random_uuid(), 'PC-$RANDOM', 'Synthetic', 'Referral', 'TEXT', rpad('Prospect: synthetic ', $2, 'x'))" | tail -1)
  as "$1" "$A_USER" "select public.client_submit_case('$c')" >/dev/null
  a=$(as "$1" "$F_USER" "select public.founder_start_analysis('$c')" | tail -1)
  echo "$a"
}
fingerprint() {
  sql "$1" "select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')"
}
other_rows() { sql "$1" "select (select count(*) from public.cases)||'/'||(select count(*) from public.analyses)||'/'||(select md5(coalesce(string_agg(l::text, '' order by analysis_id), '')) from private.ai_spend_ledger l)||'/'||(select count(*) from public.audit_log where action not in ('SCHEMA_DEPLOYED', 'SCHEMA_ROLLED_BACK'))||'/'||(select md5(string_agg(m::text, '' order by model)) from private.ai_model_prices m where model <> 'kimi-k3')||'/'||(select md5(c::text) from private.ai_spend_config c)"; }
kimi_row() { sql "$1" "select coalesce(string_agg(format('%s:%s:%s:%s:%s', model, input_usd_per_mtok::numeric(12,2), output_usd_per_mtok::numeric(12,2), max_output_tokens, active), ',' order by model), 'none') from private.ai_model_prices where model = 'kimi-k3'"; }
EXPECTED_KIMI='kimi-k3:3.00:15.00:8000:f'

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a6e.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-[A-Za-z0-9]{16,}|sb_secret_|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, changes policies, functions, tables, triggers or views" '! grep -niE "disable row level security|session_replication_role|create policy|drop policy|alter policy|create table|alter table|drop table|create (or replace )?function|drop function|alter function|create trigger|drop trigger|create view|create or replace view|alter default privileges" "$f" >/dev/null'
  check "$n grants or revokes nothing" '! grep -niE "^\s*(grant|revoke) " "$f" >/dev/null'
  check "$n never updates or truncates rows, never touches the spending configuration" '! grep -niE "^\s*(update |truncate)|update private\.ai_spend_config|enabled\s*=\s*true" "$f" >/dev/null'
done
check "the migration is exactly one INSERT of kimi-k3 at 3/15, cap 8000, inactive; nothing else" \
  '[ "$(grep -cviE "^\s*(--.*)?$" "$MIGRATION")" = 2 ] && grep -q "^insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note) values$" "$MIGRATION" && grep -qE "^  \(.kimi-k3., 3, 15, 8000, false, " "$MIGRATION"'
check "the deploy file deletes nothing; the rollback deletes only the inactive kimi-k3 row" \
  '! grep -niE "^\s*delete " "$DEPLOY" >/dev/null && [ "$(grep -ciE "^\s*delete " "$ROLLBACK")" = 1 ] && grep -q "^delete from private.ai_model_prices where model = '"'"'kimi-k3'"'"' and not active;$" "$ROLLBACK"'

echo "== Control: Stage 2A-6a only"
ctl=$(new_db)
check "control: no kimi-k3 price row before deployment" '[ "$(kimi_row "$ctl")" = none ]'
check "control: verification reports FAIL before deployment" '[[ "$(overall "$ctl" "$VERIFY")" == FAIL* ]]'

echo "== Deployment (after 2A-6a, without 2A-6c)"
db=$(new_db); seed "$db"
rows=$(other_rows "$db"); fp=$(fingerprint "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "the row exists exactly as reviewed, INACTIVE" '[ "$(kimi_row "$db")" = "$EXPECTED_KIMI" ]'
check "2A-6e verify: PASS (4 pass, 0 fail, 1 info)" '[ "$(overall "$db" "$VERIFY")" = "PASS (4 pass, 0 fail, 1 info)" ]'
check "2A-6a verify still PASS (4 pass, 0 fail, 1 info)" '[ "$(overall "$db" "$V6A")" = "PASS (4 pass, 0 fail, 1 info)" ]'
check "2A-5d-3a verify still PASS (8 pass, 0 fail, 2 info)" '[ "$(overall "$db" "$V3A")" = "PASS (8 pass, 0 fail, 2 info)" ]'
check "every earlier verification still OVERALL PASS" 'earlier_pass "$db"'
check "nothing else changed: data, ledger, configuration, every other price row, every function" '[ "$(other_rows "$db")" = "$rows" ] && [ "$(fingerprint "$db")" = "$fp" ]'
check "spending still disabled; budget 20, stop 18, max 1 per analysis" '[ "$(sql "$db" "select enabled||'"'"'/'"'"'||budget_usd::numeric(8,2)||'"'"'/'"'"'||stop_at_usd::numeric(8,2)||'"'"'/'"'"'||max_reservation_usd::numeric(8,2) from private.ai_spend_config")" = "false/20.00/18.00/1.00" ]'
check "the info row shows the reservation for a 1,000-byte case" '[[ "$("${PSQL[@]}" -d "$db" -At -F "|" < "$VERIFY" | awk -F"|" "\$1==5{print \$4}")" == "kimi-k3 + kimi-k3 0.3724 USD" ]]'
check "verification is read-only" 's1=$(snapshot "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ]'
check "deployment is audited once" '[ "$(sql "$db" "select count(*) from public.audit_log where action = '"'"'SCHEMA_DEPLOYED'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-6e'"'"' and details->'"'"'migrations'"'"'->0->>'"'"'file'"'"' = '"'"'20261021120000_stage2a6e_kimi_price.sql'"'"'")" = 1 ]'

echo "== Deployment alongside 2A-6c (the Anthropic rows)"
db6c=$(new_db with6c); out=$(run_file "$db6c" "$DEPLOY" || true)
check "deploys after 2A-6c too; 2A-6c and 2A-6e verifications both PASS" '! grep -q ERROR <<<"$out" && [ "$(overall "$db6c" "$V6C")" = "PASS (5 pass, 0 fail, 1 info)" ] && passes "$db6c" "$VERIFY" && earlier_pass "$db6c"'

echo "== Behaviour: the inactive model cannot be reserved (even with spending enabled)"
sql "$db" "update private.ai_spend_config set enabled = true where id" >/dev/null
a=$(started_case "$db" 100)
for pair in "kimi-k3 kimi-k3" "kimi-k3 FAKE-PROVIDER-NOT-AI" "FAKE-PROVIDER-NOT-AI kimi-k3"; do
  set -- $pair
  out=$(as "$db" service "select public.internal_reserve_ai_spend('$a', '$1', '$2')")
  check "inactive: reserving $1 + $2 is refused (MODEL_NOT_PRICED), nothing reserved" 'grep -q "MODEL_NOT_PRICED" <<<"$out" && [ "$(sql "$db" "select count(*) from private.ai_spend_ledger where analysis_id = '"'"'$a'"'"'")" = 0 ]'
done
out=$(as "$db" service "select public.internal_reserve_ai_spend('$a', 'FAKE-PROVIDER-NOT-AI', 'FAKE-PROVIDER-NOT-AI')")
check "the fake provider still reserves (USD 0)" 'grep -q "\"reserved_usd\": 0" <<<"$out"'
for who in "$F_USER" "$A_USER" anon; do
  out=$(as "$db" "$who" "select count(*) from private.ai_model_prices")
  check "the price list is not readable by $( [ "$who" = anon ] && echo anonymous || ([ "$who" = "$F_USER" ] && echo "the founder session" || echo "a business user"))" 'grep -q "permission denied" <<<"$out"'
done

echo "== Behaviour if activated (SYNTHETIC, this local database only): both calls reserved, USD 1 limit"
sql "$db" "update private.ai_model_prices set active = true where model = 'kimi-k3'" >/dev/null
a=$(started_case "$db" 100)
out=$(as "$db" service "select public.internal_reserve_ai_spend('$a', 'kimi-k3', 'kimi-k3')")
check "kimi-k3 + kimi-k3, 100-byte case: reserves 0.3400 with cap 8000 for EACH call" 'grep -q "\"reserved_usd\": 0.3400" <<<"$out" && grep -q "\"analyst\": {\"model\": \"kimi-k3\", \"max_output_tokens\": 8000}" <<<"$out" && grep -q "\"reviewer\": {\"model\": \"kimi-k3\", \"max_output_tokens\": 8000}" <<<"$out"'
t=$(as "$db" service "select public.internal_ai_reservation_terms('$a')" | tail -1)
check "the terms carry the snapshot prices 3/15, cap 8000, input bounds 8664 (analyst) and 24664 (reviewer)" \
  '[ "$(sql "$db" "select ('"'"'$t'"'"'::jsonb -> '"'"'analyst'"'"') = '"'"'{\"model\": \"kimi-k3\", \"max_output_tokens\": 8000, \"input_bound\": 8664, \"input_usd_per_mtok\": 3.000000, \"output_usd_per_mtok\": 15.000000}'"'"'::jsonb and ('"'"'$t'"'"'::jsonb -> '"'"'reviewer'"'"') = '"'"'{\"model\": \"kimi-k3\", \"max_output_tokens\": 8000, \"input_bound\": 24664, \"input_usd_per_mtok\": 3.000000, \"output_usd_per_mtok\": 15.000000}'"'"'::jsonb")" = t ]'
check "the reservation covers both calls at their caps: 8664x3 + 8000x15 + 24664x3 + 8000x15 per million = 0.339984, rounded up" \
  '[ "$(sql "$db" "select reserved_usd from private.ai_spend_ledger where analysis_id = '"'"'$a'"'"'")" = 0.3400 ]'
a=$(started_case "$db" 18500)
out=$(as "$db" service "select public.internal_reserve_ai_spend('$a', 'kimi-k3', 'kimi-k3')")
check "18,500-byte case: refused by the USD 1 limit (RESERVATION_TOO_LARGE)" 'grep -q "RESERVATION_TOO_LARGE" <<<"$out"'
a=$(started_case "$db" 18000)
out=$(as "$db" service "select public.internal_reserve_ai_spend('$a', 'kimi-k3', 'kimi-k3')")
check "18,000-byte case: fits the USD 1 limit" 'grep -q "\"reserved_usd\": 0.98" <<<"$out"'

echo "== Re-running, single-query mode, failures"
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null; snap=$(snapshot "$db"); out=$(run_single "$db" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-6e already applied" <<<"$out" && [ "$(snapshot "$db")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && passes "$db" "$VERIFY" && earlier_pass "$db"'
broken="$WORK/broken.sql"
for weak in "update private.ai_model_prices set active = true where model = 'kimi-k3'" \
            "update private.ai_model_prices set max_output_tokens = 9000 where model = 'kimi-k3'" \
            "update private.ai_model_prices set input_usd_per_mtok = 0.3 where model = 'kimi-k3'" \
            "update private.ai_model_prices set output_usd_per_mtok = 14 where model = 'kimi-k3'" \
            "update private.ai_spend_config set enabled = true where id" \
            "update private.ai_spend_config set max_reservation_usd = 2 where id" \
            "update private.ai_spend_config set prompt_overhead_tokens = 4000 where id" \
            "update private.ai_model_prices set input_usd_per_mtok = 0.5 where model = 'FAKE-PROVIDER-NOT-AI'" \
            "insert into private.ai_model_prices values ('kimi-k2', 1, 5, 8000, true, 'x')" \
            "grant select on private.ai_model_prices to authenticated" \
            "create policy leak on private.ai_model_prices for select to authenticated using (true)" \
            "alter function public.internal_ai_dispatch(uuid, text) reset all"; do
  awk -v w="$weak; -- weakness" '/POST-INSTALL SELF-CHECK/ && !done {print w; done=1} {print}' "$DEPLOY" > "$broken"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts and rolls back: ${weak:0:70}…" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(new_db no6a); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-6a" 'grep -q "Stage 2A-6a (reservation terms) is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "update private.ai_spend_config set enabled = true where id" >/dev/null; before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses while spending is enabled" 'grep -q "AI spending is enabled" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "insert into private.ai_model_prices values ('kimi-k3', 9, 9, 100, false, 'pre-existing')" >/dev/null; before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when the row already exists (never overwrites it)" 'grep -q "already exists" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses"
for case in "1|update private.ai_model_prices set input_usd_per_mtok = 0.3 where model = 'kimi-k3'" \
            "1|update private.ai_model_prices set max_output_tokens = 16000 where model = 'kimi-k3'" \
            "2|update private.ai_model_prices set active = true where model = 'kimi-k3'" \
            "3|update private.ai_spend_config set enabled = true where id" \
            "3|update private.ai_spend_config set max_reservation_usd = 2 where id"; do
  n="${case%%|*}"; stmt="${case#*|}"
  db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null; sql "$db" "$stmt" >/dev/null
  check "verify row $n FAIL, OVERALL FAIL after: ${stmt:0:60}…" '[ "$(row "$db" "$VERIFY" "$n")" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
done

echo "== Rollback"
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null; seed "$db"
before=$(snapshot "$db"); out=$(run_file "$db" "$ROLLBACK6A" || true)
check "2A-6a rollback is refused while 2A-6e is installed (nothing changed)" 'grep -q "run stage2a6e_rollback.sql first" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
sql "$db" "update private.ai_model_prices set active = true where model = 'kimi-k3'" >/dev/null
before=$(snapshot "$db"); out=$(run_file "$db" "$ROLLBACK" || true)
check "2A-6e rollback is refused while kimi-k3 is ACTIVE (nothing changed)" 'grep -q "kimi-k3 is ACTIVE" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
sql "$db" "update private.ai_spend_config set enabled = true where id" >/dev/null
a=$(started_case "$db" 100)
as "$db" service "select public.internal_reserve_ai_spend('$a', 'kimi-k3', 'kimi-k3')" >/dev/null
as "$db" service "select public.internal_ai_dispatch('$a', 'ANALYST')" >/dev/null
as "$db" "$F_USER" "select public.founder_abandon_analysis('$a')" >/dev/null
sql "$db" "update private.ai_spend_config set enabled = false where id; update private.ai_model_prices set active = false where model = 'kimi-k3'" >/dev/null
check "fixture: a HELD reservation on kimi-k3 exists (dispatched, usage unknown)" '[ "$(sql "$db" "select status from private.ai_spend_ledger where analysis_id = '"'"'$a'"'"'")" = HELD ]'
before=$(snapshot "$db"); out=$(run_file "$db" "$ROLLBACK" || true)
check "2A-6e rollback is refused while an unsettled reservation uses kimi-k3 (nothing changed)" 'grep -q "unsettled reservation uses kimi-k3" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
# Fixture (owner): reconcile the held reservation, as an administrator would.
sql "$db" "update private.ai_spend_ledger set status = 'RECONCILED', actual_usd = 0, settled_by = 'RECONCILIATION', reconciliation_note = 'synthetic test', settled_at = now() where analysis_id = '$a'" >/dev/null
rows=$(other_rows "$db"); fp=$(fingerprint "$db"); ledger=$(sql "$db" "select md5(string_agg(l::text, '' order by analysis_id)) from private.ai_spend_ledger l")
out=$(run_file "$db" "$ROLLBACK" || true)
check "2A-6e rollback succeeds with its self-check" '! grep -q ERROR <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback removed the row and nothing else (data, ledger snapshots, configuration, other prices, functions)" \
  '[ "$(kimi_row "$db")" = none ] && [ "$(other_rows "$db")" = "$rows" ] && [ "$(fingerprint "$db")" = "$fp" ] && [ "$(sql "$db" "select md5(string_agg(l::text, '"'"''"'"' order by analysis_id)) from private.ai_spend_ledger l")" = "$ledger" ]'
check "after rollback: 2A-6a, 2A-5d-3a and earlier verifications PASS; 2A-6e verify FAILs" 'earlier_pass "$db" && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
check "rollback is audited" '[ "$(sql "$db" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-6e'"'"'")" = 1 ]'
snap=$(snapshot "$db"); out=$(run_file "$db" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-6e is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$snap" ]'
out=$(run_file "$db" "$DEPLOY" || true)
check "re-deploying after rollback works" '! grep -q ERROR <<<"$out" && passes "$db" "$VERIFY"'
out=$(run_file "$db" "$ROLLBACK" || true); out2=$(run_file "$db" "$ROLLBACK6A" || true); out3=$(run_file "$db" "$ROLLBACK3A" || true)
check "full reverse order works: 2A-6e, then 2A-6a, then 2A-5d-3a" '! grep -q ERROR <<<"$out$out2$out3" && grep -q "Rollback self-check passed" <<<"$out3"'
out=$(run_file "$db6c" "$ROLLBACK" || true); out2=$(run_file "$db6c" "$ROLLBACK6C" || true)
check "alongside 2A-6c: 2A-6e and 2A-6c roll back independently; earlier verifications PASS" '! grep -q ERROR <<<"$out$out2" && earlier_pass "$db6c"'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

#!/usr/bin/env bash
# Tests the Stage 2A-5a analysis contract deployment, verification and rollback
# against throwaway local PostgreSQL databases that
# first get Stage 2A-1, 2A-4b, 2A-4c and 2A-4c-1 via their deployment files. Storage is a local
# emulation (tests/local/00_supabase_emulation.sql). No network, no secrets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a5a_deploy.sql"; VERIFY="$D/stage2a5a_verify.sql"; ROLLBACK="$D/stage2a5a_rollback.sql"
V4C="$D/stage2a4c_verify.sql"; V4C1="$D/stage2a4c1_verify.sql"
V1="$D/stage2a1_verify.sql"; V4B="$D/stage2a4b_verify.sql"
KNOWN="$D/known/rls_auto_enable.verified.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54335}"
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
overall() { "${PSQL[@]}" -d "$1" -At -F '|' < "$2" | awk -F'|' '$2=="OVERALL"{print $3" ("$4")"}'; }
row() { "${PSQL[@]}" -d "$1" -At -F '|' < "$2" | awk -F'|' -v n="$3" '$1==n{print $3}'; }
all_pass() { [[ "$(overall "$1" "$VERIFY")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V1")" == "PASS ("*" 0 fail"* ]]; }
storage_policies() { sql "$1" "select coalesce(string_agg(policyname, ',' order by policyname), '') from pg_policies where schemaname = 'storage'"; }
evidence() { sql "$1" "select (select count(*) from public.case_screenshots)||'/'||(select count(*) from public.audit_log where action <> 'SCHEMA_ROLLED_BACK')||'/'||(select count(*) from storage.objects)"; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 4 ] || { echo "could not prepare emulation copy"; exit 1; }

# new_db [helper] [no4c]
new_db() {
  local db="t_$(date +%s%N)_$RANDOM"
  sql postgres "create database $db" >/dev/null
  run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }
  if [ "${1:-}" = helper ]; then
    run_file "$db" "$KNOWN" >/dev/null
    sql "$db" "create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable()" >/dev/null
  fi
  run_file "$db" "$D/stage2a1_deploy.sql" >/dev/null || { echo "2A-1 failed" >&2; exit 1; }
  run_file "$db" "$D/stage2a4b_deploy.sql" >/dev/null || { echo "2A-4b failed" >&2; exit 1; }
  if [ "${2:-}" != no4c ]; then
    run_file "$db" "$D/stage2a4c_deploy.sql" >/dev/null || { echo "2A-4c failed" >&2; exit 1; }
    run_file "$db" "$D/stage2a4c1_deploy.sql" >/dev/null || { echo "2A-4c-1 failed" >&2; exit 1; }
  fi
  echo "$db"
}



# Synthetic: business A with client A, the founder, and one submitted TEXT case.
A_USER=00000000-0000-4000-8000-0000000000a1; F_USER=00000000-0000-4000-8000-0000000000f1
A_BIZ=10000000-0000-4000-8000-0000000000a1
# as <db> <uid|service> <sql>: a session as that user (authenticated) or as the server (service_role).
as() {
  local role=authenticated claims
  if [ "$2" = service ]; then role=service_role; claims='{"role": "service_role"}'; else claims="{\"sub\": \"$2\", \"role\": \"authenticated\"}"; fi
  "${PSQL[@]}" -d "$1" -At -c "set role $role; select set_config('request.jwt.claims', '$claims', false);" -c "$3" 2>&1 | tail -n +2 || true
}
seed() {
  sql "$1" "insert into auth.users (id, email) values ('$A_USER', 'a@synthetic.test'), ('$F_USER', 'f@synthetic.test');
    insert into public.founders (user_id) values ('$F_USER');
    insert into public.businesses (id, name) values ('$A_BIZ', 'Synthetic A');
    insert into public.business_members (business_id, user_id) values ('$A_BIZ', '$A_USER')" >/dev/null
}
# new_case <db>: a submitted TEXT case of client A; prints its id.
new_case() {
  as "$1" "$A_USER" "select public.client_create_case(gen_random_uuid(), 'PSY-$RANDOM', 'Synthetic', 'Referral', 'TEXT', 'Prospect: the price feels high. Business: It is our best price.')" | tail -1
}
start() { local c; c=$(new_case "$1"); as "$1" "$A_USER" "select public.client_submit_case('$c')" >/dev/null; as "$1" "$F_USER" "select public.founder_start_analysis('$c')" | tail -1; }
status_of() { sql "$1" "select status::text || coalesce(':' || left(error, 60), '') from public.analyses where id = '$2'"; }
# A fabricated "analysis": confident psychology with no evidence at all.
FAKE='{"verdict": "The buyer is afraid of commitment and will buy if pushed.", "classification": "GREEN"}'
# A minimal valid rre-analysis/1 output for analysis <id> (cites the case's pasted message).
valid() {
  local m; m=$(sql "$1" "select m.id from public.case_messages m join public.analyses a on a.case_id = m.case_id where a.id = '$2' limit 1")
  cat <<JSON
{"contract_version": "rre-analysis/1",
 "evidence_assessment": {"sufficiency": "SUFFICIENT", "summary": "Synthetic.", "missing_evidence": []},
 "observations": [{"id": "O1", "actor": "PROSPECT", "behavior": "Said the price feels high.", "evidence": [{"type": "MESSAGE", "message_id": "$m", "quote": "the price feels high"}]}],
 "hypotheses": [{"id": "H1", "category": "TRUST_AND_RISK", "statement": "Price is the barrier.", "basis": "STATED_BY_PROSPECT", "supporting_observations": ["O1"],
                 "contradicting_observations": [], "competing_hypotheses": [], "confidence": "MEDIUM", "uncertainty": "No budget stated."}],
 "unknowns": [],
 "recommendation": {"pursue": "UNKNOWN", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [],
                    "next_action": {"type": "ASK_DIAGNOSTIC_QUESTION", "text": "Ask what budget would work."}},
 "contact_restrictions": [], "reasons_not_to_pursue": []}
JSON
}
complete() { as "$1" service "select public.internal_complete_analysis('$2', 'COMPLETE', 'synthetic-model', 'test', \$j\$$3\$j\$::jsonb, ${4:-null}, null, '[]')" >/dev/null; }
data_rows() { sql "$1" "select (select count(*) from public.cases)||'/'||(select count(*) from public.analyses)||'/'||(select count(*) from public.contact_restrictions)||'/'||(select count(*) from public.audit_log where action not in ('SCHEMA_DEPLOYED', 'SCHEMA_ROLLED_BACK'))"; }

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a5a.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, changes policies or grants" '! grep -niE "disable row level security|session_replication_role|create policy|drop policy|alter policy|grant " "$f" >/dev/null'
  check "$n never deletes rows" '! grep -niE "^\s*delete from|truncate|drop table" "$f" >/dev/null'
done
check "rollback restores internal_complete_analysis exactly as Stage 2A-1 defined it" \
  'diff <(sed -n "/^create or replace function public.internal_complete_analysis(/,/^end \\\$\\\$;/p" "$ROLLBACK" | sed "1s/create or replace/create/") <(sed -n "/^create function public.internal_complete_analysis(/,/^end \\\$\\\$;/p" "$HERE/migrations/20261009120200_stage2a1_functions.sql") >/dev/null'

echo "== Control: without the contract a fabricated analysis is stored (Stage 2A-4c-1 only)"
ctl=$(new_db); seed "$ctl"; a=$(start "$ctl"); complete "$ctl" "$a" "$FAKE" "'GREEN'"
check "control: an output with no evidence is stored as COMPLETE (defect reproduced)" '[ "$(status_of "$ctl" "$a")" = COMPLETE ]'

echo "== Deployment"
db=$(new_db); seed "$db"; rows=$(data_rows "$db")
check "verification reports FAIL before deployment" '[[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "2A-5a verify: PASS (8 pass, 0 fail, 1 info)" '[ "$(overall "$db" "$VERIFY")" = "PASS (8 pass, 0 fail, 1 info)" ]'
check "2A-4c-1, 2A-4c, 2A-4b and 2A-1 verifications still all OVERALL PASS" 'all_pass "$db"'
check "deployment changed no data" '[ "$(data_rows "$db")" = "$rows" ]'
check "verification is read-only" 's1=$(snapshot "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ]'
deployed="$db"

echo "== The contract on the deployed database"
a=$(start "$db"); complete "$db" "$a" "$FAKE" "'GREEN'"
check "a fabricated analysis is refused: stored as ERROR (REJECTED…)" '[[ "$(status_of "$db" "$a")" == "ERROR:REJECTED by analysis contract rre-analysis/1"* ]] && [ "$(sql "$db" "select output is null and ai_classification is null from public.analyses where id = '"'"'$a'"'"'")" = t ]'
check "the case went back to SUBMITTED" '[ "$(sql "$db" "select c.workflow_state from public.cases c join public.analyses a on a.case_id = c.id where a.id = '"'"'$a'"'"'")" = SUBMITTED ]'
a=$(start "$db"); complete "$db" "$a" "$(valid "$db" "$a")"
check "a valid evidence-grounded analysis is stored as COMPLETE" '[ "$(status_of "$db" "$a")" = COMPLETE ]'
out=$(as "$db" "$A_USER" "select count(*) from public.analyses")
check "the business user reads no analysis" '[ "$(tail -1 <<<"$out")" = 0 ]'
out=$(as "$db" "$F_USER" "select count(*) from public.analyses where output ? 'hypotheses'")
check "the founder reads the analysis" '[ "$(tail -1 <<<"$out")" = 1 ]'
out=$(as "$db" "$A_USER" "select private.analysis_output_problems(null::public.analyses, 'COMPLETE', '{}', null, null, '[]')")
check "the business user cannot call the contract" 'grep -q "permission denied" <<<"$out"'

echo "== Re-running, single-query mode, failures"
snap=$(snapshot "$deployed"); out=$(run_single "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-5a is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && all_pass "$db"'
broken="$WORK/broken.sql"
for weak in "create or replace function private.analysis_output_problems(p_analysis public.analyses, p_status public.analysis_status, p_output jsonb, p_ai_classification public.classification, p_ai_proposed_message text, p_detected_restrictions jsonb) returns text[] language sql security definer set search_path = '' as \$n\$ select '{}'::text[] \$n\$" \
            "grant execute on function private.ac_norm(text) to authenticated" \
            "create policy leak on public.analyses for select to authenticated using (true)"; do
  awk -v w="$weak; -- weakness" '/POST-INSTALL SELF-CHECK/ && !done {print w; done=1} {print}' "$DEPLOY" > "$broken"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts and rolls back: ${weak:0:58}…" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(new_db "" no4c); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-4c" 'grep -q "Stage 2A-4c is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses"
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "create or replace function private.analysis_output_problems(p_analysis public.analyses, p_status public.analysis_status, p_output jsonb, p_ai_classification public.classification, p_ai_proposed_message text, p_detected_restrictions jsonb) returns text[] language sql security definer set search_path = '' as 'select ''{}''::text[]'" >/dev/null
check "a neutered contract: row 7 FAIL, OVERALL FAIL" '[ "$(row "$db" "$VERIFY" 7)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
sql "$db" "grant execute on function private.ac_text(jsonb, integer) to authenticated" >/dev/null
check "a contract function callable by clients: row 3 FAIL" '[ "$(row "$db" "$VERIFY" 3)" = FAIL ]'
sql "$db" "create policy leak on public.analyses for select to authenticated using (true)" >/dev/null
check "analyses readable by clients: row 6 FAIL" '[ "$(row "$db" "$VERIFY" 6)" = FAIL ]'

echo "== Rollback"
rows=$(data_rows "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "rollback succeeds with its self-check" '! grep -q ERROR <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback kept every analysis, restriction and audit entry" '[ "$(data_rows "$deployed")" = "$rows" ]'
ref=$(new_db)
check "internal_complete_analysis is again byte-identical to Stage 2A-1 (body, owner, privileges)" \
  '[ "$(sql "$deployed" "select md5(prosrc || proacl::text || proowner::regrole::text) from pg_proc where proname = '"'"'internal_complete_analysis'"'"'")" = "$(sql "$ref" "select md5(prosrc || proacl::text || proowner::regrole::text) from pg_proc where proname = '"'"'internal_complete_analysis'"'"'")" ]'
check "after rollback: earlier verifications PASS; 2A-5a verify FAILs" 'all_pass_prev() { [[ "$(overall "$1" "$V4C1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V1")" == "PASS ("*" 0 fail"* ]]; }; all_pass_prev "$deployed" && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
check "rollback is audited" '[ "$(sql "$deployed" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-5a'"'"'")" = 1 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-5a is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploying after rollback works" '! grep -q ERROR <<<"$out" && all_pass "$deployed"'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

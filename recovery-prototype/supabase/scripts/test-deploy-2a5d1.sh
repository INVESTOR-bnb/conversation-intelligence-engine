#!/usr/bin/env bash
# Tests the Stage 2A-5d-1 restriction-contract deployment, verification and rollback
# against throwaway local PostgreSQL databases that first get Stage 2A-1, 2A-4b,
# 2A-4c, 2A-4c-1, 2A-5a and 2A-5b via their deployment files. Storage is a local
# emulation (tests/local/00_supabase_emulation.sql). No network, no secrets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a5d1_deploy.sql"; VERIFY="$D/stage2a5d1_verify.sql"; ROLLBACK="$D/stage2a5d1_rollback.sql"
V5B="$D/stage2a5b_verify.sql"; ROLLBACK5B="$D/stage2a5b_rollback.sql"; V5A="$D/stage2a5a_verify.sql"
V4C="$D/stage2a4c_verify.sql"; V4C1="$D/stage2a4c1_verify.sql"
V1="$D/stage2a1_verify.sql"; V4B="$D/stage2a4b_verify.sql"
KNOWN="$D/known/rls_auto_enable.verified.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54337}"
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
all_pass() { [[ "$(overall "$1" "$VERIFY")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V5B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V5A")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V1")" == "PASS ("*" 0 fail"* ]]; }
unused_storage_policies() { sql "$1" "select coalesce(string_agg(policyname, ',' order by policyname), '') from pg_policies where schemaname = 'storage'"; }
unused_evidence() { sql "$1" "select (select count(*) from public.case_screenshots)||'/'||(select count(*) from public.audit_log where action <> 'SCHEMA_ROLLED_BACK')||'/'||(select count(*) from storage.objects)"; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 4 ] || { echo "could not prepare emulation copy"; exit 1; }

# new_db [no5b]
new_db() {
  local db="t_$(date +%s%N)_$RANDOM"
  sql postgres "create database $db" >/dev/null
  run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }
  local f
  for f in stage2a1 stage2a4b stage2a4c stage2a4c1 stage2a5a; do
    run_file "$db" "$D/${f}_deploy.sql" >/dev/null || { echo "$f failed" >&2; exit 1; }
  done
  if [ "${1:-}" != no5b ]; then run_file "$db" "$D/stage2a5b_deploy.sql" >/dev/null || { echo "2A-5b failed" >&2; exit 1; }; fi
  echo "$db"
}

# Synthetic: business A with client A and the founder.
A_USER=00000000-0000-4000-8000-0000000000a1; F_USER=00000000-0000-4000-8000-0000000000f1
A_BIZ=10000000-0000-4000-8000-0000000000a1
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
# text_case <db> [restriction-kind]: a submitted TEXT case, optionally restricted by the founder before analysis.
text_case() {
  local c; c=$(as "$1" "$A_USER" "select public.client_create_case(gen_random_uuid(), 'RC-$RANDOM', 'Synthetic', 'Referral', 'TEXT', 'Prospect: I like it but the price is high. Business: Noted, synthetic.')" | tail -1)
  as "$1" "$A_USER" "select public.client_submit_case('$c')" >/dev/null
  if [ -n "${2:-}" ]; then as "$1" "$F_USER" "select public.founder_add_restriction('$c', '$2', 'Synthetic restriction.')" >/dev/null; fi
  echo "$c"
}
start() { as "$1" "$F_USER" "select public.founder_start_analysis('$2')" | tail -1; }
ev() { sql "$1" "select evidence_version from public.cases where id = '$2'"; }
# output <db> <case> <GREEN|UNKNOWN|RED>: a contract-valid rre-analysis/1 output citing the pasted conversation
output() {
  local m rec; m=$(sql "$1" "select id from public.case_messages where case_id = '$2' and kind = 'PASTED_CONVERSATION'")
  case "$3" in
    GREEN) rec='{"pursue": "PURSUE", "strategy": "Synthetic strategy.", "psychological_rationale": "Synthetic rationale.", "based_on_hypotheses": ["H1"], "next_action": {"type": "SEND_MESSAGE", "text": "Synthetic pitch."}}';;
    UNKNOWN) rec='{"pursue": "UNKNOWN", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [], "next_action": {"type": "ASK_DIAGNOSTIC_QUESTION", "text": "Ask whether the price is the only obstacle."}}';;
    RED) rec='{"pursue": "DO_NOT_PURSUE", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [], "next_action": {"type": "STOP_CONTACT", "text": "Do not contact the prospect again."}}';;
  esac
  cat <<JSON
{"contract_version": "rre-analysis/1", "evidence_assessment": {"sufficiency": "SUFFICIENT", "summary": "Synthetic.", "missing_evidence": []},
 "observations": [{"id": "O1", "actor": "PROSPECT", "behavior": "Said the price is high.", "evidence": [{"type": "MESSAGE", "message_id": "$m", "quote": "the price is high"}]}],
 "hypotheses": [{"id": "H1", "category": "TRUST_AND_RISK", "statement": "The price feels too high.", "basis": "STATED_BY_PROSPECT", "supporting_observations": ["O1"],
   "contradicting_observations": [], "competing_hypotheses": [], "confidence": "MEDIUM", "uncertainty": "No target price was given."}],
 "unknowns": [], "recommendation": $rec, "contact_restrictions": [],
 "reasons_not_to_pursue": $( [ "$3" = RED ] && echo '[{"reason": "Synthetic reason.", "evidence": []}]' || echo '[]')}
JSON
}
# analyse <db> <case> <GREEN|UNKNOWN|RED>: runs one analysis; prints its stored status
analyse() {
  local a cls=null msg=null; a=$(start "$1" "$2")
  case "$3" in GREEN) cls="'GREEN'"; msg="'Synthetic pitch.'";; RED) cls="'RED'";; esac
  as "$1" service "select public.internal_complete_analysis('$a', 'COMPLETE', 'synthetic-model', 'test', \$j\$$(output "$1" "$2" "$3")\$j\$::jsonb, $cls, $msg, '[]')" >/dev/null
  sql "$1" "select status from public.analyses where id = '$a'"
}
data_rows() { sql "$1" "select (select count(*) from public.cases)||'/'||(select count(*) from public.analyses)||'/'||(select count(*) from public.contact_restrictions)||'/'||(select sum(evidence_version) from public.cases)||'/'||(select count(*) from public.audit_log where action not in ('SCHEMA_DEPLOYED', 'SCHEMA_ROLLED_BACK'))"; }
# scenarios <db>: one word per scenario
scenarios() {
  local db=$1
  echo "R1=$(analyse "$db" "$(text_case "$db" EXPLICIT_OPT_OUT)" GREEN)"     # restricted, model says GREEN + message
  echo "R2=$(analyse "$db" "$(text_case "$db" PROHIBITED_CONTACT)" UNKNOWN)" # restricted, model says ask a question
  echo "R3=$(analyse "$db" "$(text_case "$db" OTHER)" RED)"                  # restricted, model says stop
  echo "U1=$(analyse "$db" "$(text_case "$db")" GREEN)"                      # unrestricted, model says GREEN
}
fn_md5() { sql "$1" "select md5(prosrc || proacl::text || proowner::regrole::text || prosecdef::text || proconfig::text) from pg_proc where oid = 'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'::regprocedure"; }

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a5d1.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, changes policies, grants or triggers" '! grep -niE "disable row level security|session_replication_role|create policy|drop policy|alter policy|grant |create trigger|drop trigger|create table|alter table" "$f" >/dev/null'
  check "$n never deletes rows" '! grep -niE "^\s*delete from|truncate|drop table|drop function" "$f" >/dev/null'
done
check "the migration replaces exactly one function and creates nothing else" \
  '[ "$(grep -ciE "^create (or replace )?(function|table|trigger|policy|view|type)" "$HERE/migrations/20261016120000_stage2a5d1_restriction_contract.sql")" = 1 ] && grep -q "^create or replace function private.analysis_output_problems(" "$HERE/migrations/20261016120000_stage2a5d1_restriction_contract.sql"'
extract() { sed -n "/^create or replace function private.analysis_output_problems(/,/^end \\\$\\\$;/p" "$1" | sed "1s/create or replace/create/"; }
check "rollback restores the contract exactly as Stage 2A-5a defined it" \
  'diff <(extract "$ROLLBACK") <(sed -n "/^create function private.analysis_output_problems(/,/^end \\\$\\\$;/p" "$HERE/migrations/20261014120000_stage2a5a_analysis_contract.sql") >/dev/null'

echo "== Control: the gap reproduced without 2A-5d-1 (Stage 2A-5b installed)"
ctl=$(new_db); seed "$ctl"; res=$(scenarios "$ctl")
check "control: a GREEN analysis with a message is ACCEPTED on a case restricted before analysis" 'grep -q "R1=COMPLETE" <<<"$res"'
check "control: an 'ask a question' analysis is ACCEPTED on a restricted case" 'grep -q "R2=COMPLETE" <<<"$res"'
check "the preflight's reviewed-contract md5 matches the deployed Stage 2A-5a body" \
  '[ "$(sql "$ctl" "select md5(prosrc) from pg_proc where oid = '"'"'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'"'"'::regprocedure")" = c72fd76ccb48d0e412442f91ea0619ff ]'

echo "== Deployment"
db=$(new_db); seed "$db"; rows=$(data_rows "$db")
check "verification reports FAIL before deployment" '[[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "2A-5d-1 verify: PASS (7 pass, 0 fail, 2 info)" '[ "$(overall "$db" "$VERIFY")" = "PASS (7 pass, 0 fail, 2 info)" ]'
check "2A-5b, 2A-5a, 2A-4c-1, 2A-4c, 2A-4b and 2A-1 verifications still all OVERALL PASS" 'all_pass "$db"'
check "deployment changed no data" '[ "$(data_rows "$db")" = "$rows" ]'
check "verification is read-only" 's1=$(snapshot "$db"); d1=$(data_rows "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ] && [ "$(data_rows "$db")" = "$d1" ]'
check "the contract keeps its owner and privileges (no API role)" \
  '[ "$(sql "$db" "select proacl::text from pg_proc where oid = '"'"'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'"'"'::regprocedure")" = "$(sql "$ctl" "select proacl::text from pg_proc where oid = '"'"'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'"'"'::regprocedure")" ]'
deployed="$db"

echo "== Regression on the deployed database"
res=$(scenarios "$db")
check "a GREEN analysis with a message is REJECTED on a restricted case" 'grep -q "R1=ERROR" <<<"$res"'
check "an 'ask a question' analysis is REJECTED on a restricted case" 'grep -q "R2=ERROR" <<<"$res"'
check "a RED stop-contact analysis is accepted on a restricted case" 'grep -q "R3=COMPLETE" <<<"$res"'
check "legitimate: a GREEN analysis of an unrestricted case is still accepted" 'grep -q "U1=COMPLETE" <<<"$res"'
c=$(text_case "$db"); st=$(analyse "$db" "$c" GREEN); a=$(sql "$db" "select id from public.analyses where case_id = '$c'")
out=$(as "$db" "$F_USER" "select public.founder_approve('$c', '$a', $(ev "$db" "$c"), 'GREEN', 'Interested.', 'Send the message.', 'Synthetic pitch.', 'UNCHANGED')")
check "legitimate: that analysis can still be approved unchanged" '[ "$st" = COMPLETE ] && ! grep -q ERROR <<<"$out"'
out=$(as "$db" "$A_USER" "select (select count(*) from public.analyses) + (select count(*) from public.contact_restrictions)")
check "the business user reads no analysis and no restriction" '[ "$(tail -1 <<<"$out")" = 0 ]'

echo "== Re-running, single-query mode, failures"
snap=$(snapshot "$deployed"); out=$(run_single "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-5d-1 is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && all_pass "$db"'
broken="$WORK/broken.sql"
for weak in "grant execute on function private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb) to authenticated" \
            "alter function private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb) reset all" \
            "create policy leak on public.analyses for select to authenticated using (true)"; do
  awk -v w="$weak; -- weakness" '/POST-INSTALL SELF-CHECK/ && !done {print w; done=1} {print}' "$DEPLOY" > "$broken"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts and rolls back: ${weak:0:58}…" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done
# A rule that does not actually block (the reviewed text kept, the check disabled) is caught by the behaviour self-test.
sed 's/^  if v_restricted then$/  if v_restricted and false then/' "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
check "self-check aborts when the rule is present but does not block" '[ "$(grep -c "^  if v_restricted and false then$" "$broken")" = 1 ] && grep -q "the restriction rule does not behave as reviewed" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Preflight refusals"
db=$(new_db no5b); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-5b" 'grep -q "Stage 2A-5b (evidence integrity) is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db)
sql "$db" "do \$x\$ begin execute replace(pg_get_functiondef('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'::regprocedure), 'Fail closed: anything unexpected', 'Fail closed (changed outside the deployment files): anything unexpected'); end \$x\$" >/dev/null
check "fixture: the contract body really was changed" '[ "$(sql "$db" "select md5(prosrc) from pg_proc where oid = '"'"'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'"'"'::regprocedure")" != c72fd76ccb48d0e412442f91ea0619ff ]'
before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when the contract was changed outside the deployment files" 'grep -q "not the reviewed Stage 2A-5a version" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses"
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "grant execute on function private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb) to authenticated" >/dev/null
check "the contract callable by clients: row 2 FAIL, OVERALL FAIL" '[ "$(row "$db" "$VERIFY" 2)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "do \$x\$ begin execute replace(pg_get_functiondef('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'::regprocedure), '  if v_restricted then', '  if v_restricted and false then'); end \$x\$" >/dev/null
check "a rule that no longer blocks: row 4 FAIL, OVERALL FAIL" '[ "$(row "$db" "$VERIFY" 4)" = FAIL ] && [ "$(row "$db" "$VERIFY" 3)" = PASS ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
sql "$db" "create policy leak on public.contact_restrictions for select to authenticated using (true)" >/dev/null
check "a leaking restriction policy: row 6 FAIL" '[ "$(row "$db" "$VERIFY" 6)" = FAIL ]'

echo "== Rollback"
before=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK5B" || true)
check "2A-5b rollback is refused while 2A-5d-1 is installed (nothing changed)" 'grep -q "run stage2a5d1_rollback.sql first" <<<"$out" && [ "$(snapshot "$deployed")" = "$before" ]'
rows=$(data_rows "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "2A-5d-1 rollback succeeds with its self-check" '! grep -q ERROR <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback kept every analysis, restriction, audit entry and evidence version" '[ "$(data_rows "$deployed")" = "$rows" ]'
check "the contract is again identical to Stage 2A-5a (body, owner, privileges, settings)" '[ "$(fn_md5 "$deployed")" = "$(fn_md5 "$ctl")" ]'
check "after rollback: 2A-5b, 2A-5a and 2A-1 verifications PASS; 2A-5d-1 verify FAILs" '[[ "$(overall "$deployed" "$V5B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$V5A")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$V1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
res=$(scenarios "$deployed")
check "after rollback the gap is back (control behaviour): R1 accepted" 'grep -q "R1=COMPLETE" <<<"$res"'
check "rollback is audited" '[ "$(sql "$deployed" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-5d-1'"'"'")" = 1 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-5d-1 is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploying after rollback works" '! grep -q ERROR <<<"$out" && all_pass "$deployed"'
out=$(run_file "$deployed" "$ROLLBACK" || true); out2=$(run_file "$deployed" "$ROLLBACK5B" || true)
check "full reverse order works: 2A-5d-1 rollback, then 2A-5b rollback" '! grep -q ERROR <<<"$out" && ! grep -q ERROR <<<"$out2" && grep -q "Rollback self-check passed" <<<"$out2"'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

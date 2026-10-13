#!/usr/bin/env bash
# Tests the Stage 2A-5d-2 adversarial-review contract deployment, verification and
# rollback against throwaway local PostgreSQL databases that first get Stage 2A-1,
# 2A-4b, 2A-4c, 2A-4c-1, 2A-5a, 2A-5b and 2A-5d-1 via their deployment files. Storage is a local
# emulation (tests/local/00_supabase_emulation.sql). No network, no secrets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a5d2_deploy.sql"; VERIFY="$D/stage2a5d2_verify.sql"; ROLLBACK="$D/stage2a5d2_rollback.sql"
V5D1="$D/stage2a5d1_verify.sql"; ROLLBACK5D1="$D/stage2a5d1_rollback.sql"
V5B="$D/stage2a5b_verify.sql"; V5A="$D/stage2a5a_verify.sql"
V4C="$D/stage2a4c_verify.sql"; V4C1="$D/stage2a4c1_verify.sql"
V1="$D/stage2a1_verify.sql"; V4B="$D/stage2a4b_verify.sql"
KNOWN="$D/known/rls_auto_enable.verified.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54338}"
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
all_pass() { [[ "$(overall "$1" "$VERIFY")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V5D1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V5B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V5A")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V1")" == "PASS ("*" 0 fail"* ]]; }
unused_storage_policies() { sql "$1" "select coalesce(string_agg(policyname, ',' order by policyname), '') from pg_policies where schemaname = 'storage'"; }
unused_evidence() { sql "$1" "select (select count(*) from public.case_screenshots)||'/'||(select count(*) from public.audit_log where action <> 'SCHEMA_ROLLED_BACK')||'/'||(select count(*) from storage.objects)"; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 4 ] || { echo "could not prepare emulation copy"; exit 1; }

# new_db [no5d1]
new_db() {
  local db="t_$(date +%s%N)_$RANDOM"
  sql postgres "create database $db" >/dev/null
  run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }
  local f
  for f in stage2a1 stage2a4b stage2a4c stage2a4c1 stage2a5a stage2a5b; do
    run_file "$db" "$D/${f}_deploy.sql" >/dev/null || { echo "$f failed" >&2; exit 1; }
  done
  if [ "${1:-}" != no5d1 ]; then run_file "$db" "$D/stage2a5d1_deploy.sql" >/dev/null || { echo "2A-5d-1 failed" >&2; exit 1; }; fi
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
# output <db> <case> <GREEN|WAIT|RED> [review-json]: a contract-valid output citing the pasted conversation;
# with a review it is rre-analysis/2, otherwise rre-analysis/1
output() {
  local m rec cv=rre-analysis/1 review=""; m=$(sql "$1" "select id from public.case_messages where case_id = '$2' and kind = 'PASTED_CONVERSATION'")
  case "$3" in
    GREEN) rec='{"pursue": "PURSUE", "strategy": "Synthetic strategy.", "psychological_rationale": "Synthetic rationale.", "based_on_hypotheses": ["H1"], "next_action": {"type": "SEND_MESSAGE", "text": "SYNTHETIC-PITCH"}}';;
    WAIT) rec='{"pursue": "UNKNOWN", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [], "next_action": {"type": "WAIT", "text": "Wait for a reply."}}';;
    RED) rec='{"pursue": "DO_NOT_PURSUE", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [], "next_action": {"type": "STOP_CONTACT", "text": "Do not contact the prospect again."}}';;
  esac
  if [ -n "${4:-}" ]; then cv=rre-analysis/2; review=", \"adversarial_review\": ${4//__M__/$m}"; fi
  cat <<JSON
{"contract_version": "$cv", "evidence_assessment": {"sufficiency": "SUFFICIENT", "summary": "Synthetic.", "missing_evidence": []},
 "observations": [{"id": "O1", "actor": "PROSPECT", "behavior": "Said the price is high.", "evidence": [{"type": "MESSAGE", "message_id": "$m", "quote": "the price is high"}]}],
 "hypotheses": [{"id": "H1", "category": "TRUST_AND_RISK", "statement": "The price feels too high.", "basis": "STATED_BY_PROSPECT", "supporting_observations": ["O1"],
   "contradicting_observations": [], "competing_hypotheses": [], "confidence": "MEDIUM", "uncertainty": "No target price was given."}],
 "unknowns": [], "recommendation": $rec, "contact_restrictions": [],
 "reasons_not_to_pursue": $( [ "$3" = RED ] && echo '[{"reason": "Synthetic reason.", "evidence": []}]' || echo '[]')$review}
JSON
}
REVIEW_OK='{"challenges": [{"id": "C1", "target": "OBSERVATION", "target_id": "O1", "severity": "MEDIUM", "challenge": "SYNTHETIC-REVIEW: may be a negotiation tactic.", "evidence": [{"type": "MESSAGE", "message_id": "__M__", "quote": "the price is high"}]}], "verdict": "UPHOLD_WITH_CONCERNS", "verdict_rationale": "Synthetic."}'
REVIEW_FAB='{"challenges": [{"id": "C1", "target": "HYPOTHESIS", "target_id": "H1", "severity": "HIGH", "challenge": "SYNTHETIC-REVIEW", "evidence": [{"type": "MESSAGE", "message_id": "__M__", "quote": "I already bought elsewhere"}]}], "verdict": "REJECT_RECOMMENDATION", "verdict_rationale": "Synthetic."}'
REVIEW_REJECT='{"challenges": [{"id": "C1", "target": "RECOMMENDATION", "severity": "HIGH", "challenge": "SYNTHETIC-REVIEW: pushing now risks losing the prospect.", "evidence": []}], "verdict": "REJECT_RECOMMENDATION", "verdict_rationale": "Synthetic."}'
REVIEW_UPHOLD='{"challenges": [], "verdict": "UPHOLD", "verdict_rationale": "Synthetic."}'
# analyse <db> <case> <GREEN|WAIT|RED> [review]: runs one analysis; prints status/message-stored
analyse() {
  local a cls=null msg=null; a=$(start "$1" "$2")
  case "$3" in GREEN) cls="'GREEN'"; msg="'SYNTHETIC-PITCH'";; RED) cls="'RED'";; esac
  as "$1" service "select public.internal_complete_analysis('$a', 'COMPLETE', 'synthetic-model', 'test', \$j\$$(output "$1" "$2" "$3" "${4:-}")\$j\$::jsonb, $cls, $msg, '[]')" >/dev/null
  sql "$1" "select status || case when coalesce(ai_proposed_message, '') || coalesce(output::text, '') like '%SYNTHETIC-PITCH%' then '+MSG' else '' end from public.analyses where id = '$a'"
}
data_rows() { sql "$1" "select (select count(*) from public.cases)||'/'||(select count(*) from public.analyses)||'/'||(select count(*) from public.contact_restrictions)||'/'||(select sum(evidence_version) from public.cases)||'/'||(select count(*) from public.audit_log where action not in ('SCHEMA_DEPLOYED', 'SCHEMA_ROLLED_BACK'))"; }
scenarios() {
  local db=$1
  echo "V1=$(analyse "$db" "$(text_case "$db")" GREEN)"                                   # rre-analysis/1, no review
  echo "V2=$(analyse "$db" "$(text_case "$db")" GREEN "$REVIEW_OK")"                       # rre-analysis/2, valid review
  echo "FAB=$(analyse "$db" "$(text_case "$db")" WAIT "$REVIEW_FAB")"                      # fabricated quote in the review
  echo "REJMSG=$(analyse "$db" "$(text_case "$db")" GREEN "$REVIEW_REJECT")"               # review rejects, message kept
  echo "REJWAIT=$(analyse "$db" "$(text_case "$db")" WAIT "$REVIEW_REJECT")"               # review rejects, WAIT
  echo "RV2=$(analyse "$db" "$(text_case "$db" EXPLICIT_OPT_OUT)" GREEN "$REVIEW_UPHOLD")" # restricted, review upholds contact
}
CONTRACT="private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)"
fn_md5() { sql "$1" "select md5(prosrc || proacl::text || proowner::regrole::text || prosecdef::text || proconfig::text) from pg_proc where oid = '$CONTRACT'::regprocedure"; }
body_md5() { sql "$1" "select md5(prosrc) from pg_proc where oid = '$CONTRACT'::regprocedure"; }

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a5d2.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, changes policies, grants, triggers, tables or views" '! grep -niE "disable row level security|session_replication_role|create policy|drop policy|alter policy|grant |create trigger|drop trigger|create table|alter table|create view|create or replace view" "$f" >/dev/null'
  check "$n never deletes rows" '! grep -niE "^\s*delete from|truncate|drop table|drop function" "$f" >/dev/null'
done
check "the migration replaces exactly one function and creates nothing else" \
  '[ "$(grep -ciE "^create (or replace )?(function|table|trigger|policy|view|type)" "$HERE/migrations/20261017120000_stage2a5d2_adversarial_review.sql")" = 1 ] && grep -q "^create or replace function private.analysis_output_problems(" "$HERE/migrations/20261017120000_stage2a5d2_adversarial_review.sql"'
extract() { sed -n "/^create or replace function private.analysis_output_problems(/,/^end \\\$\\\$;/p" "$1"; }
check "rollback restores the contract exactly as Stage 2A-5d-1 defined it" \
  'diff <(extract "$ROLLBACK") <(extract "$HERE/migrations/20261016120000_stage2a5d1_restriction_contract.sql") >/dev/null'

echo "== Control: without 2A-5d-2 (Stage 2A-5d-1 installed) no review can be stored"
ctl=$(new_db); seed "$ctl"; res=$(scenarios "$ctl")
check "control: an analysis WITH an adversarial review cannot be stored (rre-analysis/2 unknown)" 'grep -q "V2=ERROR" <<<"$res" && grep -q "REJWAIT=ERROR" <<<"$res"'
check "control: rre-analysis/1 is accepted" 'grep -q "V1=COMPLETE+MSG" <<<"$res"'
check "the preflight's reviewed-contract md5 matches the deployed Stage 2A-5d-1 body" '[ "$(body_md5 "$ctl")" = bf447c01cdd3897008436b017d91906b ]'

echo "== Deployment"
db=$(new_db); seed "$db"; rows=$(data_rows "$db")
check "verification reports FAIL before deployment" '[[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "2A-5d-2 verify: PASS (9 pass, 0 fail, 2 info)" '[ "$(overall "$db" "$VERIFY")" = "PASS (9 pass, 0 fail, 2 info)" ]'
check "2A-5d-1, 2A-5b, 2A-5a, 2A-4c-1, 2A-4c, 2A-4b and 2A-1 verifications still all OVERALL PASS" 'all_pass "$db"'
check "deployment changed no data" '[ "$(data_rows "$db")" = "$rows" ]'
check "verification is read-only" 's1=$(snapshot "$db"); d1=$(data_rows "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ] && [ "$(data_rows "$db")" = "$d1" ]'
check "the contract keeps its owner and privileges (no API role)" \
  '[ "$(sql "$db" "select proacl::text || proowner::regrole::text from pg_proc where oid = '"'"'$CONTRACT'"'"'::regprocedure")" = "$(sql "$ctl" "select proacl::text || proowner::regrole::text from pg_proc where oid = '"'"'$CONTRACT'"'"'::regprocedure")" ]'
deployed="$db"

echo "== Regression on the deployed database"
res=$(scenarios "$db")
check "rre-analysis/1 is still accepted (compatibility)" 'grep -q "V1=COMPLETE+MSG" <<<"$res"'
check "rre-analysis/2 with a valid review is accepted" 'grep -q "V2=COMPLETE+MSG" <<<"$res"'
check "a fabricated citation in the review discards the analysis" 'grep -q "FAB=ERROR$" <<<"$res"'
check "a rejecting review that keeps a message discards the analysis (nothing stored)" 'grep -q "REJMSG=ERROR$" <<<"$res"'
check "a rejecting review with WAIT is stored, with no contact message anywhere" 'grep -q "REJWAIT=COMPLETE$" <<<"$res"'
check "a review cannot override an active restriction (2A-5d-1)" 'grep -q "RV2=ERROR$" <<<"$res"'
out=$(as "$db" "$A_USER" "select (select count(*) from public.analyses) + (select count(*) from public.contact_restrictions)")
check "the business user reads no analysis, review or restriction" '[ "$(tail -1 <<<"$out")" = 0 ]'
c=$(sql "$db" "select case_id from public.analyses where output ? 'adversarial_review' limit 1")
out=$(as "$db" "$A_USER" "select public.client_get_case('$c')::text || (select coalesce(string_agg(l::text, ''), '') from public.client_list_cases() l)")
check "the client's case RPCs carry nothing from the review" '! grep -qiE "SYNTHETIC-REVIEW|adversarial|verdict" <<<"$out" && grep -q UNDER_REVIEW <<<"$out"'

echo "== Re-running, single-query mode, failures"
snap=$(snapshot "$deployed"); out=$(run_single "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-5d-2 is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && all_pass "$db"'
broken="$WORK/broken.sql"
for weak in "grant execute on function $CONTRACT to authenticated" \
            "alter function $CONTRACT reset all" \
            "create policy leak on public.analyses for select to authenticated using (true)" \
            "create view public.analysis_feed as select output from public.analyses"; do
  awk -v w="$weak; -- weakness" '/POST-INSTALL SELF-CHECK/ && !done {print w; done=1} {print}' "$DEPLOY" > "$broken"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts and rolls back: ${weak:0:58}…" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done
# Rules present in the text but disabled are caught by the behaviour self-test.
FROMS=("private.ac_refs_problems(p_analysis, v_r.c -> 'evidence', v_w || '.evidence', 0)" "      if v_verdict = 'REJECT_RECOMMENDATION' then")
TOS=("private.ac_refs_problems(p_analysis, '[]'::jsonb, v_w || '.evidence', 0)" "      if v_verdict = 'REJECT_RECOMMENDATION' and false then")
EXPECTS=("a fabricated review citation is not rejected" "a rejecting review does not prevent a contact message")
for i in 0 1; do
  python3 -I -c 'import sys; s=open(sys.argv[1]).read(); assert s.count(sys.argv[2])==1; open(sys.argv[3],"w").write(s.replace(sys.argv[2], sys.argv[4]))' "$DEPLOY" "${FROMS[$i]}" "$broken" "${TOS[$i]}"
  expect="${EXPECTS[$i]}"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts: $expect" 'grep -q "$expect" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(new_db no5d1); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-5d-1" 'grep -q "Stage 2A-5d-1 (restriction contract) is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db)
sql "$db" "do \$x\$ begin execute replace(pg_get_functiondef('$CONTRACT'::regprocedure), 'Fail closed: anything unexpected', 'Fail closed (changed outside the deployment files): anything unexpected'); end \$x\$" >/dev/null
check "fixture: the contract body really was changed" '[ "$(body_md5 "$db")" != bf447c01cdd3897008436b017d91906b ]'
before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when the contract was changed outside the deployment files" 'grep -q "not the reviewed Stage 2A-5d-1 version" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses"
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "grant execute on function $CONTRACT to authenticated" >/dev/null
check "the contract callable by clients: row 2 FAIL, OVERALL FAIL" '[ "$(row "$db" "$VERIFY" 2)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "do \$x\$ begin execute replace(pg_get_functiondef('$CONTRACT'::regprocedure), '      if v_verdict = ''REJECT_RECOMMENDATION'' then', '      if v_verdict = ''REJECT_RECOMMENDATION'' and false then'); end \$x\$" >/dev/null
check "a rejecting review that no longer blocks messages: row 5 FAIL, OVERALL FAIL" '[ "$(row "$db" "$VERIFY" 5)" = FAIL ] && [ "$(row "$db" "$VERIFY" 3)" = PASS ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
sql "$db" "create view public.analysis_feed as select output from public.analyses" >/dev/null
check "a view exposing analyses: row 8 FAIL" '[ "$(row "$db" "$VERIFY" 8)" = FAIL ]'

echo "== Rollback"
before=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK5D1" || true)
check "2A-5d-1 rollback is refused while 2A-5d-2 is installed (nothing changed)" 'grep -q "run stage2a5d2_rollback.sql first" <<<"$out" && [ "$(snapshot "$deployed")" = "$before" ]'
rows=$(data_rows "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "2A-5d-2 rollback succeeds with its self-check" '! grep -q ERROR <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback kept every analysis (stored reviews included), restriction, audit entry and evidence version" '[ "$(data_rows "$deployed")" = "$rows" ] && [ "$(sql "$deployed" "select count(*) > 0 from public.analyses where output ? '"'"'adversarial_review'"'"'")" = t ]'
check "the contract is again identical to Stage 2A-5d-1 (body, owner, privileges, settings)" '[ "$(fn_md5 "$deployed")" = "$(fn_md5 "$ctl")" ]'
check "after rollback: 2A-5d-1, 2A-5b, 2A-5a and 2A-1 verifications PASS; 2A-5d-2 verify FAILs" '[[ "$(overall "$deployed" "$V5D1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$V5B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$V5A")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$V1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
res=$(scenarios "$deployed")
check "after rollback: reviews cannot be stored again, rre-analysis/1 still accepted" 'grep -q "V2=ERROR" <<<"$res" && grep -q "V1=COMPLETE+MSG" <<<"$res"'
check "rollback is audited" '[ "$(sql "$deployed" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-5d-2'"'"'")" = 1 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-5d-2 is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploying after rollback works" '! grep -q ERROR <<<"$out" && all_pass "$deployed"'
out=$(run_file "$deployed" "$ROLLBACK" || true); out2=$(run_file "$deployed" "$ROLLBACK5D1" || true)
check "full reverse order works: 2A-5d-2 rollback, then 2A-5d-1 rollback" '! grep -q ERROR <<<"$out" && ! grep -q ERROR <<<"$out2" && grep -q "Rollback self-check passed" <<<"$out2"'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

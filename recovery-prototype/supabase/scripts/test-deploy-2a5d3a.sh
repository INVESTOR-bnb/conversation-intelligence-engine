#!/usr/bin/env bash
# Tests the Stage 2A-5d-3a AI spending controls deployment, verification and
# rollback against throwaway local PostgreSQL databases that first get Stage 2A-1
# through 2A-5d-2 via their deployment files. Storage is a local emulation
# (tests/local/00_supabase_emulation.sql). No network, no secrets, no provider:
# "models" are synthetic price rows and usage is reported by hand.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a5d3a_deploy.sql"; VERIFY="$D/stage2a5d3a_verify.sql"; ROLLBACK="$D/stage2a5d3a_rollback.sql"
V5D2="$D/stage2a5d2_verify.sql"; ROLLBACK5D2="$D/stage2a5d2_rollback.sql"; ROLLBACK5D1="$D/stage2a5d1_rollback.sql"
V5D1="$D/stage2a5d1_verify.sql"; ROLLBACK5B="$D/stage2a5b_rollback.sql"
V5B="$D/stage2a5b_verify.sql"; V5A="$D/stage2a5a_verify.sql"
V4C="$D/stage2a4c_verify.sql"; V4C1="$D/stage2a4c1_verify.sql"
V1="$D/stage2a1_verify.sql"; V4B="$D/stage2a4b_verify.sql"
MIGRATION="$HERE/migrations/20261018120000_stage2a5d3a_ai_spending.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54341}"
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
earlier_pass() { local v; for v in "$V5D2" "$V5D1" "$V5B" "$V5A" "$V4C1" "$V4C" "$V4B" "$V1"; do passes "$1" "$v" || return 1; done; }
all_pass() { passes "$1" "$VERIFY" && earlier_pass "$1"; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; if [ -n "${DEBUG:-}" ]; then echo "      out: ${out:0:400}"; fi; fi; }

EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 4 ] || { echo "could not prepare emulation copy"; exit 1; }

# new_db [no5d2]
new_db() {
  local db="t_$(date +%s%N)_$RANDOM"
  sql postgres "create database $db" >/dev/null
  run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }
  local f
  for f in stage2a1 stage2a4b stage2a4c stage2a4c1 stage2a5a stage2a5b stage2a5d1; do
    run_file "$db" "$D/${f}_deploy.sql" >/dev/null || { echo "$f failed" >&2; exit 1; }
  done
  if [ "${1:-}" != no5d2 ]; then run_file "$db" "$D/stage2a5d2_deploy.sql" >/dev/null || { echo "2A-5d-2 failed" >&2; exit 1; }; fi
  echo "$db"
}

# Synthetic: business A with client A and the founder.
A_USER=00000000-0000-4000-8000-0000000000a1; F_USER=00000000-0000-4000-8000-0000000000f1
A_BIZ=10000000-0000-4000-8000-0000000000a1
# as <db> <user-id|service|service-noclaim|anon> <sql>: full output (errors included)
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
# text_case <db> [restriction-kind]: a submitted TEXT case (older cases are backdated so the
# client's 20-cases-per-day limit never interferes).
text_case() {
  sql "$1" "update public.cases set created_at = created_at - interval '2 days' where created_at > now() - interval '1 day'" >/dev/null
  local c; c=$(as "$1" "$A_USER" "select public.client_create_case(gen_random_uuid(), 'RC-$RANDOM', 'Synthetic', 'Referral', 'TEXT', 'Prospect: I like it but the price is high. Business: Noted, synthetic.')" | tail -1)
  as "$1" "$A_USER" "select public.client_submit_case('$c')" >/dev/null
  if [ -n "${2:-}" ]; then as "$1" "$F_USER" "select public.founder_add_restriction('$c', '$2', 'Synthetic restriction.')" >/dev/null; fi
  echo "$c"
}
start() { as "$1" "$F_USER" "select public.founder_start_analysis('$2')" | tail -1; }
# output <db> <case> <GREEN|WAIT|RED> [review-json]: contract-valid output (rre-analysis/2 with a review)
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
# complete <db> <analysis> <case> <GREEN|WAIT|RED> [review]: records a contract-valid result; prints status(+MSG)
complete() {
  local cls=null msg=null
  case "$4" in GREEN) cls="'GREEN'"; msg="'SYNTHETIC-PITCH'";; RED) cls="'RED'";; esac
  as "$1" service "select public.internal_complete_analysis('$2', 'COMPLETE', 'synthetic-model', 'test', \$j\$$(output "$1" "$3" "$4" "${5:-}")\$j\$::jsonb, $cls, $msg, '[]')" >/dev/null
  sql "$1" "select status || case when coalesce(ai_proposed_message, '') || coalesce(output::text, '') like '%SYNTHETIC-PITCH%' then '+MSG' else '' end from public.analyses where id = '$2'"
}
analyse() { complete "$1" "$(start "$1" "$2")" "$2" "$3" "${4:-}"; }
scenarios() {
  local db=$1
  echo "V1=$(analyse "$db" "$(text_case "$db")" GREEN)"
  echo "V2=$(analyse "$db" "$(text_case "$db")" GREEN "$REVIEW_OK")"
  echo "FAB=$(analyse "$db" "$(text_case "$db")" WAIT "$REVIEW_FAB")"
  echo "REJMSG=$(analyse "$db" "$(text_case "$db")" GREEN "$REVIEW_REJECT")"
  echo "REJWAIT=$(analyse "$db" "$(text_case "$db")" WAIT "$REVIEW_REJECT")"
  echo "RV2=$(analyse "$db" "$(text_case "$db" EXPLICIT_OPT_OUT)" GREEN "$REVIEW_UPHOLD")"
}
# Spending helpers (service role, as the pipeline will call them).
reserve() { as "$1" service "select public.internal_reserve_ai_spend('$2', '${3:-test-cheap}', '${4:-test-dear}')"; }
dispatch() { as "$1" service "select public.internal_ai_dispatch('$2', '$3')"; }
usage() { as "$1" service "select public.internal_ai_report_usage('$2', '$3', $4, $5)"; }
# fail_run <db> <analysis>: the pipeline records a failure and reports zero tokens and zero cost.
fail_run() { as "$1" service "select public.internal_complete_analysis('$2', 'ERROR', 'synthetic-model', 'test', p_input_tokens => 0, p_output_tokens => 0, p_estimated_cost_usd => 0, p_error => 'PROVIDER_ERROR: synthetic failure after dispatch')" >/dev/null; }
abandon() { as "$1" "$F_USER" "select public.founder_abandon_analysis('$2')"; }
ledger() { sql "$1" "select status || ':' || coalesce(settled_by, '-') || ':' || coalesce(actual_usd::text, '-') || ':' || overrun from private.ai_spend_ledger where analysis_id = '$2'"; }
reserved() { sql "$1" "select reserved_usd from private.ai_spend_ledger where analysis_id = '$2'"; }
committed() { sql "$1" "select private.ai_committed_usd()"; }
ledger_md5() { sql "$1" "select md5(string_agg(l::text, chr(10) order by analysis_id)) from private.ai_spend_ledger l"; }
ledger_rows() { sql "$1" "select count(*) from private.ai_spend_ledger"; }
# expect_usd <db> <analysis> <a_in> <a_out> <a_cap> <r_in> <r_out> <r_cap>: the reservation computed
# independently here from the snapshot (6 tokens per byte, 64 per message, 5000 per image, 8000 prompt
# overhead, reviewer also receives twice the analyst's output cap).
expect_usd() {
  sql "$1" "with s as (select coalesce(sum(octet_length(m.body)), 0) b, count(*) n,
                         (select jsonb_array_length(evidence_manifest -> 'screenshots') from public.analyses where id = '$2') i
                       from public.case_messages m
                       where m.id::text in (select jsonb_array_elements(evidence_manifest -> 'messages') ->> 'id' from public.analyses where id = '$2')),
            e as (select 6 * b + 64 * n + 5000 * i e from s)
            select (ceil(((8000 + e) * $3 + $5 * $4 + (8000 + e + 2 * $5) * $6 + $8 * $7) / 1000000.0 * 10000) / 10000)::numeric(12,4) from e"
}
age_ledger() { sql "$1" "update private.ai_spend_ledger set created_at = created_at - interval '25 hours'" >/dev/null; }
# cycle <db> <case>: start, reserve, abandon (no dispatch); prints the reservation outcome.
cycle() {
  local a out; a=$(start "$1" "$2"); out=$(reserve "$1" "$a"); abandon "$1" "$a" >/dev/null
  if grep -q reserved_usd <<<"$out"; then echo OK; else grep -m1 '^ERROR:' <<<"$out" | sed 's/^ERROR: *//'; fi
}
data_rows() { sql "$1" "select (select count(*) from public.cases)||'/'||(select count(*) from public.analyses)||'/'||(select count(*) from public.contact_restrictions)||'/'||(select sum(evidence_version) from public.cases)||'/'||(select count(*) from public.audit_log where action not in ('SCHEMA_DEPLOYED', 'SCHEMA_ROLLED_BACK'))"; }
ICA="public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)"
ABANDON="public.founder_abandon_analysis(uuid)"
fn_md5() { sql "$1" "select md5(prosrc || proacl::text || proowner::regrole::text || prosecdef::text || proconfig::text) from pg_proc where oid = '$2'::regprocedure"; }
body_md5() { sql "$1" "select md5(prosrc) from pg_proc where oid = '$2'::regprocedure"; }

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a5d3a.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|sb_secret_|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, changes policies, grants table access, or adds triggers or views" '! grep -niE "disable row level security|session_replication_role|create policy|drop policy|alter policy|grant [a-z, ]* on table|grant all|create trigger|drop trigger|create view|create or replace view|alter default privileges" "$f" >/dev/null'
  check "$n never grants anything to anon or public" '! grep -niE "grant .* to (anon|public)\b" "$f" >/dev/null'
  check "$n never deletes rows or drops tables" '! grep -niE "^\s*delete from|^\s*truncate|drop table|drop schema" "$f" >/dev/null'
done
check "deploy file drops nothing" '! grep -niE "^\s*drop " "$DEPLOY" >/dev/null'
check "the only grants: the three internal functions to service_role, the summary to authenticated" \
  '[ "$(grep -cE "^grant " "$DEPLOY")" = 2 ] && grep -qE "^grant execute on function public.founder_ai_spend_summary\(\) to authenticated;" "$DEPLOY" && [ "$(sed -n "/^grant execute on function public.internal_reserve_ai_spend/,/;/p" "$DEPLOY" | tail -1)" = "  to service_role;" ]'
check "new tables are created only in the private schema" '[ "$(grep -cE "^create table" "$MIGRATION")" = 3 ] && [ "$(grep -cE "^create table if not exists private\.ai_" "$MIGRATION")" = 3 ]'
ext() { sed -n "/^create \\(or replace \\)\\?function ${2//./\\.}(/,/^end \\\$\\\$;/p" "$1" | sed 's/^create function/create or replace function/'; }
check "rollback restores internal_complete_analysis exactly as Stage 2A-5b defined it" \
  'diff <(ext "$ROLLBACK" public.internal_complete_analysis) <(ext "$HERE/migrations/20261015120000_stage2a5b_evidence_integrity.sql" public.internal_complete_analysis) >/dev/null'
check "rollback restores founder_abandon_analysis exactly as Stage 2A-1 defined it" \
  'diff <(ext "$ROLLBACK" public.founder_abandon_analysis) <(ext "$HERE/migrations/20261009120200_stage2a1_functions.sql" public.founder_abandon_analysis) >/dev/null'
check "the migration's completion function is the 2A-5b body plus exactly two settlement calls" \
  'diff <(ext "$MIGRATION" public.internal_complete_analysis | grep -vE "ai_settle\(|Stage 2A-5d-3a: settle") <(ext "$HERE/migrations/20261015120000_stage2a5b_evidence_integrity.sql" public.internal_complete_analysis) >/dev/null && [ "$(ext "$MIGRATION" public.internal_complete_analysis | grep -c "perform private.ai_settle(v_analysis.id);")" = 2 ]'

echo "== Control: Stage 2A-5d-2 only (no spending controls)"
ctl=$(new_db); seed "$ctl"
c=$(text_case "$ctl"); a=$(start "$ctl" "$c"); out=$(reserve "$ctl" "$a")
check "control: no reservation exists and nothing limits the pipeline" 'grep -q "does not exist" <<<"$out" && [ "$(sql "$ctl" "select to_regclass('"'"'private.ai_spend_ledger'"'"') is null")" = t ]'
check "control: the preflight's md5s match the deployed 2A-5b / 2A-1 bodies" '[ "$(body_md5 "$ctl" "$ICA")" = 1639e2cc87c25ac16ba4f2a1c248a778 ] && [ "$(body_md5 "$ctl" "$ABANDON")" = c3416ac9416237615b761d5fd921d513 ]'
abandon "$ctl" "$a" >/dev/null

echo "== Deployment"
db=$(new_db); seed "$db"; rows=$(data_rows "$db")
check "verification reports FAIL (or cannot run) before deployment" '! passes "$db" "$VERIFY"'
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "2A-5d-3a verify: PASS (8 pass, 0 fail, 2 info)" '[ "$(overall "$db" "$VERIFY")" = "PASS (8 pass, 0 fail, 2 info)" ]'
check "2A-5d-2, 2A-5d-1, 2A-5b, 2A-5a, 2A-4c-1, 2A-4c, 2A-4b and 2A-1 verifications still all OVERALL PASS" 'earlier_pass "$db"'
check "deployment changed no data and wrote no ledger row" '[ "$(data_rows "$db")" = "$rows" ] && [ "$(ledger_rows "$db")" = 0 ]'
out=$(sql "$db" "select concat_ws(chr(47), enabled, budget_usd, stop_at_usd, max_reservation_usd, founder_attempts_24h, case_attempts_24h, case_attempts_total) from private.ai_spend_config")
check "spending is disabled after deployment; limits are as approved" '[ "$out" = "f/20.0000/18.0000/1.0000/10/3/10" ]'
check "verification is read-only" 's1=$(snapshot "$db"); d1=$(data_rows "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ] && [ "$(data_rows "$db")" = "$d1" ]'
check "internal_complete_analysis and founder_abandon_analysis keep their owners and privileges" \
  '[ "$(sql "$db" "select string_agg(proacl::text || proowner::regrole::text, chr(124) order by proname) from pg_proc where oid in ('"'"'$ICA'"'"'::regprocedure, '"'"'$ABANDON'"'"'::regprocedure)")" = "$(sql "$ctl" "select string_agg(proacl::text || proowner::regrole::text, chr(124) order by proname) from pg_proc where oid in ('"'"'$ICA'"'"'::regprocedure, '"'"'$ABANDON'"'"'::regprocedure)")" ]'
deployed="$db"

echo "== Contract and restrictions unchanged (no reservation: completion behaves exactly as before)"
res=$(scenarios "$db")
check "rre-analysis/1 and /2 accepted; fabricated review citation, rejecting review with a message, review overriding a restriction all refused" \
  'grep -q "V1=COMPLETE+MSG" <<<"$res" && grep -q "V2=COMPLETE+MSG" <<<"$res" && grep -q "FAB=ERROR$" <<<"$res" && grep -q "REJMSG=ERROR$" <<<"$res" && grep -q "REJWAIT=COMPLETE$" <<<"$res" && grep -q "RV2=ERROR$" <<<"$res"'
check "the same scenarios behave identically without 2A-5d-3a" '[ "$(scenarios "$ctl")" = "$res" ]'
check "no ledger row was created by analyses that reserved nothing" '[ "$(ledger_rows "$db")" = 0 ]'

echo "== Disabled by default; prices"
c=$(text_case "$db"); a=$(start "$db" "$c"); out=$(reserve "$db" "$a" FAKE-PROVIDER-NOT-AI FAKE-PROVIDER-NOT-AI)
check "reservation refused while spending is disabled (nothing written)" 'grep -q "SPENDING_DISABLED" <<<"$out" && [ "$(ledger_rows "$db")" = 0 ]'
# The administrator enables spending and adds synthetic prices, as the deployment guide describes (SQL editor).
sql "$db" "update private.ai_spend_config set enabled = true, updated_at = now() where id;
  insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note) values
  ('test-cheap', 1, 5, 1000, true, 'synthetic'), ('test-dear', 10, 50, 2000, true, 'synthetic'),
  ('test-huge', 100, 500, 2000, true, 'synthetic'), ('test-retired', 1, 1, 100, false, 'synthetic')" >/dev/null
out=$(reserve "$db" "$a" unknown-model test-dear); out2=$(reserve "$db" "$a" test-cheap test-retired)
check "unknown or inactive model refused (MODEL_NOT_PRICED), nothing written" 'grep -q "MODEL_NOT_PRICED: analyst" <<<"$out" && grep -q "MODEL_NOT_PRICED: reviewer" <<<"$out2" && [ "$(ledger_rows "$db")" = 0 ]'
out=$(reserve "$db" "$a" test-huge test-huge)
check "a reservation above USD 1 is refused (RESERVATION_TOO_LARGE), nothing written" 'grep -q "RESERVATION_TOO_LARGE" <<<"$out" && [ "$(ledger_rows "$db")" = 0 ]'
out=$(reserve "$db" "$a" FAKE-PROVIDER-NOT-AI FAKE-PROVIDER-NOT-AI)
check "the fake provider reserves USD 0" '[ "$(reserved "$db" "$a")" = 0.0000 ]'
out=$(reserve "$db" "$a")
check "a second reservation for the same analysis is refused" 'grep -q "INVALID_STATE: spending already reserved" <<<"$out"'
fail_run "$db" "$a"

echo "== Reservation formula: different-priced models"
c=$(text_case "$db"); a=$(start "$db" "$c"); out=$(reserve "$db" "$a" test-cheap test-dear)
e1=$(expect_usd "$db" "$a" 1 5 1000 10 50 2000)
check "cheap analyst + dear reviewer reserves the independently computed amount ($e1)" '[ "$(reserved "$db" "$a")" = "$e1" ] && grep -q "\"max_output_tokens\": 1000" <<<"$out"'
abandon "$db" "$a" >/dev/null
c=$(text_case "$db"); a2=$(start "$db" "$c"); reserve "$db" "$a2" test-dear test-cheap >/dev/null
e2=$(expect_usd "$db" "$a2" 10 50 2000 1 5 1000)
check "swapping the models changes the reservation ($e2 vs $e1): each role uses its own prices and cap" '[ "$(reserved "$db" "$a2")" = "$e2" ] && [ "$e1" != "$e2" ]'
check "prices and caps are snapshotted per role in the ledger" \
  '[ "$(sql "$db" "select concat_ws(chr(47), analyst_in_price, analyst_out_price, analyst_max_output, reviewer_in_price, reviewer_out_price, reviewer_max_output) from private.ai_spend_ledger where analysis_id = '"'"'$a2'"'"'")" = "10.000000/50.000000/2000/1.000000/5.000000/1000" ]'
abandon "$db" "$a2" >/dev/null

echo "== Settlement"
age_ledger "$db"
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null
out=$(dispatch "$db" "$a" ANALYST); usage "$db" "$a" ANALYST 3000 800 >/dev/null
out2=$(dispatch "$db" "$a" REVIEWER); usage "$db" "$a" REVIEWER 5000 900 >/dev/null
check "dispatch returns each role's model and output cap" 'grep -q "\"model\": \"test-cheap\"" <<<"$out" && grep -q "\"max_output_tokens\": 2000" <<<"$out2"'
check "a full run completes and settles at reported usage x each role's price (0.1020)" '[ "$(complete "$db" "$a" "$c" GREEN "$REVIEW_OK")" = "COMPLETE+MSG" ] && [ "$(ledger "$db" "$a")" = "SETTLED:REPORTED_USAGE:0.1020:false" ]'
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null; fail_run "$db" "$a"
check "no dispatch recorded: settles at 0 (NO_DISPATCH)" '[ "$(ledger "$db" "$a")" = "SETTLED:NO_DISPATCH:0.0000:false" ]'
before=$(committed "$db")
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null; r=$(reserved "$db" "$a"); dispatch "$db" "$a" ANALYST >/dev/null; fail_run "$db" "$a"
check "provider fails after dispatch, pipeline reports 0 tokens and 0 cost: HELD, not released" '[ "$(ledger "$db" "$a")" = "HELD:UNKNOWN_USAGE:0.0000:false" ]'
check "the held reservation stays fully committed ($before + $r)" '[ "$(sql "$db" "select $before + $r = private.ai_committed_usd()")" = t ]'
held="$a"
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null; dispatch "$db" "$a" ANALYST >/dev/null; usage "$db" "$a" ANALYST 3000 800 >/dev/null
dispatch "$db" "$a" REVIEWER >/dev/null; fail_run "$db" "$a"
check "reviewer fails after dispatch: HELD with the analyst's known cost as lower bound" '[ "$(ledger "$db" "$a")" = "HELD:UNKNOWN_USAGE:0.0070:false" ]'
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null; dispatch "$db" "$a" ANALYST >/dev/null
out=$(complete "$db" "$a" "$c" WAIT)
check "even a completed analysis whose usage was never reported stays HELD" '[ "$out" = COMPLETE ] && [ "$(ledger "$db" "$a")" = "HELD:UNKNOWN_USAGE:0.0000:false" ]'
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null; dispatch "$db" "$a" ANALYST >/dev/null; abandon "$db" "$a" >/dev/null
check "abandoned after dispatch (crash, timeout, lost response): HELD" '[ "$(ledger "$db" "$a")" = "HELD:UNKNOWN_USAGE:0.0000:false" ]'
abandoned="$a"
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null; abandon "$db" "$a" >/dev/null
check "abandoned before any dispatch: settles at 0" '[ "$(ledger "$db" "$a")" = "SETTLED:NO_DISPATCH:0.0000:false" ]'
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null
check "a running reservation (process may have died) stays RESERVED and committed" '[ "$(ledger "$db" "$a")" = "RESERVED:-:-:false" ]'
running="$a"

echo "== Dispatch rules (no retries, analyst first, no usage without dispatch)"
out=$(dispatch "$db" "$running" REVIEWER)
check "reviewer cannot be dispatched before the analyst reported usage" 'grep -q "INVALID_STATE: the reviewer runs only after" <<<"$out"'
out=$(usage "$db" "$running" ANALYST 10 10)
check "usage cannot be reported for an undispatched call" 'grep -q "NOT_DISPATCHED" <<<"$out"'
dispatch "$db" "$running" ANALYST >/dev/null; out=$(dispatch "$db" "$running" ANALYST)
check "the same call cannot be dispatched twice (no retry inside a reservation)" 'grep -q "ALREADY_DISPATCHED" <<<"$out"'
usage "$db" "$running" ANALYST 10 10 >/dev/null; out=$(usage "$db" "$running" ANALYST 0 0)
check "usage cannot be reported twice (no overwrite with zeros)" 'grep -q "ALREADY_REPORTED" <<<"$out"'
out=$(usage "$db" "$running" ANALYST -1 0)
check "negative token counts are refused" 'grep -q "VALIDATION" <<<"$out"'
out=$(dispatch "$db" "$held" REVIEWER)
check "a settled or held reservation cannot dispatch again" 'grep -q "INVALID_STATE" <<<"$out"'
out=$(dispatch "$db" 00000000-0000-4000-8000-000000000000 ANALYST)
check "dispatch without a reservation is refused (NOT_RESERVED)" 'grep -q "NOT_RESERVED" <<<"$out"'
abandon "$db" "$running" >/dev/null

echo "== Reconciliation (database owner only)"
age_ledger "$db"
out=$(sql "$db" "select private.ai_reconcile('$held', 0.05, 'short')" 2>&1 || true)
check "reconciliation needs an explanation of at least 20 characters" 'grep -q "VALIDATION" <<<"$out" && [ "$(ledger "$db" "$held")" = "HELD:UNKNOWN_USAGE:0.0000:false" ]'
before=$(committed "$db"); r=$(reserved "$db" "$held")
sql "$db" "select private.ai_reconcile('$held', 0.05, 'Provider console shows USD 0.05 for this request (synthetic).')" >/dev/null
check "a held reservation is reconciled to the billed amount; committed spend drops by the difference" \
  '[ "$(ledger "$db" "$held")" = "RECONCILED:RECONCILIATION:0.0500:false" ] && [ "$(sql "$db" "select $before - $r + 0.05 = private.ai_committed_usd()")" = t ]'
check "reconciliation is audited with its note" '[ "$(sql "$db" "select count(*) from public.audit_log where action = '"'"'AI_SPEND_RECONCILED'"'"' and details->>'"'"'note'"'"' like '"'"'Provider console%'"'"'")" = 1 ]'
out=$(sql "$db" "select private.ai_reconcile('$held', 0.01, 'A second attempt to change the amount.')" 2>&1 || true)
check "a reconciled reservation cannot be reconciled again" 'grep -q "INVALID_STATE" <<<"$out"'
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null
out=$(sql "$db" "select private.ai_reconcile('$a', 0, 'Trying to release a reservation that is still running.')" 2>&1 || true)
check "a reservation whose analysis is still running cannot be reconciled" 'grep -q "INVALID_STATE" <<<"$out"'
abandon "$db" "$a" >/dev/null

echo "== Authorization"
age_ledger "$db"
c=$(text_case "$db"); a=$(start "$db" "$c")
for who in "$A_USER" "$F_USER" anon; do
  out=$(as "$db" "$who" "select public.internal_reserve_ai_spend('$a', 'test-cheap', 'test-dear')")
  out2=$(as "$db" "$who" "select public.internal_ai_dispatch('$a', 'ANALYST')")
  out3=$(as "$db" "$who" "select public.internal_ai_report_usage('$a', 'ANALYST', 0, 0)")
  check "role $([ "$who" = anon ] && echo anon || ([ "$who" = "$F_USER" ] && echo founder || echo business)): cannot reserve, dispatch or report usage" \
    'grep -q "permission denied" <<<"$out" && grep -q "permission denied" <<<"$out2" && grep -q "permission denied" <<<"$out3"'
done
out=$(as "$db" service-noclaim "select public.internal_reserve_ai_spend('$a', 'test-cheap', 'test-dear')")
check "the service role without the service_role JWT claim is refused (FORBIDDEN)" 'grep -q "FORBIDDEN" <<<"$out" && [ -z "$(reserved "$db" "$a")" ]'
for who in "$A_USER" "$F_USER" anon service; do
  out=$(as "$db" "$who" "select count(*) from private.ai_spend_ledger"); out2=$(as "$db" "$who" "update private.ai_spend_config set budget_usd = 1000, stop_at_usd = 1000, enabled = true")
  out3=$(as "$db" "$who" "select private.ai_reconcile('$abandoned', 0, 'Releasing money through the API should fail.')")
  out4=$(as "$db" "$who" "insert into private.ai_model_prices values ('free', 0, 0, 100000, true, null)")
  check "role $who: cannot read the ledger, raise limits, reconcile or add prices" \
    'grep -q "permission denied" <<<"$out" && grep -q "permission denied" <<<"$out2" && grep -q "permission denied" <<<"$out3" && grep -q "permission denied" <<<"$out4"'
done
check "limits unchanged after those attempts" '[ "$(sql "$db" "select budget_usd || chr(47) || stop_at_usd from private.ai_spend_config")" = "20.0000/18.0000" ] && [ "$(sql "$db" "select count(*) from private.ai_model_prices where model = '"'"'free'"'"'")" = 0 ]'
out=$(as "$db" "$F_USER" "select public.founder_ai_spend_summary()"); exp=$(committed "$db")
check "the founder reads the spending summary (committed $exp)" 'grep -q "\"budget_usd\": 20.0000" <<<"$out" && grep -q "\"committed_usd\": $exp" <<<"$out" && grep -q "\"held_reservations\"" <<<"$out"'
check "the summary carries no case content, model output or notes" '! grep -qiE "synthetic|prospect|provider console|analysis_id" <<<"$out"'
out=$(as "$db" "$A_USER" "select public.founder_ai_spend_summary()"); out2=$(as "$db" anon "select public.founder_ai_spend_summary()")
check "business users get FORBIDDEN, anonymous callers permission denied" 'grep -q "FORBIDDEN" <<<"$out" && grep -q "permission denied" <<<"$out2"'
out=$(as "$db" "$A_USER" "select public.client_get_case('$c')::text || (select coalesce(string_agg(l::text, ''), '') from public.client_list_cases() l)")
check "the client's case RPCs carry nothing about spending" '! grep -qiE "usd|reserv|spend|token" <<<"$out"'
abandon "$db" "$a" >/dev/null

echo "== Rate limits"
age_ledger "$db"
cs=(); for i in 1 2 3 4 5; do cs+=("$(text_case "$db")"); done
res=""; for i in 0 0 0 1 1 1 2 2 2 3; do res+="$(cycle "$db" "${cs[$i]}"),"; done
check "10 attempts in 24 hours succeed" '[ "$res" = "OK,OK,OK,OK,OK,OK,OK,OK,OK,OK," ]'
out=$(cycle "$db" "${cs[4]}")
check "the founder's 11th attempt in 24 hours is refused (RATE_LIMITED)" 'grep -q "RATE_LIMITED: founder analysis limit" <<<"$out"'
age_ledger "$db"
res=""; for i in 1 2 3; do res+="$(cycle "$db" "${cs[3]}"),"; done; out=$(cycle "$db" "${cs[3]}")
check "after 24 hours the founder can run again; a case's 4th attempt in 24 hours is refused" '[ "$res" = "OK,OK,OK," ] && grep -q "RATE_LIMITED: case analysis limit reached (3 per 24 hours)" <<<"$out"'
res=""
for n in 3 3 1; do age_ledger "$db"; for i in $(seq "$n"); do res+="$(cycle "$db" "${cs[0]}"),"; done; done
out=$(cycle "$db" "${cs[0]}")
check "a case's 11th attempt in total is refused (10 lifetime, across days)" '[ "$res" = "OK,OK,OK,OK,OK,OK,OK," ] && grep -q "RATE_LIMITED: case analysis limit reached (10 in total)" <<<"$out"'
check "refused attempts write nothing (case total is exactly 10)" '[ "$(sql "$db" "select count(*) from private.ai_spend_ledger where case_id = '"'"'${cs[0]}'"'"'")" = 10 ]'

echo "== Budget"
age_ledger "$db"
sql "$db" "update private.ai_spend_config set stop_at_usd = private.ai_committed_usd() + 0.1000 where id" >/dev/null
c=$(text_case "$db"); out=$(cycle "$db" "$c")
check "a reservation that would cross the stop line is refused (BUDGET_EXCEEDED)" 'grep -q "BUDGET_EXCEEDED" <<<"$out"'
c2=$(text_case "$db"); a=$(start "$db" "$c2"); out=$(reserve "$db" "$a" FAKE-PROVIDER-NOT-AI FAKE-PROVIDER-NOT-AI)
check "a zero-cost reservation still fits under the stop line" '[ "$(reserved "$db" "$a")" = 0.0000 ]'
fail_run "$db" "$a"
sql "$db" "update private.ai_spend_config set stop_at_usd = 18 where id" >/dev/null
check "committed spend never exceeds the stop line" '[ "$(sql "$db" "select private.ai_committed_usd() <= stop_at_usd from private.ai_spend_config")" = t ]'

echo "== Overrun"
age_ledger "$db"
c=$(text_case "$db"); a=$(start "$db" "$c"); reserve "$db" "$a" >/dev/null; dispatch "$db" "$a" ANALYST >/dev/null
usage "$db" "$a" ANALYST 2000000 1000 >/dev/null; fail_run "$db" "$a"
check "usage above the reservation is recorded in full and flagged" '[ "$(ledger "$db" "$a")" = "SETTLED:REPORTED_USAGE:2.0050:true" ]'
check "an overrun disables all further spending and is audited" '[ "$(sql "$db" "select enabled from private.ai_spend_config")" = f ] && [ "$(sql "$db" "select count(*) from public.audit_log where action = '"'"'AI_SPEND_OVERRUN'"'"'")" = 1 ]'
c=$(text_case "$db"); out=$(cycle "$db" "$c")
check "after an overrun no reservation is possible (SPENDING_DISABLED)" 'grep -q "SPENDING_DISABLED" <<<"$out"'
check "verify still PASSes with spending disabled; the INFO rows report the ledger" 'passes "$db" "$VERIFY" && [ "$(row "$db" "$VERIFY" 10)" = INFO ]'

echo "== Re-running, single-query mode, failures"
snap=$(snapshot "$deployed"); out=$(run_single "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-5d-3a is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && all_pass "$db"'
broken="$WORK/broken.sql"
for weak in "grant select on table private.ai_spend_ledger to authenticated" \
            "grant execute on function public.internal_reserve_ai_spend(uuid, text, text) to authenticated" \
            "grant execute on function private.ai_reconcile(uuid, numeric, text) to service_role" \
            "create policy leak on private.ai_spend_config for select to authenticated using (true)" \
            "update private.ai_spend_config set enabled = true" \
            "alter function public.internal_ai_dispatch(uuid, text) reset all"; do
  awk -v w="$weak; -- weakness" '/POST-INSTALL SELF-CHECK/ && !done {print w; done=1} {print}' "$DEPLOY" > "$broken"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts and rolls back: ${weak:0:62}…" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done
# Rules present in the text but disabled are caught by the behaviour self-tests.
FROMS=("  v_complete := (v_l.analyst_dispatched_at is null or v_l.analyst_input_tokens is not null)"
       "  v_r_in numeric := p_cfg.prompt_overhead_tokens + v_e + p_cfg.analyst_output_factor * p_analyst.max_output_tokens;"
       "    update private.ai_spend_config set enabled = false, updated_at = now() where id;
    perform private.audit('AI_SPEND_OVERRUN'"
       "    perform private.ai_settle(v_analysis.id);
    return;")
TOS=("  v_complete := true or (v_l.analyst_dispatched_at is null or v_l.analyst_input_tokens is not null)"
     "  v_r_in numeric := p_cfg.prompt_overhead_tokens + v_e;"
     "    perform private.audit('AI_SPEND_OVERRUN'"
     "    return;")
EXPECTS=("settlement does not behave as reviewed" "the reservation estimate does not behave as reviewed" "settlement does not behave as reviewed" "lost a check, settlement or its privileges")
for i in 0 1 2 3; do
  python3 -I -c 'import sys; s=open(sys.argv[1]).read(); assert s.count(sys.argv[2])==1, sys.argv[2]; open(sys.argv[3],"w").write(s.replace(sys.argv[2], sys.argv[4]))' "$DEPLOY" "${FROMS[$i]}" "$broken" "${TOS[$i]}"
  expect="${EXPECTS[$i]}"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts on a sabotaged body ($((i + 1))): $expect" 'grep -q "$expect" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(new_db no5d2); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-5d-2" 'grep -q "Stage 2A-5d-2 (adversarial review contract) is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
for fn in "$ICA" "$ABANDON"; do
  db=$(new_db)
  sql "$db" "do \$x\$ begin execute replace(pg_get_functiondef('$fn'::regprocedure), 'perform private.fail(''NOT_FOUND'', ''analysis not found'');', 'perform private.fail(''NOT_FOUND'', ''analysis not found (changed outside the deployment files)'');'); end \$x\$" >/dev/null
  before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
  check "refuses when ${fn%%(*} was changed outside the deployment files" 'grep -qE "is not the reviewed Stage 2A-(5b|1) version" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Verification detects weaknesses"
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "grant select on private.ai_spend_ledger to authenticated" >/dev/null
check "a readable ledger: row 1 FAIL, OVERALL FAIL" '[ "$(row "$db" "$VERIFY" 1)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "grant execute on function public.internal_reserve_ai_spend(uuid, text, text) to authenticated" >/dev/null
check "reservation callable by clients: row 5 FAIL" '[ "$(row "$db" "$VERIFY" 5)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "do \$x\$ begin execute replace(pg_get_functiondef('$ABANDON'::regprocedure), 'perform private.ai_settle(v_analysis.id);', ''); end \$x\$" >/dev/null
check "abandonment that no longer settles: row 6 FAIL" '[ "$(row "$db" "$VERIFY" 6)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
sql "$db" "update private.ai_spend_config set stop_at_usd = 25 where id" 2>/dev/null >/dev/null || true
check "the table constraint keeps stop_at at or below the budget" '[ "$(sql "$db" "select stop_at_usd from private.ai_spend_config")" = 18.0000 ]'

echo "== Rollback"
for rb in "$ROLLBACK5B" "$ROLLBACK5D2"; do
  before=$(snapshot "$deployed"); out=$(run_file "$deployed" "$rb" || true)
  check "$(basename "$rb") is refused while 2A-5d-3a is installed (nothing changed)" 'grep -q "ROLLBACK REFUSED (nothing changed).*run stage2a5d[0-9a]*_rollback.sql first" <<<"$out" && [ "$(snapshot "$deployed")" = "$before" ]'
done
sql "$deployed" "update private.ai_spend_config set enabled = true where id" >/dev/null
rows=$(data_rows "$deployed"); lrows=$(ledger_rows "$deployed"); lsum=$(ledger_md5 "$deployed")
out=$(run_file "$deployed" "$ROLLBACK" || true)
check "2A-5d-3a rollback succeeds with its self-check" '! grep -q ERROR <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback kept every analysis, restriction, audit entry, evidence version and ledger record unchanged" \
  '[ "$(data_rows "$deployed")" = "$rows" ] && [ "$(ledger_rows "$deployed")" = "$lrows" ] && [ "$(ledger_md5 "$deployed")" = "$lsum" ]'
check "rollback disabled spending; the kept tables are still private" '[ "$(sql "$deployed" "select enabled from private.ai_spend_config")" = f ] && [ "$(sql "$deployed" "select has_table_privilege('"'"'authenticated'"'"', '"'"'private.ai_spend_ledger'"'"', '"'"'SELECT'"'"') or has_table_privilege('"'"'service_role'"'"', '"'"'private.ai_spend_ledger'"'"', '"'"'SELECT'"'"')")" = f ]'
check "internal_complete_analysis and founder_abandon_analysis identical to a 2A-5d-2 database (body, owner, privileges, settings)" \
  '[ "$(fn_md5 "$deployed" "$ICA")" = "$(fn_md5 "$ctl" "$ICA")" ] && [ "$(fn_md5 "$deployed" "$ABANDON")" = "$(fn_md5 "$ctl" "$ABANDON")" ]'
check "the eight spending functions are gone" '[ "$(sql "$deployed" "select count(*) from pg_proc where proname in ('"'"'ai_estimate_usd'"'"', '"'"'ai_committed_usd'"'"', '"'"'ai_settle'"'"', '"'"'ai_reconcile'"'"', '"'"'internal_reserve_ai_spend'"'"', '"'"'internal_ai_dispatch'"'"', '"'"'internal_ai_report_usage'"'"', '"'"'founder_ai_spend_summary'"'"')")" = 0 ]'
check "after rollback: all earlier verifications PASS; 2A-5d-3a verify does not" 'earlier_pass "$deployed" && ! passes "$deployed" "$VERIFY"'
res=$(scenarios "$deployed")
check "after rollback the contract behaves exactly as on 2A-5d-2" '[ "$res" = "$(scenarios "$ctl")" ]'
check "rollback is audited" '[ "$(sql "$deployed" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-5d-3a'"'"'")" = 1 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-5d-3a is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploying after rollback works, re-uses the kept records, and stays disabled" \
  '! grep -q ERROR <<<"$out" && grep -q "already exist" <<<"$out" && all_pass "$deployed" && [ "$(ledger_rows "$deployed")" = "$lrows" ] && [ "$(sql "$deployed" "select enabled from private.ai_spend_config")" = f ]'
out=$(run_file "$deployed" "$ROLLBACK" || true); out2=$(run_file "$deployed" "$ROLLBACK5D2" || true); out3=$(run_file "$deployed" "$ROLLBACK5D1" || true)
check "full reverse order works: 2A-5d-3a, then 2A-5d-2, then 2A-5d-1 rollback" \
  '! grep -q ERROR <<<"$out" && ! grep -q ERROR <<<"$out2" && ! grep -q ERROR <<<"$out3" && grep -q "Rollback self-check passed" <<<"$out3"'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

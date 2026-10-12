#!/usr/bin/env bash
# Tests the Stage 2A-5b evidence-integrity deployment, verification and rollback
# against throwaway local PostgreSQL databases that
# first get Stage 2A-1, 2A-4b, 2A-4c, 2A-4c-1 and 2A-5a via their deployment files. Storage is a local
# emulation (tests/local/00_supabase_emulation.sql). No network, no secrets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a5b_deploy.sql"; VERIFY="$D/stage2a5b_verify.sql"; ROLLBACK="$D/stage2a5b_rollback.sql"
V5A="$D/stage2a5a_verify.sql"; ROLLBACK5A="$D/stage2a5a_rollback.sql"
V4C="$D/stage2a4c_verify.sql"; V4C1="$D/stage2a4c1_verify.sql"
V1="$D/stage2a1_verify.sql"; V4B="$D/stage2a4b_verify.sql"
KNOWN="$D/known/rls_auto_enable.verified.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54336}"
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
all_pass() { [[ "$(overall "$1" "$VERIFY")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V5A")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V1")" == "PASS ("*" 0 fail"* ]]; }
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
  if [ "${3:-}" != no5a ]; then run_file "$db" "$D/stage2a5a_deploy.sql" >/dev/null || { echo "2A-5a failed" >&2; exit 1; }; fi
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
# shot_case <db>: a submitted screenshot case with recorded screenshots at positions 1 and 2; prints its id.
shot_case() {
  local c; c=$(sql "$1" "insert into public.cases (business_id, reference, product_service, lead_source, conversation_source, idempotency_key, workflow_state, evidence_version)
    values ('$A_BIZ', 'INT-$RANDOM', 'Synthetic', 'Referral', 'SCREENSHOTS', gen_random_uuid(), 'SUBMITTED', 1) returning id" | head -1)
  sql "$1" "insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
    select '$c', '$A_BIZ', p, '$A_BIZ/$c/' || p || '-' || repeat(p::text, 64) || '.png', 'image/png', 1000, repeat(p::text, 64), '$A_USER' from generate_series(1, 2) p" >/dev/null
  echo "$c"
}
text_case() {
  local c; c=$(as "$1" "$A_USER" "select public.client_create_case(gen_random_uuid(), 'INT-$RANDOM', 'Synthetic', 'Referral', 'TEXT', 'Prospect: please stop messaging me. Business: Noted.')" | tail -1)
  as "$1" "$A_USER" "select public.client_submit_case('$c')" >/dev/null; echo "$c"
}
start() { as "$1" "$F_USER" "select public.founder_start_analysis('$2')"; }   # full output (error lines included)
ev() { sql "$1" "select evidence_version from public.cases where id = '$2'"; }
SHOT1='{"contract_version": "rre-analysis/1", "evidence_assessment": {"sufficiency": "SUFFICIENT", "summary": "Synthetic.", "missing_evidence": []},
 "observations": [{"id": "O1", "actor": "PROSPECT", "behavior": "Asked about delivery.", "evidence": [{"type": "SCREENSHOT", "position": 1}]}],
 "hypotheses": [], "unknowns": [], "recommendation": {"pursue": "UNKNOWN", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [],
 "next_action": {"type": "ASK_DIAGNOSTIC_QUESTION", "text": "Ask when delivery is needed."}}, "contact_restrictions": [], "reasons_not_to_pursue": []}'
complete() { as "$1" service "select public.internal_complete_analysis('$2', '${4:-COMPLETE}', 'synthetic-model', 'test', \$j\$$3\$j\$::jsonb, null, null, \$r\$${5:-[]}\$r\$::jsonb)" >/dev/null; }
approve() { as "$1" "$F_USER" "select public.founder_approve('$2', '$3', $(ev "$1" "$2"), 'YELLOW', 'Unclear.', 'Ask about delivery.', 'When do you need it delivered?', 'EDITED')"; }
data_rows() { sql "$1" "select (select count(*) from public.cases)||'/'||(select count(*) from public.analyses)||'/'||(select count(*) from public.contact_restrictions)||'/'||(select sum(evidence_version) from public.cases)||'/'||(select count(*) from public.audit_log where action not in ('SCHEMA_DEPLOYED', 'SCHEMA_ROLLED_BACK'))"; }
# scenarios <db> <label>: runs the three evidence-integrity scenarios, printing one word each.
scenarios() {
  local db=$1 c a
  c=$(shot_case "$db"); sql "$db" "update public.case_screenshots set file_deleted_at = now() where case_id = '$c'" >/dev/null
  a=$(start "$db" "$c"); [ -n "$a" ] && [[ "$a" != *ERROR* ]] && echo "S1=STARTED" || { grep -q INSUFFICIENT_EVIDENCE <<<"$a" && echo "S1=REFUSED" || echo "S1=?$a"; }
  c=$(shot_case "$db"); a=$(start "$db" "$c" | tail -1); complete "$db" "$a" "$SHOT1"
  sql "$db" "update public.case_screenshots set file_deleted_at = now() where case_id = '$c' and position = 1" >/dev/null
  out=$(approve "$db" "$c" "$a"); grep -q STALE_ANALYSIS <<<"$out" && echo "S2=STALE" || { grep -q ERROR <<<"$out" && echo "S2=?$out" || echo "S2=APPROVED"; }
  c=$(text_case "$db"); a=$(start "$db" "$c" | tail -1); complete "$db" "$a" '{"verdict": "keep selling"}' COMPLETE '[{"kind": "EXPLICIT_OPT_OUT", "note": "synthetic"}]'
  [ "$(sql "$db" "select count(*) from public.contact_restrictions where case_id = '$c' and kind = 'EXPLICIT_OPT_OUT' and status = 'ACTIVE'")" = 1 ] && echo "S3=KEPT" || echo "S3=LOST"
}

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a5b.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, changes policies or grants" '! grep -niE "disable row level security|session_replication_role|create policy|drop policy|alter policy|grant " "$f" >/dev/null'
  check "$n never deletes rows" '! grep -niE "^\s*delete from|truncate|drop table" "$f" >/dev/null'
done
extract() { sed -n "/^create or replace function public.$2(/,/^end \\\$\\\$;/p" "$1" | sed "1s/create or replace/create/"; }
check "rollback restores founder_start_analysis exactly as Stage 2A-1 defined it" \
  'diff <(extract "$ROLLBACK" founder_start_analysis) <(sed -n "/^create function public.founder_start_analysis(/,/^end \\\$\\\$;/p" "$HERE/migrations/20261009120200_stage2a1_functions.sql") >/dev/null'
check "rollback restores internal_complete_analysis exactly as Stage 2A-5a defined it" \
  'diff <(extract "$ROLLBACK" internal_complete_analysis) <(extract "$HERE/migrations/20261014120000_stage2a5a_analysis_contract.sql" internal_complete_analysis) >/dev/null'

echo "== Control: the three gaps reproduced without 2A-5b (Stage 2A-5a only)"
ctl=$(new_db); seed "$ctl"; res=$(scenarios "$ctl")
check "control: an analysis STARTS on a case whose every file was deleted" 'grep -q "S1=STARTED" <<<"$res"'
check "control: an analysis whose cited file was deleted during review is APPROVED" 'grep -q "S2=APPROVED" <<<"$res"'
check "control: a rejected analysis LOSES its detected opt-out" 'grep -q "S3=LOST" <<<"$res"'

echo "== Deployment"
db=$(new_db); seed "$db"; rows=$(data_rows "$db")
check "verification reports FAIL before deployment" '[[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "2A-5b verify: PASS (8 pass, 0 fail, 2 info)" '[ "$(overall "$db" "$VERIFY")" = "PASS (8 pass, 0 fail, 2 info)" ]'
check "2A-5a, 2A-4c-1, 2A-4c, 2A-4b and 2A-1 verifications still all OVERALL PASS" 'all_pass "$db"'
check "deployment changed no data" '[ "$(data_rows "$db")" = "$rows" ]'
check "verification is read-only" 's1=$(snapshot "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ]'
deployed="$db"

echo "== Regression on the deployed database"
res=$(scenarios "$db")
check "no analysis starts when every file was deleted (INSUFFICIENT_EVIDENCE)" 'grep -q "S1=REFUSED" <<<"$res"'
check "deleting a cited file during review makes the analysis STALE (not approvable)" 'grep -q "S2=STALE" <<<"$res"'
check "a rejected analysis KEEPS its detected opt-out" 'grep -q "S3=KEPT" <<<"$res"'
c=$(shot_case "$db"); a=$(start "$db" "$c" | tail -1); complete "$db" "$a" "$SHOT1"; out=$(approve "$db" "$c" "$a")
check "legitimate: an analysis of unchanged evidence is still approved" '! grep -q ERROR <<<"$out" && [ -n "$(tail -1 <<<"$out")" ]'
out=$(as "$db" "$A_USER" "select count(*) from public.contact_restrictions")
check "the business user reads no restriction" '[ "$(tail -1 <<<"$out")" = 0 ]'

echo "== Re-running, single-query mode, failures"
snap=$(snapshot "$deployed"); out=$(run_single "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-5b is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && all_pass "$db"'
broken="$WORK/broken.sql"
for weak in "alter table public.case_screenshots disable trigger rre_case_screenshots_evidence_update" \
            "grant execute on function private.evidence_manifest(uuid, integer) to authenticated" \
            "create policy leak on public.contact_restrictions for select to authenticated using (true)"; do
  awk -v w="$weak; -- weakness" '/POST-INSTALL SELF-CHECK/ && !done {print w; done=1} {print}' "$DEPLOY" > "$broken"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts and rolls back: ${weak:0:58}…" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(new_db "" "" no5a); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-5a" 'grep -q "Stage 2A-5a (analysis contract) is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses"
db=$(new_db); run_file "$db" "$DEPLOY" >/dev/null
sql "$db" "alter table public.case_messages disable trigger rre_case_messages_evidence_delete" >/dev/null
check "a disabled evidence trigger: row 6 FAIL, OVERALL FAIL" '[ "$(row "$db" "$VERIFY" 6)" = FAIL ] && [[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
sql "$db" "grant execute on function private.preserve_detected_restrictions(uuid, jsonb, integer) to authenticated" >/dev/null
check "an internal function callable by clients: row 3 FAIL" '[ "$(row "$db" "$VERIFY" 3)" = FAIL ]'

echo "== Rollback"
before=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK5A" || true)
check "2A-5a rollback is refused while 2A-5b is installed (nothing changed)" 'grep -q "run stage2a5b_rollback.sql first" <<<"$out" && [ "$(snapshot "$deployed")" = "$before" ]'
rows=$(data_rows "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "2A-5b rollback succeeds with its self-check" '! grep -q ERROR <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback kept every analysis, preserved restriction, audit entry and evidence version" '[ "$(data_rows "$deployed")" = "$rows" ]'
ref=$(new_db)
fn_md5() { sql "$1" "select string_agg(md5(prosrc || proacl::text || proowner::regrole::text), ',' order by proname) from pg_proc where proname in ('founder_start_analysis', 'internal_complete_analysis')"; }
check "both functions are again identical to Stage 2A-5a (body, owner, privileges)" '[ "$(fn_md5 "$deployed")" = "$(fn_md5 "$ref")" ]'
check "after rollback: 2A-5a and earlier verifications PASS; 2A-5b verify FAILs" '[[ "$(overall "$deployed" "$V5A")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$V1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
check "rollback is audited" '[ "$(sql "$deployed" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-5b'"'"'")" = 1 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-5b is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploying after rollback works" '! grep -q ERROR <<<"$out" && all_pass "$deployed"'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

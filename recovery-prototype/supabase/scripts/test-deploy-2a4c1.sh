#!/usr/bin/env bash
# Tests the Stage 2A-4c-1 upload guard deployment, verification and rollback
# against throwaway local PostgreSQL databases that
# first get Stage 2A-1, 2A-4b and 2A-4c via their deployment files. Storage is a local
# emulation (tests/local/00_supabase_emulation.sql). No network, no secrets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a4c1_deploy.sql"; VERIFY="$D/stage2a4c1_verify.sql"; ROLLBACK="$D/stage2a4c1_rollback.sql"
V4C="$D/stage2a4c_verify.sql"; ROLLBACK4C="$D/stage2a4c_rollback.sql"
V1="$D/stage2a1_verify.sql"; V4B="$D/stage2a4b_verify.sql"
KNOWN="$D/known/rls_auto_enable.verified.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54334}"
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
all_pass() { [[ "$(overall "$1" "$VERIFY")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4C")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V1")" == "PASS ("*" 0 fail"* ]]; }
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
  if [ "${2:-}" != no4c ]; then run_file "$db" "$D/stage2a4c_deploy.sql" >/dev/null || { echo "2A-4c failed" >&2; exit 1; }; fi
  echo "$db"
}


# Synthetic business A (client A) and B (client B); client A has a submitted
# screenshot case (one recorded file) and an open screenshot draft.
A_USER=00000000-0000-4000-8000-0000000000a1; B_USER=00000000-0000-4000-8000-0000000000b1; F_USER=00000000-0000-4000-8000-0000000000f1
A_BIZ=10000000-0000-4000-8000-0000000000a1; B_BIZ=10000000-0000-4000-8000-0000000000b1
SUBMITTED=20000000-0000-4000-8000-0000000000a1; DRAFT=20000000-0000-4000-8000-0000000000a2
hex() { printf "$1%.0s" {1..64}; }
name() { echo "$A_BIZ/$1/$2-$(hex "$3").png"; }   # name <case> <position> <hexchar>
# as <uid> <sql>: a signed-in client session (role authenticated, RLS applies).
as() { "${PSQL[@]}" -d "$1" -At -c "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub', '$2', 'role', 'authenticated')::text, false);" -c "$3" 2>&1 | tail -n +2 || true; }
# storage_write <db> <name> <owner> [upsert]: Storage's own final write, as service_role (RLS bypassed),
# exactly what happens when a signed upload URL is used.
storage_write() {
  local conflict=""; [ "${4:-}" = upsert ] && conflict="on conflict (bucket_id, name) do update set metadata = excluded.metadata"
  "${PSQL[@]}" -d "$1" -At -c "set role service_role; insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', '$2', '$3', '{\"size\": 2222, \"mimetype\": \"image/png\"}') $conflict" 2>&1 && echo ACCEPTED || true
}
seed() {
  sql "$1" "insert into auth.users (id, email) values ('$A_USER', 'a@synthetic.test'), ('$B_USER', 'b@synthetic.test'), ('$F_USER', 'f@synthetic.test');
    insert into public.founders (user_id) values ('$F_USER');
    insert into public.businesses (id, name) values ('$A_BIZ', 'Synthetic A'), ('$B_BIZ', 'Synthetic B');
    insert into public.business_members (business_id, user_id) values ('$A_BIZ', '$A_USER'), ('$B_BIZ', '$B_USER');
    insert into public.cases (id, business_id, reference, product_service, lead_source, conversation_source, idempotency_key) values
      ('$SUBMITTED', '$A_BIZ', 'SHOT-SUB', 'Synthetic', 'Referral', 'SCREENSHOTS', gen_random_uuid()),
      ('$DRAFT', '$A_BIZ', 'SHOT-DRAFT', 'Synthetic', 'Referral', 'SCREENSHOTS', gen_random_uuid())" >/dev/null
  as "$1" "$A_USER" "insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', '$(name $SUBMITTED 1 a)', auth.uid()::text, '{\"size\": 1000, \"mimetype\": \"image/png\"}')" >/dev/null
  as "$1" "$A_USER" "select public.client_finalize_screenshots('$SUBMITTED'); select public.client_submit_case('$SUBMITTED')" >/dev/null
}
files_in() { sql "$1" "select count(*) from storage.objects where name like '%/$2/%'"; }
size_of() { sql "$1" "select metadata->>'size' from storage.objects where name = '$2'"; }
data_rows() { sql "$1" "select (select count(*) from public.cases)||'/'||(select count(*) from public.case_screenshots)||'/'||(select count(*) from storage.objects)||'/'||(select count(*) from public.audit_log where action not in ('SCHEMA_DEPLOYED', 'SCHEMA_ROLLED_BACK'))"; }

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a4c1.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS, policies or grants table writes" '! grep -niE "disable row level security|no force row level|session_replication_role|drop policy|alter policy|grant (insert|update|delete|all) on" "$f" >/dev/null'
  check "$n never deletes rows or files" '! grep -niE "^\s*delete from|truncate|drop table|drop bucket" "$f" >/dev/null'
done

echo "== Control: the staging WARN reproduced without the guard (Stage 2A-4c only)"
ctl=$(new_db); seed "$ctl"
check "control: the case is submitted with one recorded file" '[ "$(sql "$ctl" "select workflow_state from public.cases where id = '"'"'$SUBMITTED'"'"'")" = SUBMITTED ] && [ "$(sql "$ctl" "select count(*) from public.case_screenshots")" = 1 ]'
out=$(storage_write "$ctl" "$(name $SUBMITTED 2 b)" "$A_USER")
check "control: a signed-URL write after submission is ACCEPTED (defect reproduced)" 'grep -q ACCEPTED <<<"$out" && [ "$(files_in "$ctl" $SUBMITTED)" = 2 ]'
out=$(storage_write "$ctl" "$(name $SUBMITTED 1 a)" "$A_USER" upsert)
check "control: an upsert-signed write REPLACES the recorded file (defect reproduced)" 'grep -q ACCEPTED <<<"$out" && [ "$(size_of "$ctl" "$(name $SUBMITTED 1 a)")" = 2222 ]'

echo "== Cleanup report (admin/live_check_cleanup_report.sql)"
sql "$ctl" "insert into public.cases (id, business_id, reference, product_service, lead_source, conversation_source, idempotency_key)
  values ('20000000-0000-4000-8000-0000000000c1', '$A_BIZ', 'LIVE-CHECK-20261011000000-X', 'Synthetic live check', 'Other', 'SCREENSHOTS', gen_random_uuid())" >/dev/null
before=$(snapshot "$ctl"); rep=$("${PSQL[@]}" -d "$ctl" -At -F '|' < "$HERE/admin/live_check_cleanup_report.sql" 2>&1)
check "cleanup report is read-only" '[ "$(snapshot "$ctl")" = "$before" ] && ! grep -q ERROR <<<"$rep"'
check "it lists the LIVE-CHECK case with its folder" 'grep -q "^LIVE-CHECK case|LIVE-CHECK-20261011000000-X|DRAFT|$A_BIZ/20000000-0000-4000-8000-0000000000c1/|0|0|0$" <<<"$rep"'
check "it lists the unrecorded file left in the submitted case" 'grep -q "^unrecorded file (other case)|SHOT-SUB|SUBMITTED|$(name $SUBMITTED 2 b)|" <<<"$rep"'

echo "== Deployment"
db=$(new_db); seed "$db"; rows=$(data_rows "$db")
check "verification reports FAIL before deployment" '[[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "2A-4c-1 verify: PASS (7 pass, 0 fail, 1 info)" '[ "$(overall "$db" "$VERIFY")" = "PASS (7 pass, 0 fail, 1 info)" ]'
check "2A-4c, 2A-4b and 2A-1 verifications still all OVERALL PASS" 'all_pass "$db"'
check "deployment changed no data (cases, records, files, audit history)" '[ "$(data_rows "$db")" = "$rows" ]'
check "verification is read-only" 's1=$(snapshot "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ]'
deployed="$db"

echo "== Regression: signed upload URLs used after submission"
out=$(storage_write "$db" "$(name $SUBMITTED 2 b)" "$A_USER")
check "a signed-URL write after submission is refused" 'grep -q "the case is not an open screenshot draft" <<<"$out" && [ "$(files_in "$db" $SUBMITTED)" = 1 ]'
out=$(storage_write "$db" "$(name $SUBMITTED 1 a)" "$A_USER" upsert)
check "an upsert-signed write cannot replace the recorded file" 'grep -q "screenshot upload refused" <<<"$out" && [ "$(size_of "$db" "$(name $SUBMITTED 1 a)")" = 1000 ]'
out=$(storage_write "$db" "$(name $DRAFT 1 c)" "$B_USER")
check "a URL issued to another business's client cannot write into A's draft" 'grep -q "not a member of this business" <<<"$out" && [ "$(files_in "$db" $DRAFT)" = 0 ]'
out=$(storage_write "$db" "$(name $DRAFT 1 c)" "$A_USER")
check "legitimate: Storage's final write for A's upload into the open draft is accepted" 'grep -q ACCEPTED <<<"$out"'
out=$(storage_write "$db" "$(name $DRAFT 1 d)" "$A_USER")
check "a second URL for a taken position is refused" 'grep -q "already holds a file" <<<"$out" && [ "$(files_in "$db" $DRAFT)" = 1 ]'
out=$(as "$db" "$A_USER" "insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', '$(name $DRAFT 2 e)', auth.uid()::text, '{\"size\": 1000, \"mimetype\": \"image/png\"}')")
check "legitimate: a client upload under RLS still works" '! grep -q ERROR <<<"$out" && [ "$(files_in "$db" $DRAFT)" = 2 ]'
out=$(as "$db" "$A_USER" "insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', '$(name $SUBMITTED 3 f)', auth.uid()::text, '{}')")
check "client refusals still come from the RLS policy (unchanged)" 'grep -q "row-level security" <<<"$out"'
out=$(as "$db" "$A_USER" "select public.client_finalize_screenshots('$DRAFT'); select public.client_submit_case('$DRAFT')")
check "legitimate: the draft finalizes (both files) and submits" '! grep -q ERROR <<<"$out" && [ "$(sql "$db" "select count(*) from public.case_screenshots where case_id = '"'"'$DRAFT'"'"'")" = 2 ]'
out=$(as "$db" "$B_USER" "select public.client_screenshot_status('$DRAFT')")
check "cross-business isolation unchanged (B cannot see A's case)" 'grep -q NOT_FOUND <<<"$out"'
out=$(as "$db" "$F_USER" "select count(*) from storage.objects where bucket_id = 'case-screenshots'")
check "the founder still reads every file (3)" '[ "$(tail -1 <<<"$out")" = 3 ] && [ "$(sql "$db" "select count(*) from storage.objects")" = 3 ]'

echo "== Re-running, single-query mode, failures"
snap=$(snapshot "$deployed"); out=$(run_single "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-4c-1 is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && all_pass "$db"'
broken="$WORK/broken.sql"
for weak in "alter table storage.objects disable trigger rre_case_screenshots_guard" \
            "grant execute on function private.screenshot_object_guard() to authenticated" \
            "drop trigger rre_case_screenshots_guard on storage.objects; create trigger rre_case_screenshots_guard before insert on storage.objects for each row when (new.bucket_id = 'other') execute function private.screenshot_object_guard()"; do
  awk -v w="$weak; -- weakness" '/POST-INSTALL SELF-CHECK/ && !done {print w; done=1} {print}' "$DEPLOY" > "$broken"
  db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
  check "self-check aborts and rolls back: ${weak:0:60}…" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
done

echo "== Preflight refusals"
db=$(new_db "" no4c); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-4c" 'grep -q "Stage 2A-4c is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db)
sed -n '/^do \$preflight\$/,/^\$preflight\$;/p' "$DEPLOY" > "$WORK/preflight.sql"
sql "$db" "do \$r\$ begin create role deployer_t nologin bypassrls; exception when duplicate_object then null; end \$r\$; grant usage on schema storage, private, public to deployer_t; grant select on storage.objects to deployer_t" >/dev/null
pf=$("${PSQL[@]}" -d "$db" -c "set role deployer_t" -f "$WORK/preflight.sql" 2>&1 || true)
check "refuses a role without the TRIGGER privilege on storage.objects" 'grep -q "lacks the TRIGGER privilege on storage.objects" <<<"$pf"'
sql "$db" "grant trigger on storage.objects to deployer_t" >/dev/null
pf=$("${PSQL[@]}" -d "$db" -c "set role deployer_t" -f "$WORK/preflight.sql" 2>&1 || true)
check "with TRIGGER granted, the preflight passes" 'grep -q "Preflight passed" <<<"$pf"'

echo "== Verification detects weaknesses"
sql "$deployed" "alter table storage.objects disable trigger rre_case_screenshots_guard" >/dev/null
check "disabled guard: row 2 FAIL, OVERALL FAIL" '[ "$(row "$deployed" "$VERIFY" 2)" = FAIL ] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
sql "$deployed" "alter table storage.objects enable trigger rre_case_screenshots_guard" >/dev/null
sql "$deployed" "drop trigger rre_case_screenshots_guard on storage.objects; create trigger rre_case_screenshots_guard before insert on storage.objects for each row when (new.bucket_id = 'case-screenshots' and false) execute function private.screenshot_object_guard()" >/dev/null
check "weakened guard condition: row 3 FAIL" '[ "$(row "$deployed" "$VERIFY" 3)" = FAIL ]'
sql "$deployed" "drop trigger rre_case_screenshots_guard on storage.objects; create trigger rre_case_screenshots_guard before insert on storage.objects for each row when (new.bucket_id = 'case-screenshots' and not row_security_active('storage.objects'::regclass)) execute function private.screenshot_object_guard()" >/dev/null
check "restored: all verifications PASS" 'all_pass "$deployed"'

echo "== Rollback"
before=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK4C" || true)
check "2A-4c rollback is refused while the guard is installed (nothing changed)" 'grep -q "run stage2a4c1_rollback.sql first" <<<"$out" && [ "$(snapshot "$deployed")" = "$before" ]'
rows=$(data_rows "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "2A-4c-1 rollback succeeds with its self-check" '! grep -q ERROR <<<"$out" && grep -q "Rollback self-check passed" <<<"$out"'
check "rollback kept every record, file and audit entry" '[ "$(data_rows "$deployed")" = "$rows" ]'
check "after rollback: 2A-4c, 2A-4b, 2A-1 verifications PASS; 2A-4c-1 verify FAILs" '[[ "$(overall "$deployed" "$V4C")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$V1")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
check "rollback is audited" '[ "$(sql "$deployed" "select count(*) from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' and details->>'"'"'stage'"'"' = '"'"'2A-4c-1'"'"'")" = 1 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-4c-1 is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploying after rollback works" '! grep -q ERROR <<<"$out" && all_pass "$deployed"'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

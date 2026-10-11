#!/usr/bin/env bash
# Tests the Stage 2A-4c deployment, verification, rollback, staging isolation
# check and retention scripts against throwaway local PostgreSQL databases that
# first get Stage 2A-1 and 2A-4b via their deployment files. Storage is a local
# emulation (tests/local/00_supabase_emulation.sql). No network, no secrets.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D="$HERE/deploy"
DEPLOY="$D/stage2a4c_deploy.sql"; VERIFY="$D/stage2a4c_verify.sql"; ROLLBACK="$D/stage2a4c_rollback.sql"
V1="$D/stage2a1_verify.sql"; V4B="$D/stage2a4b_verify.sql"
KNOWN="$D/known/rls_auto_enable.verified.sql"
EMULATION="$HERE/tests/local/00_supabase_emulation.sql"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54332}"
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
all_pass() { [[ "$(overall "$1" "$VERIFY")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V4B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$1" "$V1")" == "PASS ("*" 0 fail"* ]]; }
storage_policies() { sql "$1" "select coalesce(string_agg(policyname, ',' order by policyname), '') from pg_policies where schemaname = 'storage'"; }
evidence() { sql "$1" "select (select count(*) from public.case_screenshots)||'/'||(select count(*) from public.audit_log where action <> 'SCHEMA_ROLLED_BACK')||'/'||(select count(*) from storage.objects)"; }

pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; fi; }

EMU="$WORK/emulation.sql"
sed 's/^create role \(anon\|authenticated\|service_role\) \(.*\);$/do $r$ begin create role \1 \2; exception when duplicate_object then null; end $r$;/' "$EMULATION" > "$EMU"
[ "$(grep -c 'duplicate_object' "$EMU")" = 4 ] || { echo "could not prepare emulation copy"; exit 1; }

# new_db [helper] [no4b]
new_db() {
  local db="t_$(date +%s%N)_$RANDOM"
  sql postgres "create database $db" >/dev/null
  run_file "$db" "$EMU" >/dev/null || { echo "emulation failed" >&2; exit 1; }
  if [ "${1:-}" = helper ]; then
    run_file "$db" "$KNOWN" >/dev/null
    sql "$db" "create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable()" >/dev/null
  fi
  run_file "$db" "$D/stage2a1_deploy.sql" >/dev/null || { echo "2A-1 failed" >&2; exit 1; }
  if [ "${2:-}" != no4b ]; then run_file "$db" "$D/stage2a4b_deploy.sql" >/dev/null || { echo "2A-4b failed" >&2; exit 1; }; fi
  echo "$db"
}

# Synthetic business A (client A) and B (client B), one SCREENSHOTS draft for A with one uploaded file.
A_USER=00000000-0000-4000-8000-0000000000a1; B_USER=00000000-0000-4000-8000-0000000000b1
A_BIZ=10000000-0000-4000-8000-0000000000a1; B_BIZ=10000000-0000-4000-8000-0000000000b1
A_CASE=20000000-0000-4000-8000-0000000000a1
seed() {
  sql "$1" "insert into auth.users (id, email) values ('$A_USER', 'a@synthetic.test'), ('$B_USER', 'b@synthetic.test');
    insert into public.businesses (id, name) values ('$A_BIZ', 'Synthetic A'), ('$B_BIZ', 'Synthetic B');
    insert into public.business_members (business_id, user_id) values ('$A_BIZ', '$A_USER'), ('$B_BIZ', '$B_USER');
    insert into public.cases (id, business_id, reference, product_service, lead_source, conversation_source, idempotency_key)
      values ('$A_CASE', '$A_BIZ', 'SHOT-A', 'Synthetic', 'Referral', 'SCREENSHOTS', gen_random_uuid())" >/dev/null
}
# One uploaded file in A's draft (needs the bucket, i.e. after deployment).
seed_file() {
  sql "$1" "insert into storage.objects (bucket_id, name, owner_id, metadata) values
      ('case-screenshots', '$A_BIZ/$A_CASE/1-$(printf 'a%.0s' {1..64}).png', '$A_USER', '{\"size\": 1000, \"mimetype\": \"image/png\"}')" >/dev/null
}
data_rows() { sql "$1" "select (select count(*) from public.businesses)||'/'||(select count(*) from public.cases)||'/'||(select count(*) from public.case_screenshots)||'/'||(select count(*) from public.audit_log where action <> 'SCHEMA_DEPLOYED')"; }

echo "== Generated files"
check "deploy file matches the migration (build --check)" '"$HERE/scripts/build-deploy-2a4c.sh" --check >/dev/null'
for f in "$DEPLOY" "$ROLLBACK"; do
  n=$(basename "$f")
  check "$n has exactly one BEGIN and one COMMIT" '[ "$(grep -ciE "^\s*begin\s*;" "$f")" = 1 ] && [ "$(grep -ciE "^\s*commit\s*;" "$f")" = 1 ]'
  check "$n has no credentials and creates no users or roles" '! grep -niE "insert into auth\.|create user|create role|password|service_role_key|sk-ant-|eyJhbGci" "$f" >/dev/null'
  check "$n never disables RLS or grants table writes" '! grep -niE "disable row level security|no force row level|session_replication_role|grant (insert|update|delete|all) on" "$f" >/dev/null'
  check "$n never deletes rows or files" '! grep -niE "^\s*delete from|truncate|drop table|drop bucket" "$f" >/dev/null'
done
check "rollback never drops the column unconditionally" '[ "$(grep -c "drop column file_deleted_at" "$ROLLBACK")" = 1 ] && grep -q "if v_marked = 0 then" "$ROLLBACK"'

echo "== Deployment"
db=$(new_db); seed "$db"; before=$(snapshot "$db"); rows=$(data_rows "$db")
check "verification reports FAIL before deployment" '[[ "$(overall "$db" "$VERIFY")" == FAIL* ]]'
out=$(run_file "$db" "$DEPLOY" || true)
check "deployment succeeds with preflight and self-check" '! grep -q ERROR <<<"$out" && grep -q "Preflight passed" <<<"$out" && grep -q "Post-install self-check passed" <<<"$out"'
check "2A-4c, 2A-4b and 2A-1 verifications all OVERALL PASS" 'all_pass "$db"'
echo "      (2A-4c verify: $(overall "$db" "$VERIFY"))"
check "2A-1 verification rows 10 and 12 PASS with the new functions" '[ "$(row "$db" "$V1" 10)" = PASS ] && [ "$(row "$db" "$V1" 12)" = PASS ]'
check "deployment changed no data (businesses, cases, records, audit history)" '[ "$(data_rows "$db")" = "$rows" ]'
seed_file "$db"
check "verification is read-only" 's1=$(snapshot "$db"); overall "$db" "$VERIFY" >/dev/null; [ "$(snapshot "$db")" = "$s1" ]'
deployed="$db"

echo "== Re-running, single-query mode, failures"
snap=$(snapshot "$deployed"); out=$(run_single "$deployed" "$DEPLOY" || true)
check "second run refused as already applied, nothing changed" 'grep -q "Stage 2A-4c is already applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
db=$(new_db); out=$(run_single "$db" "$DEPLOY" || true)
check "single-query deployment succeeds and verifies" '! grep -q ERROR <<<"$out" && all_pass "$db"'
broken="$WORK/broken.sql"
awk '/POST-INSTALL SELF-CHECK/ && !done {print "select 1/0; -- deliberate failure"; done=1} {print}' "$DEPLOY" > "$broken"
for mode in run_file run_single; do
  db=$(new_db); before=$(snapshot "$db"); out=$($mode "$db" "$broken" || true)
  check "[$mode] late failure rolls back completely (no bucket, no policies)" 'grep -q "division by zero" <<<"$out" && [ "$(snapshot "$db")" = "$before" ] && [ "$(sql "$db" "select count(*) from storage.buckets")" = 0 ]'
done
awk '/POST-INSTALL SELF-CHECK/ && !done {print "create policy sneaky on storage.objects for select to authenticated using (bucket_id = '"'"'case-screenshots'"'"'); -- weakness"; done=1} {print}' "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
check "self-check aborts if an extra read policy slips in" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
awk '/POST-INSTALL SELF-CHECK/ && !done {print "update storage.buckets set public = true where id = '"'"'case-screenshots'"'"'; -- weakness"; done=1} {print}' "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
check "self-check aborts if the bucket became public" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
awk '/POST-INSTALL SELF-CHECK/ && !done {print "grant execute on function private.screenshot_objects(uuid, uuid) to authenticated; -- weakness"; done=1} {print}' "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
check "self-check aborts on excess function privileges" 'grep -q "DEPLOYMENT ABORTED" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
awk '/POST-INSTALL SELF-CHECK/ && !done {print "alter table storage.objects disable row level security; -- weakness"; done=1} {print}' "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
check "self-check aborts if RLS on storage.objects is switched off during the deployment" 'grep -q "DEPLOYMENT ABORTED.*row level security is not enabled" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
awk '/POST-INSTALL SELF-CHECK/ && !done {print "alter policy rre_case_screenshots_insert on storage.objects with check (bucket_id = '"'"'case-screenshots'"'"' or private.screenshot_upload_allowed(name)); -- weakness"; done=1} {print}' "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); out=$(run_file "$db" "$broken" || true)
check "self-check aborts if a policy expression differs from the reviewed one" 'grep -q "DEPLOYMENT ABORTED.*policy expressions differ" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
head -n "$(grep -n "POST-INSTALL SELF-CHECK" "$DEPLOY" | head -1 | cut -d: -f1)" "$DEPLOY" > "$broken"
db=$(new_db); before=$(snapshot "$db"); run_single "$db" "$broken" >/dev/null 2>&1 || true
check "truncated copy without COMMIT leaves nothing behind" '[ "$(snapshot "$db")" = "$before" ]'

echo "== Preflight refusals"
db=$(new_db "" no4b); before=$(snapshot "$db"); out=$(run_file "$db" "$DEPLOY" || true)
check "refuses without Stage 2A-4b" 'grep -q "Stage 2A-4b is not applied" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "create policy public_read on storage.objects for select to anon using (true)" >/dev/null; before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when storage.objects already has policies (names them)" 'grep -q "storage.objects already has policies (public_read)" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "insert into storage.buckets (id, name, public) values ('case-screenshots', 'case-screenshots', true)" >/dev/null; before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when the bucket already exists as PUBLIC" 'grep -q "exists and is PUBLIC" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "alter table storage.objects disable row level security" >/dev/null; before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when RLS is off on storage.objects" 'grep -q "row level security is not enabled on storage.objects" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'
db=$(new_db); sql "$db" "alter table storage.objects drop column owner_id" >/dev/null; before=$(snapshot "$db")
out=$(run_file "$db" "$DEPLOY" || true)
check "refuses when storage.objects lacks owner_id" 'grep -q "lacks one of bucket_id, name, owner_id, metadata" <<<"$out" && [ "$(snapshot "$db")" = "$before" ]'

echo "== Verification detects weaknesses"
sql "$deployed" "create policy leak on storage.objects for select to authenticated using (bucket_id = 'case-screenshots')" >/dev/null
check "detects an extra read policy (row 2 FAIL)" '[ "$(row "$deployed" "$VERIFY" 2)" = FAIL ] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
sql "$deployed" "drop policy leak on storage.objects; create policy upd on storage.objects for update to authenticated using (false)" >/dev/null
check "detects an UPDATE policy (row 3 FAIL)" '[ "$(row "$deployed" "$VERIFY" 3)" = FAIL ]'
sql "$deployed" "drop policy upd on storage.objects; update storage.buckets set public = true where id = 'case-screenshots'" >/dev/null
check "detects a public bucket (row 1 FAIL)" '[ "$(row "$deployed" "$VERIFY" 1)" = FAIL ]'
sql "$deployed" "update storage.buckets set public = false where id = 'case-screenshots'; grant execute on function public.client_screenshot_status(uuid) to anon" >/dev/null
check "detects anon EXECUTE (row 6 FAIL) and 2A-1 row 9 FAIL" '[ "$(row "$deployed" "$VERIFY" 6)" = FAIL ] && [ "$(row "$deployed" "$V1" 9)" = FAIL ]'
sql "$deployed" "revoke execute on function public.client_screenshot_status(uuid) from anon; create function public.extra_fn() returns int language sql security definer set search_path = '' as 'select 1'; grant execute on function public.extra_fn() to authenticated" >/dev/null
check "2A-1 row 10 still FAILs on any other authenticated function" '[ "$(row "$deployed" "$V1" 10)" = FAIL ]'
sql "$deployed" "drop function public.extra_fn()" >/dev/null
check "all verifications back to PASS after reverting" 'all_pass "$deployed"'

echo "== Regression: weaknesses found in the d10e27c audit are now detected"
# (a) RLS switched off on storage.objects: previously no verify row checked it.
sql "$deployed" "alter table storage.objects disable row level security" >/dev/null
check "RLS off on storage.objects: row 12 FAIL, OVERALL FAIL" '[ "$(row "$deployed" "$VERIFY" 12)" = FAIL ] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
sql "$deployed" "alter table storage.objects enable row level security" >/dev/null
# (b) a policy expression edited in place: names and substrings still match.
sql "$deployed" "alter policy rre_case_screenshots_insert on storage.objects with check ((bucket_id = 'case-screenshots' and private.screenshot_upload_allowed(name)) or true)" >/dev/null
check "upload rule weakened with OR true: old rows 2 and 4 still PASS (the gap) ..." '[ "$(row "$deployed" "$VERIFY" 2)" = PASS ] && [ "$(row "$deployed" "$VERIFY" 4)" = PASS ]'
check "... but row 13 FAILs and OVERALL FAIL" '[ "$(row "$deployed" "$VERIFY" 13)" = FAIL ] && [[ "$(overall "$deployed" "$VERIFY")" == FAIL* ]]'
sql "$deployed" "alter policy rre_case_screenshots_insert on storage.objects with check (bucket_id = 'case-screenshots' and private.screenshot_upload_allowed(name))" >/dev/null
sql "$deployed" "alter policy rre_case_screenshots_select on storage.objects using ((bucket_id = 'case-screenshots' and (select private.is_founder())) or owner_id = auth.uid()::text)" >/dev/null
check "read rule widened to uploaders: row 13 FAIL" '[ "$(row "$deployed" "$VERIFY" 13)" = FAIL ]'
sql "$deployed" "alter policy rre_case_screenshots_select on storage.objects using (bucket_id = 'case-screenshots' and (select private.is_founder()))" >/dev/null
check "policies restored: row 13 PASS and OVERALL PASS" '[ "$(row "$deployed" "$VERIFY" 13)" = PASS ] && all_pass "$deployed"'
# (c) helper owner without SELECT on storage.objects (local postgres is a superuser,
#     so a separate non-superuser owner stands in for a Supabase-like setup).
sql "$deployed" "do \$r\$ begin create role helper_owner_t nologin bypassrls; exception when duplicate_object then null; end \$r\$;
  grant usage on schema private, storage, public, auth to helper_owner_t; grant execute on function auth.uid() to helper_owner_t; grant select on public.cases, public.business_members to helper_owner_t; grant execute on function private.my_business_id() to helper_owner_t;
  alter function private.screenshot_upload_allowed(text) owner to helper_owner_t; alter function private.screenshot_objects(uuid, uuid) owner to helper_owner_t" >/dev/null
check "helper owner lacks SELECT on storage.objects: row 14 FAIL" '[ "$(row "$deployed" "$VERIFY" 14)" = FAIL ]'
cat > "$WORK/up_try.sql" <<UPSQL
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$A_USER', 'role', 'authenticated')::text, false);
insert into storage.objects (bucket_id, name, owner_id) values ('case-screenshots', '$A_BIZ/$A_CASE/2-$(printf 'b%.0s' {1..64}).png', '$A_USER');
UPSQL
up_try=$("${PSQL[@]}" -d "$deployed" -f "$WORK/up_try.sql" 2>&1 || true)
check "... and uploads then fail closed (permission denied), never open" 'grep -q "permission denied for table objects" <<<"$up_try" && [ "$(sql "$deployed" "select count(*) from storage.objects where name like '"'"'%/2-%'"'"'")" = 0 ]'
sql "$deployed" "grant select on storage.objects to helper_owner_t" >/dev/null
check "granting SELECT turns row 14 back to PASS" '[ "$(row "$deployed" "$VERIFY" 14)" = PASS ]'
sql "$deployed" "alter function private.screenshot_upload_allowed(text) owner to postgres; alter function private.screenshot_objects(uuid, uuid) owner to postgres" >/dev/null
check "owners restored: all verifications PASS" 'all_pass "$deployed"'
# (d) preflight refuses a deploying role without the Storage privileges the helpers need.
db=$(new_db)
sed -n '/^do \$preflight\$/,/^\$preflight\$;/p' "$DEPLOY" > "$WORK/preflight.sql"
sql "$db" "do \$r\$ begin create role deployer_t nologin bypassrls; exception when duplicate_object then null; end \$r\$; grant usage on schema storage, private, public to deployer_t" >/dev/null
pf=$("${PSQL[@]}" -d "$db" -c "set role deployer_t" -f "$WORK/preflight.sql" 2>&1 || true)
check "preflight refuses: deploying role lacks SELECT on storage.objects" 'grep -q "lacks SELECT on storage.objects" <<<"$pf"'
check "preflight refuses: deploying role lacks SELECT/INSERT/UPDATE on storage.buckets" 'grep -q "lacks SELECT/INSERT/UPDATE on storage.buckets" <<<"$pf"'
sql "$db" "grant select on storage.objects to deployer_t; grant select, insert, update on storage.buckets to deployer_t" >/dev/null
pf=$("${PSQL[@]}" -d "$db" -c "set role deployer_t" -f "$WORK/preflight.sql" 2>&1 || true)
check "with those privileges the preflight no longer reports them" '! grep -q "lacks SELECT" <<<"$pf"'

echo "== Staging isolation check (deploy/stage2a4c_isolation_check.sql)"
iso() { sed -e "s/REPLACE_CLIENT_B_USER_ID/$B_USER/g" -e "s/REPLACE_BUSINESS_A_ID/$A_BIZ/g" -e "s/REPLACE_CASE_A_ID/$A_CASE/g" "$D/stage2a4c_isolation_check.sql" > "$WORK/iso.sql"
       "${PSQL[@]}" -d "$1" -At -F '|' -c "$(cat "$WORK/iso.sql")" 2>&1 | grep -E '^(REFUSED|ALLOWED)'; }
s1=$(snapshot "$deployed"); ev=$(evidence "$deployed"); res=$(iso "$deployed")
check "client B: upload into A refused, 0 files visible, A's status refused, role CLIENT" '[[ "$res" == REFUSED*"|0|REFUSED: NOT_FOUND"*"|CLIENT" ]]'
check "isolation check left no trace" '[ "$(snapshot "$deployed")" = "$s1" ] && [ "$(evidence "$deployed")" = "$ev" ]'
db=$(new_db); seed "$db"; run_file "$db" "$DEPLOY" >/dev/null; seed_file "$db"; sql "$db" "create policy weak on storage.objects for insert to authenticated with check (true)" >/dev/null
check "the isolation check reports a real problem when one exists" '[[ "$(iso "$db")" == "ALLOWED"* ]]'

echo "== Rollback"
sql "$deployed" "insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256)
  select '$A_CASE', '$A_BIZ', 1, name, 'image/png', 1000, repeat('a', 64) from storage.objects limit 1" >/dev/null
ev=$(evidence "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "rollback succeeds; policies and functions removed" '! grep -q ERROR <<<"$out" && [ -z "$(storage_policies "$deployed")" ] && [ "$(sql "$deployed" "select to_regprocedure('"'"'public.client_finalize_screenshots(uuid)'"'"') is null")" = t ]'
check "rollback kept screenshot records, audit history and files" '[ "$(evidence "$deployed")" = "$ev" ]'
check "rollback dropped file_deleted_at (no values were recorded)" '[ "$(sql "$deployed" "select count(*) from information_schema.columns where table_name = '"'"'case_screenshots'"'"' and column_name = '"'"'file_deleted_at'"'"'")" = 0 ] && grep -q "dropped (it held no values)" <<<"$out"'
check "after rollback: 2A-4b and 2A-1 verifications PASS" '[[ "$(overall "$deployed" "$V4B")" == "PASS ("*" 0 fail"* ]] && [[ "$(overall "$deployed" "$V1")" == "PASS ("*" 0 fail"* ]]'
check "after rollback: no API user can read files (no storage policies)" '[ "$(sql "$deployed" "set role authenticated; select count(*) from storage.objects")" = 0 ]'
snap=$(snapshot "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "second rollback refused, nothing changed" 'grep -q "Stage 2A-4c is not applied" <<<"$out" && [ "$(snapshot "$deployed")" = "$snap" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploy after rollback works (existing private bucket and files kept)" '! grep -q ERROR <<<"$out" && all_pass "$deployed"'
sql "$deployed" "update public.case_screenshots set file_deleted_at = now()" >/dev/null
ev=$(evidence "$deployed"); out=$(run_file "$deployed" "$ROLLBACK" || true)
check "rollback KEEPS file_deleted_at when it holds retention timestamps" 'grep -q "KEPT: 1 row(s) carry a retention timestamp" <<<"$out" && [ "$(sql "$deployed" "select count(*) from public.case_screenshots where file_deleted_at is not null")" = 1 ]'
check "rollback audit entry records that the column was kept" '[ "$(sql "$deployed" "select details->>'"'"'file_deleted_at_column_kept'"'"' from public.audit_log where action = '"'"'SCHEMA_ROLLED_BACK'"'"' order by id desc limit 1")" = true ] && [ "$(evidence "$deployed")" = "$ev" ]'
out=$(run_file "$deployed" "$DEPLOY" || true)
check "re-deploy over a kept column works" '! grep -q ERROR <<<"$out" && all_pass "$deployed"'

echo "== Retention scripts"
db=$(new_db); seed "$db"; run_file "$db" "$DEPLOY" >/dev/null; seed_file "$db"
sql "$db" "update public.cases set created_at = now() - interval '8 days' where id = '$A_CASE'; update storage.objects set created_at = now() - interval '8 days'" >/dev/null
s1=$(snapshot "$db"); rep=$("${PSQL[@]}" -d "$db" -At -F '|' < "$HERE/admin/screenshot_retention_report.sql")
check "retention report lists the abandoned draft's file and is read-only" 'grep -q "unrecorded" <<<"$rep" && [ "$(snapshot "$db")" = "$s1" ]'
sql "$db" "insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256)
  select '$A_CASE', '$A_BIZ', 1, name, 'image/png', 1000, repeat('a', 64) from storage.objects limit 1" >/dev/null
run_file "$db" "$HERE/admin/screenshot_mark_deleted.sql" >/dev/null
check "mark-deleted does nothing while the file still exists" '[ "$(sql "$db" "select count(*) from public.case_screenshots where file_deleted_at is not null")" = 0 ]'
sql "$db" "delete from storage.objects" >/dev/null   # stands in for deleting in the dashboard
run_file "$db" "$HERE/admin/screenshot_mark_deleted.sql" >/dev/null
check "mark-deleted marks the row, keeps it, audits once" '[ "$(sql "$db" "select count(*) from public.case_screenshots where file_deleted_at is not null")" = 1 ] && [ "$(sql "$db" "select count(*) from public.audit_log where action = '"'"'SCREENSHOT_FILES_DELETED'"'"'")" = 1 ]'
run_file "$db" "$HERE/admin/screenshot_mark_deleted.sql" >/dev/null
check "mark-deleted re-run changes nothing" '[ "$(sql "$db" "select count(*) from public.audit_log where action = '"'"'SCREENSHOT_FILES_DELETED'"'"'")" = 1 ]'

echo "== Alongside Supabase's verified rls_auto_enable helper"
db=$(new_db helper); out=$(run_single "$db" "$DEPLOY" || true)
check "deploys alongside the helper; all verifications pass; 2A-1 row 20 PASS" '! grep -q ERROR <<<"$out" && all_pass "$db" && [ "$(row "$db" "$V1" 20)" = PASS ]'
out=$(run_single "$db" "$ROLLBACK" || true)
check "rollback alongside the helper; 2A-1 row 20 still PASS" '! grep -q ERROR <<<"$out" && [ "$(row "$db" "$V1" 20)" = PASS ]'

echo "== $pass passed; $fail failed"
[ "$fail" = 0 ]

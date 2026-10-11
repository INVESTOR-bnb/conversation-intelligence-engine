-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4c-1 VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run after stage2a4c1_deploy.sql; then re-run stage2a4c_verify.sql,
-- stage2a4b_verify.sql and stage2a1_verify.sql.
-- ===================================================================
with
g as (select t.*, regexp_replace(pg_get_triggerdef(t.oid), '\s', '', 'g') as def
      from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'rre_case_screenshots_guard'),
f as (select p.*, r.rolsuper or r.rolbypassrls as owner_bypasses_rls
      from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = to_regprocedure('private.screenshot_object_guard()')),
checks(ord, check_name, status, detail) as (
  select 1, 'Upload guard trigger exists on storage.objects',
    case when exists (select 1 from g) then 'PASS' else 'FAIL' end, 'rre_case_screenshots_guard'
  union all
  select 2, 'Guard is enabled, BEFORE INSERT, FOR EACH ROW',
    case when exists (select 1 from g where tgenabled = 'O' and tgtype = 7 and not tgisinternal) then 'PASS' else 'FAIL' end,
    coalesce((select format('enabled=%s, type=%s', tgenabled, tgtype) from g), 'missing')
  union all
  select 3, 'Guard condition and function are exactly the reviewed ones',
    case when exists (select 1 from g where def = 'CREATETRIGGERrre_case_screenshots_guardBEFOREINSERTONstorage.objectsFOREACHROWWHEN(((new.bucket_id=''case-screenshots''::text)AND(NOTrow_security_active((''storage.objects''::regclass)::oid))))EXECUTEFUNCTIONprivate.screenshot_object_guard()')
         then 'PASS' else 'FAIL' end,
    coalesce((select pg_get_triggerdef(oid) from g), 'missing')
  union all
  select 4, 'Guard function: SECURITY DEFINER, empty search_path, owner bypasses RLS',
    case when exists (select 1 from f where prosecdef and proconfig @> array['search_path=""'] and owner_bypasses_rls) then 'PASS' else 'FAIL' end,
    coalesce((select pg_get_userbyid(proowner) from f), 'missing')
  union all
  select 5, 'Guard function is not callable by anon, authenticated or service_role',
    case when exists (select 1 from f)
          and not has_function_privilege('anon', 'private.screenshot_object_guard()', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.screenshot_object_guard()', 'EXECUTE')
          and not has_function_privilege('service_role', 'private.screenshot_object_guard()', 'EXECUTE') then 'PASS' else 'FAIL' end,
    'triggers fire without EXECUTE'
  union all
  select 6, 'Stage 2A-4c storage policies are unchanged (exactly two)',
    case when (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects') = 2
          and (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'rre_case_screenshots_%') = 2
         then 'PASS' else 'FAIL' end, 'storage.objects'
  union all
  select 7, 'Stage 2A-4c-1 deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-4c-1'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-4c-1'
  union all
  select 8, 'Unrecorded files in the bucket (orphans, e.g. from signed URLs used before this guard)', 'INFO',
    (select count(*) from storage.objects o
     where o.bucket_id = 'case-screenshots'
       and not exists (select 1 from public.case_screenshots s where s.storage_path = o.name))::text
    || ' unrecorded file(s) in the bucket — see admin/live_check_cleanup_report.sql'
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

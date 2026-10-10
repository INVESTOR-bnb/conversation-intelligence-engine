-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4c VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run after stage2a4c_deploy.sql. Every row should be PASS (INFO rows are for
-- information). Also re-run stage2a4b_verify.sql and stage2a1_verify.sql.
-- Note: this checks configuration. It cannot check stored file CONTENTS;
-- nothing server-side validates that uploads are real images.
-- ===================================================================
with
fns(sig) as (values ('private.screenshot_upload_allowed(text)'), ('private.screenshot_objects(uuid, uuid)'),
                    ('public.client_screenshot_status(uuid)'), ('public.client_finalize_screenshots(uuid)')),
sp as (select * from pg_policies where schemaname = 'storage' and tablename = 'objects'),
checks(ord, check_name, status, detail) as (
  select 1, 'Bucket case-screenshots is private, 5 MB, PNG/JPEG only',
    case when exists (select 1 from storage.buckets where id = 'case-screenshots' and not public and file_size_limit = 5242880
                      and allowed_mime_types = array['image/png', 'image/jpeg']) then 'PASS' else 'FAIL' end,
    coalesce((select format('public=%s, limit=%s, types=%s', public, file_size_limit, allowed_mime_types) from storage.buckets where id = 'case-screenshots'), 'bucket missing')
  union all
  select 2, 'storage.objects has exactly the two Stage 2A-4c policies',
    case when (select count(*) from sp) = 2 and (select count(*) from sp where policyname like 'rre_case_screenshots_%') = 2 then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(policyname || ':' || cmd, ', ' order by policyname) from sp), 'none')
  union all
  select 3, 'No replace, move or delete for any API user (no UPDATE/DELETE/ALL policy)',
    case when not exists (select 1 from sp where cmd in ('UPDATE', 'DELETE', 'ALL')) then 'PASS' else 'FAIL' end, 'storage.objects'
  union all
  select 4, 'Upload: authenticated members via the upload rule; read: founder only',
    case when exists (select 1 from sp where policyname = 'rre_case_screenshots_insert' and cmd = 'INSERT' and roles = '{authenticated}'
                      and with_check like '%case-screenshots%' and with_check like '%screenshot_upload_allowed%')
          and exists (select 1 from sp where policyname = 'rre_case_screenshots_select' and cmd = 'SELECT' and roles = '{authenticated}'
                      and qual like '%case-screenshots%' and qual like '%is_founder%' and qual not like '%is_member%' and qual not like '%owner%')
         then 'PASS' else 'FAIL' end, 'no client read access to files'
  union all
  select 5, 'New functions: SECURITY DEFINER, empty search_path',
    case when (select count(*) from fns f join pg_proc p on p.oid = to_regprocedure(f.sig)
               where p.prosecdef and p.proconfig @> array['search_path=""']) = 4 then 'PASS' else 'FAIL' end,
    (select string_agg(f.sig, ', ') from fns f)
  union all
  select 6, 'Least-privilege EXECUTE on new functions',
    case when to_regprocedure('public.client_finalize_screenshots(uuid)') is not null
          and has_function_privilege('authenticated', 'public.client_finalize_screenshots(uuid)', 'EXECUTE')
          and has_function_privilege('authenticated', 'public.client_screenshot_status(uuid)', 'EXECUTE')
          and has_function_privilege('authenticated', 'private.screenshot_upload_allowed(text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.screenshot_objects(uuid, uuid)', 'EXECUTE')
          and not exists (select 1 from fns f where has_function_privilege('anon', to_regprocedure(f.sig), 'EXECUTE'))
         then 'PASS' else 'FAIL' end, 'anon: none; authenticated: status, finalize, upload rule only'
  union all
  select 7, 'Function owner can see all stored files (bypasses RLS)',
    case when (select bool_and(r.rolsuper or r.rolbypassrls) from fns f join pg_proc p on p.oid = to_regprocedure(f.sig) join pg_roles r on r.oid = p.proowner) then 'PASS' else 'FAIL' end,
    (select string_agg(distinct pg_get_userbyid(p.proowner), ', ') from fns f join pg_proc p on p.oid = to_regprocedure(f.sig))
  union all
  select 8, 'case_screenshots stays founder-only and has the retention column',
    case when (select count(*) from pg_policies where schemaname = 'public' and tablename = 'case_screenshots') = 1
          and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'case_screenshots' and qual like '%is_founder%' and qual not like '%is_member%')
          and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'case_screenshots' and column_name = 'file_deleted_at')
         then 'PASS' else 'FAIL' end, 'RLS from Stage 2A-4b; file_deleted_at present'
  union all
  select 9, 'Stage 2A-4c deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-4c'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-4c'
  union all
  select 10, 'Stored files / recorded screenshots / unrecorded files / files marked deleted', 'INFO',
    (select count(*) from storage.objects where bucket_id = 'case-screenshots')::text || ' / '
    || (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.case_screenshots', false, true, '')))[1]::text || ' / '
    || (select count(*) from storage.objects o where o.bucket_id = 'case-screenshots'
          and not exists (select 1 from public.case_screenshots s where s.storage_path = o.name))::text || ' / '
    || case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'case_screenshots' and column_name = 'file_deleted_at')
            then (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.case_screenshots where file_deleted_at is not null', false, true, '')))[1]::text
            else 'n/a (column absent)' end
  union all
  select 11, 'File contents are not validated server-side', 'INFO',
    'type and hash are client-reported; Storage enforces size and declared type only'
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

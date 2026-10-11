-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem
-- rolls everything back.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
begin
  if not exists (select 1 from storage.buckets where id = 'case-screenshots' and not public and file_size_limit = 5242880
                 and allowed_mime_types = array['image/png', 'image/jpeg']) then
    v_problems := array_append(v_problems, 'bucket case-screenshots is not private / 5 MB / PNG+JPEG'::text);
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects') <> 2
     or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'rre_case_screenshots_insert'
                    and cmd = 'INSERT' and roles = '{authenticated}' and with_check like '%case-screenshots%' and with_check like '%screenshot_upload_allowed%')
     or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'rre_case_screenshots_select'
                    and cmd = 'SELECT' and roles = '{authenticated}' and qual like '%case-screenshots%' and qual like '%is_founder%') then
    v_problems := array_append(v_problems, 'storage policies are not exactly: INSERT (member upload rule) + SELECT (founder)'::text);
  end if;
  if not (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) then
    v_problems := array_append(v_problems, 'row level security is not enabled on storage.objects'::text);
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'rre_case_screenshots_insert'
                 and polcmd = 'a' and polpermissive and polroles = array['authenticated'::regrole]::oid[] and polqual is null
                 and regexp_replace(pg_get_expr(polwithcheck, polrelid), '\s', '', 'g')
                     = '((bucket_id=''case-screenshots''::text)ANDprivate.screenshot_upload_allowed(name))')
     or not exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'rre_case_screenshots_select'
                 and polcmd = 'r' and polpermissive and polroles = array['authenticated'::regrole]::oid[] and polwithcheck is null
                 and regexp_replace(pg_get_expr(polqual, polrelid), '\s', '', 'g')
                     = '((bucket_id=''case-screenshots''::text)AND(SELECTprivate.is_founder()ASis_founder))') then
    v_problems := array_append(v_problems, 'storage policy expressions differ from the reviewed ones'::text);
  end if;
  if exists (select 1 from pg_proc p where p.oid in ('private.screenshot_upload_allowed(text)'::regprocedure, 'private.screenshot_objects(uuid, uuid)'::regprocedure)
             and not has_table_privilege(p.proowner, 'storage.objects', 'SELECT')) then
    v_problems := array_append(v_problems, 'the helpers'' owner lacks SELECT on storage.objects'::text);
  end if;
  if exists (select 1 from pg_proc where oid in ('private.screenshot_upload_allowed(text)'::regprocedure, 'private.screenshot_objects(uuid, uuid)'::regprocedure,
             'public.client_screenshot_status(uuid)'::regprocedure, 'public.client_finalize_screenshots(uuid)'::regprocedure)
             and not (prosecdef and proconfig @> array['search_path=""'])) then
    v_problems := array_append(v_problems, 'a new function is not SECURITY DEFINER with an empty search_path'::text);
  end if;
  if has_function_privilege('anon', 'private.screenshot_upload_allowed(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.client_screenshot_status(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.client_finalize_screenshots(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'private.screenshot_objects(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.screenshot_objects(uuid, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'private.screenshot_upload_allowed(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.client_screenshot_status(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.client_finalize_screenshots(uuid)', 'EXECUTE') then
    v_problems := array_append(v_problems, 'new function privileges are not least-privilege'::text);
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'case_screenshots'
      and qual like '%is_founder%' and qual not like '%is_member%') <> 1 then
    v_problems := array_append(v_problems, 'case_screenshots is no longer founder-only'::text);
  end if;
  if exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT') then
    v_problems := array_append(v_problems, 'API roles hold write privileges on public tables'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: private bucket, two storage policies, least-privilege functions.';
end
$postcheck$;

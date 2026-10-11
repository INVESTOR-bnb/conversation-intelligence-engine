-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem
-- rolls everything back.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
begin
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'rre_case_screenshots_guard'
                 and t.tgenabled = 'O' and t.tgtype = 7 and not t.tgisinternal
                 and t.tgfoid = 'private.screenshot_object_guard()'::regprocedure
                 and regexp_replace(pg_get_triggerdef(t.oid), '\s', '', 'g')
                     = 'CREATETRIGGERrre_case_screenshots_guardBEFOREINSERTONstorage.objectsFOREACHROWWHEN(((new.bucket_id=''case-screenshots''::text)AND(NOTrow_security_active((''storage.objects''::regclass)::oid))))EXECUTEFUNCTIONprivate.screenshot_object_guard()') then
    v_problems := array_append(v_problems, 'the upload guard trigger is not exactly the reviewed one (BEFORE INSERT, each row, enabled, reviewed condition)'::text);
  end if;
  if not (select prosecdef and proconfig @> array['search_path=""'] and (rolsuper or rolbypassrls)
          from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = 'private.screenshot_object_guard()'::regprocedure) then
    v_problems := array_append(v_problems, 'the guard function is not SECURITY DEFINER with an empty search_path, owned by a role that bypasses RLS'::text);
  end if;
  if has_function_privilege('anon', 'private.screenshot_object_guard()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.screenshot_object_guard()', 'EXECUTE')
     or has_function_privilege('service_role', 'private.screenshot_object_guard()', 'EXECUTE') then
    v_problems := array_append(v_problems, 'the guard function is callable by an API role'::text);
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects') <> 2 then
    v_problems := array_append(v_problems, 'storage.objects policies changed'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: upload guard installed on storage.objects.';
end
$postcheck$;

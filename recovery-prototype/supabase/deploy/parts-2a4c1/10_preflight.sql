-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-4c is applied,
-- 2A-4c-1 is not, and this role may create the trigger.
-- ===================================================================
do $preflight$
declare
  v_problems text[] := '{}';
begin
  if to_regprocedure('public.client_finalize_screenshots(uuid)') is null
     or (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'rre_case_screenshots_%') <> 2 then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-4c is not applied (run stage2a4c_deploy.sql first).';
  end if;
  if to_regprocedure('private.screenshot_object_guard()') is not null
     or exists (select 1 from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'rre_case_screenshots_guard') then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-4c-1 is already applied.';
  end if;
  -- Creating a trigger on storage.objects needs the TRIGGER privilege (or ownership).
  if not (has_table_privilege(current_user, 'storage.objects', 'TRIGGER')
          or pg_has_role(current_user, (select relowner from pg_class where oid = 'storage.objects'::regclass), 'USAGE')) then
    v_problems := array_append(v_problems, format('role %s lacks the TRIGGER privilege on storage.objects, so the upload guard cannot be installed; see the runbook (server-mediated alternative)', current_user));
  end if;
  -- The guard function runs as its owner (this role) and must see every case, membership and stored file.
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    v_problems := array_append(v_problems, format('role %s cannot bypass RLS, so the guard could not see cases and stored files', current_user));
  end if;
  if not has_table_privilege(current_user, 'storage.objects', 'SELECT') then
    v_problems := array_append(v_problems, format('role %s lacks SELECT on storage.objects', current_user));
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Preflight passed: Stage 2A-4c found; installing the Stage 2A-4c-1 upload guard.';
end
$preflight$;

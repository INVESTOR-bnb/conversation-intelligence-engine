-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4c-1 DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a4c1.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-4c. Adds the screenshot upload guard: one trigger on
-- storage.objects and its function. It refuses screenshot files written
-- without RLS (Storage's own writes, e.g. signed upload URLs) unless the case
-- is an open screenshot draft of the uploader's business and the position is
-- free. No data is changed. All-or-nothing. Contains no credentials.
-- Refuses to run if 2A-4c is missing, if 2A-4c-1 is already applied, or if
-- this role may not create triggers on storage.objects.
-- Undo: deploy/stage2a4c1_rollback.sql. Check: deploy/stage2a4c1_verify.sql.
--
-- Source migration (sha256):
--   20261013120000_stage2a4c1_upload_guard.sql  5c138133d5f9b11241e340a36ce1b40450403bae6f3d0140ea70c7557a5ff5c0
-- ===================================================================

begin;

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

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261013120000_stage2a4c1_upload_guard.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-4c-1 — screenshot upload guard on EVERY write path.
--
-- Why: the Storage API checks the INSERT policy (rre_case_screenshots_insert)
-- as the signed-in caller, but writes the object row itself as service_role,
-- which bypasses RLS. A signed upload URL (createSignedUploadUrl) is checked
-- against the policy only when it is CREATED; when it is USED, Storage writes
-- as service_role without re-checking. So a URL created while a case was a
-- draft still worked after the case was submitted (seen on staging: an
-- unrecorded file landed in a submitted case). From Storage's source, a URL
-- created with upsert could likewise replace an existing file later.
--
-- Fix: a BEFORE INSERT trigger re-applies the upload rule to every insert into
-- this bucket made WITHOUT row level security (service_role, the table owner,
-- postgres). Inserts by roles subject to RLS are left to the existing policy,
-- so ordinary client uploads behave exactly as before. Storage's own upsert is
-- an INSERT ... ON CONFLICT DO UPDATE, so the trigger also covers replacement.
-- The rule uses the uploader Storage recorded (owner_id), not the session.
--
-- Rollback: supabase/deploy/stage2a4c1_rollback.sql.

create function private.screenshot_object_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_m text[];
  v_prefix text;
begin
  v_m := regexp_match(coalesce(new.name, ''),
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(10|[1-9])-[0-9a-f]{64}\.(png|jpg)$');
  if v_m is null then
    raise exception 'screenshot upload refused: invalid file name' using errcode = '42501';
  end if;
  -- The uploader recorded by Storage must (still) be a member of the business in the path.
  if new.owner_id is null or not exists (select 1 from public.business_members m
                                         where m.business_id = v_m[1]::uuid and m.user_id::text = new.owner_id) then
    raise exception 'screenshot upload refused: uploader is not a member of this business' using errcode = '42501';
  end if;
  if not exists (select 1 from public.cases c
                 where c.id = v_m[2]::uuid and c.business_id = v_m[1]::uuid
                   and c.workflow_state = 'DRAFT' and c.conversation_source = 'SCREENSHOTS') then
    raise exception 'screenshot upload refused: the case is not an open screenshot draft' using errcode = '42501';
  end if;
  v_prefix := v_m[1] || '/' || v_m[2] || '/';
  if exists (select 1 from storage.objects o
             where o.bucket_id = 'case-screenshots' and o.name like v_prefix || v_m[3] || '-%') then
    raise exception 'screenshot upload refused: this position already holds a file' using errcode = '42501';
  end if;
  if (select count(*) from storage.objects o
      where o.bucket_id = 'case-screenshots' and o.name like v_prefix || '%') >= 10 then
    raise exception 'screenshot upload refused: the case already holds 10 files' using errcode = '42501';
  end if;
  return new;
end $$;

-- Fires only for this bucket and only when RLS does not apply to the inserting
-- role (the WHEN clause is evaluated as that role).
create trigger rre_case_screenshots_guard
  before insert on storage.objects
  for each row
  when (new.bucket_id = 'case-screenshots' and not row_security_active('storage.objects'::regclass))
  execute function private.screenshot_object_guard();

-- Trigger functions need no EXECUTE privilege to fire; nobody may call it directly.
revoke all on function private.screenshot_object_guard() from public, anon, authenticated, service_role;
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261013120000_stage2a4c1_upload_guard.sql <<<<<<<<<<<<<<<<<<<<

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

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-4c-1', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261013120000_stage2a4c1_upload_guard.sql', 'sha256', '5c138133d5f9b11241e340a36ce1b40450403bae6f3d0140ea70c7557a5ff5c0'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

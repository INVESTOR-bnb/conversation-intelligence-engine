-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4c DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a4c.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-4b. Adds: the private bucket case-screenshots (5 MB,
-- PNG/JPEG), two storage policies (member upload rule, founder read), three
-- functions, and the nullable column case_screenshots.file_deleted_at.
-- No data is changed. All-or-nothing. Contains no credentials.
-- Refuses to run if 2A-4b is missing, if 2A-4c is already applied, or if
-- storage.objects already has policies.
-- Undo: deploy/stage2a4c_rollback.sql. Check: deploy/stage2a4c_verify.sql.
--
-- Source migration (sha256):
--   20261012120000_stage2a4c_screenshots.sql  8e72852bfa92720198a0310eb977aca93b0a6b8c2a060da4adeeb870c2793336
-- ===================================================================

begin;

-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-4b is applied,
-- Supabase Storage is present as expected, and 2A-4c is not yet applied.
-- ===================================================================
do $preflight$
declare
  v_problems text[] := '{}';
  v_other text;
begin
  if to_regprocedure('public.client_list_cases()') is null or to_regprocedure('private.my_business_id()') is null
     or to_regprocedure('private.client_case_for_update(uuid)') is null or to_regprocedure('private.audit(text, uuid, uuid, text, text, jsonb)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-1 is not installed in this database.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cases' and policyname = 'cases_select'
                 and qual like '%is_founder%' and qual not like '%is_member%') then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-4b is not applied (run stage2a4b_deploy.sql first).';
  end if;
  if to_regprocedure('public.client_finalize_screenshots(uuid)') is not null
     or exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'rre_case_screenshots_%') then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-4c is already applied.';
  end if;

  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    v_problems := array_append(v_problems, 'Supabase Storage tables storage.objects / storage.buckets not found'::text);
  else
    if (select count(*) from information_schema.columns where table_schema = 'storage' and table_name = 'objects'
        and column_name in ('bucket_id', 'name', 'owner_id', 'metadata')) <> 4 then
      v_problems := array_append(v_problems, 'storage.objects lacks one of bucket_id, name, owner_id, metadata'::text);
    end if;
    if (select count(*) from information_schema.columns where table_schema = 'storage' and table_name = 'buckets'
        and column_name in ('id', 'name', 'public', 'file_size_limit', 'allowed_mime_types')) <> 5 then
      v_problems := array_append(v_problems, 'storage.buckets lacks one of id, name, public, file_size_limit, allowed_mime_types'::text);
    end if;
    if not (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) then
      v_problems := array_append(v_problems, 'row level security is not enabled on storage.objects'::text);
    end if;
    select string_agg(policyname, ', ') into v_other from pg_policies where schemaname = 'storage' and tablename = 'objects';
    if v_other is not null then
      v_problems := array_append(v_problems, 'storage.objects already has policies (' || v_other || '); review them before deploying'::text);
    end if;
    if exists (select 1 from storage.buckets where id = 'case-screenshots' and public) then
      v_problems := array_append(v_problems, 'bucket case-screenshots exists and is PUBLIC'::text);
    end if;
  end if;
  -- The security-definer helpers read storage.objects (owned by Supabase's storage role);
  -- they only see every row if their owner (the deploying role) bypasses RLS.
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    v_problems := array_append(v_problems, format('role %s cannot bypass RLS, so the helpers could not see stored files', current_user));
  end if;

  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Preflight passed: Stage 2A-4b found, Storage present, no existing storage policies; applying Stage 2A-4c.';
end
$preflight$;

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261012120000_stage2a4c_screenshots.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-4c — screenshot intake (synthetic staging).
--
-- Clients upload processed screenshots straight to a PRIVATE Storage bucket.
-- The database decides who may upload where; only the founder can read files;
-- nobody can replace, move or delete files through the API.
--
--   path: {business_id}/{case_id}/{position}-{sha256}.{png|jpg}
--
-- What is and is NOT verified server-side:
--   * Storage enforces the bucket size limit and the DECLARED content type.
--   * The database checks path, ownership, case state, uploader, recorded size,
--     declared type vs extension, one file per position and no gaps.
--   * Nobody server-side inspects file CONTENTS. sha256 is reported by the
--     client and is not recomputed. Content validation must exist before any
--     analysis reads these files.
--
-- Rollback: supabase/deploy/stage2a4c_rollback.sql (keeps records and evidence).

-- ---------------------------------------------------------------- retention marker
alter table public.case_screenshots add column if not exists file_deleted_at timestamptz;
comment on column public.case_screenshots.file_deleted_at is
  'Set by the administrator retention runbook after the stored file was deleted. The row is kept as evidence.';
comment on column public.case_screenshots.sha256 is
  'SHA-256 reported by the client for the processed image; not recomputed server-side.';

-- ---------------------------------------------------------------- bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('case-screenshots', 'case-screenshots', false, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 5242880,
  allowed_mime_types = array['image/png', 'image/jpeg'];

-- ---------------------------------------------------------------- upload rule helper
-- Called by the storage INSERT policy for every upload into this bucket. Returns
-- false (never an error) unless ALL hold: valid name, caller is a member of the
-- business in the path, the case belongs to that business and is a DRAFT with
-- source SCREENSHOTS, no file is stored yet at that position, fewer than 10
-- files exist for the case. Not a concurrency guarantee: two simultaneous
-- uploads can both pass; client_finalize_screenshots rejects such duplicates.
create function private.screenshot_upload_allowed(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_m text[];
  v_prefix text;
begin
  if (select auth.uid()) is null or p_name is null then
    return false;
  end if;
  v_m := regexp_match(p_name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(10|[1-9])-[0-9a-f]{64}\.(png|jpg)$');
  if v_m is null then
    return false;
  end if;
  if v_m[1]::uuid is distinct from private.my_business_id() then
    return false;
  end if;
  if not exists (select 1 from public.cases c
                 where c.id = v_m[2]::uuid and c.business_id = v_m[1]::uuid
                   and c.workflow_state = 'DRAFT' and c.conversation_source = 'SCREENSHOTS') then
    return false;
  end if;
  v_prefix := v_m[1] || '/' || v_m[2] || '/';
  if exists (select 1 from storage.objects o
             where o.bucket_id = 'case-screenshots' and o.name like v_prefix || v_m[3] || '-%') then
    return false;
  end if;
  if (select count(*) from storage.objects o
      where o.bucket_id = 'case-screenshots' and o.name like v_prefix || '%') >= 10 then
    return false;
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------- storage policies
-- Upload: members, into their own draft screenshot cases only.
create policy rre_case_screenshots_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'case-screenshots' and private.screenshot_upload_allowed(name));
-- Read (download, list, signed URL, copy source): founder only.
create policy rre_case_screenshots_select on storage.objects for select to authenticated
  using (bucket_id = 'case-screenshots' and (select private.is_founder()));
-- No UPDATE or DELETE policy: replacing, moving and deleting are denied to all API users.

-- ---------------------------------------------------------------- stored files of one case
-- Internal (not executable by API roles). Lists this bucket's files under the
-- case folder with the parsed name and Storage's recorded size / declared type.
create function private.screenshot_objects(p_business_id uuid, p_case_id uuid)
returns table (name text, pos int, sha256 text, ext text, size bigint, mimetype text, owner_id text)
language sql stable security definer set search_path = '' as $$
  select o.name, (x.m)[1]::int, (x.m)[2], (x.m)[3], (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype', o.owner_id
  from storage.objects o
  cross join lateral (select regexp_match(substr(o.name, char_length(p_business_id::text || '/' || p_case_id::text || '/') + 1),
                                          '^(10|[1-9])-([0-9a-f]{64})\.(png|jpg)$') as m) x
  where o.bucket_id = 'case-screenshots' and o.name like p_business_id::text || '/' || p_case_id::text || '/%';
$$;

-- ---------------------------------------------------------------- client: status
-- What is uploaded and recorded for one of the caller's own cases (for resuming
-- and for confirming an upload whose response was lost: position + hash + size).
-- Returns no paths. The hashes are the ones the client itself reported.
create function public.client_screenshot_status(p_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_case public.cases;
  v_files jsonb;
begin
  if (select auth.uid()) is null then
    perform private.fail('FORBIDDEN', 'sign-in required');
  end if;
  select * into v_case from public.cases where id = p_case_id;
  if not found or v_case.business_id is distinct from private.my_business_id() then
    perform private.fail('NOT_FOUND', 'case not found');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'position', f.pos,
           'sha256', f.sha256,
           'size', f.size,
           'mime_type', f.mimetype,
           'registered', exists (select 1 from public.case_screenshots s where s.case_id = v_case.id and s.storage_path = f.name))
         order by f.pos, f.name), '[]'::jsonb)
    into v_files
  from private.screenshot_objects(v_case.business_id, v_case.id) f;
  return jsonb_build_object(
    'case_id', v_case.id,
    'source', v_case.conversation_source,
    'is_draft', v_case.workflow_state = 'DRAFT',
    'files', v_files,
    'registered_count', (select count(*) from public.case_screenshots s where s.case_id = v_case.id));
end $$;

-- ---------------------------------------------------------------- client: finalize
-- Records every uploaded file of the caller's own DRAFT screenshot case as a
-- case_screenshots row. All or nothing: any problem raises and records nothing.
-- Safe to call repeatedly (already recorded files are skipped).
create function public.client_finalize_screenshots(p_case_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
  v_bad text;
  v_dups text;
  v_gaps text;
  v_max int;
  v_n int;
  v_added int;
begin
  if v_case.workflow_state <> 'DRAFT' then
    perform private.fail('INVALID_STATE', 'only draft cases can take screenshots');
  end if;
  if v_case.conversation_source <> 'SCREENSHOTS' then
    perform private.fail('VALIDATION', 'this case uses pasted text');
  end if;
  select count(*) into v_n from private.screenshot_objects(v_case.business_id, v_case.id);
  if v_n = 0 then
    perform private.fail('VALIDATION', 'no screenshots uploaded');
  end if;

  select string_agg(coalesce(f.pos::text, '?'), ',' order by f.pos) into v_bad
  from private.screenshot_objects(v_case.business_id, v_case.id) f
  where f.pos is null or f.owner_id is distinct from (select auth.uid())::text
     or f.size is null or f.size < 1 or f.size > 5242880
     or f.mimetype is distinct from case f.ext when 'png' then 'image/png' when 'jpg' then 'image/jpeg' end;
  if v_bad is not null then
    perform private.fail('VALIDATION', 'screenshot failed checks at positions ' || v_bad);
  end if;

  select string_agg(d.pos::text, ',' order by d.pos) into v_dups
  from (select f.pos from private.screenshot_objects(v_case.business_id, v_case.id) f group by f.pos having count(*) > 1) d;
  if v_dups is not null then
    perform private.fail('VALIDATION', 'conflicting screenshots at positions ' || v_dups);
  end if;

  select max(f.pos) into v_max from private.screenshot_objects(v_case.business_id, v_case.id) f;
  select string_agg(g::text, ',' order by g) into v_gaps
  from generate_series(1, v_max) g
  where not exists (select 1 from private.screenshot_objects(v_case.business_id, v_case.id) f where f.pos = g);
  if v_gaps is not null then
    perform private.fail('VALIDATION', 'missing screenshots at positions ' || v_gaps);
  end if;

  if exists (select 1 from public.case_screenshots c
             join private.screenshot_objects(v_case.business_id, v_case.id) f on f.pos = c.position
             where c.case_id = v_case.id and c.storage_path <> f.name) then
    perform private.fail('VALIDATION', 'conflicting screenshots at recorded positions');
  end if;

  insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
  select v_case.id, v_case.business_id, f.pos, f.name, f.mimetype, f.size, f.sha256, (select auth.uid())
  from private.screenshot_objects(v_case.business_id, v_case.id) f
  where not exists (select 1 from public.case_screenshots c where c.case_id = v_case.id and c.position = f.pos);
  get diagnostics v_added = row_count;
  if v_added > 0 then
    perform private.audit('SCREENSHOTS_REGISTERED', v_case.id, v_case.business_id, 'CLIENT', null,
      jsonb_build_object('added', v_added, 'total', v_n));
  end if;
  return jsonb_build_object('registered', v_n, 'added', v_added);
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on function private.screenshot_objects(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.screenshot_upload_allowed(text) from public, anon, authenticated, service_role;
grant execute on function private.screenshot_upload_allowed(text) to authenticated;
revoke all on function public.client_screenshot_status(uuid) from public, anon, authenticated, service_role;
revoke all on function public.client_finalize_screenshots(uuid) from public, anon, authenticated, service_role;
grant execute on function public.client_screenshot_status(uuid), public.client_finalize_screenshots(uuid) to authenticated;
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261012120000_stage2a4c_screenshots.sql <<<<<<<<<<<<<<<<<<<<

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

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-4c', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261012120000_stage2a4c_screenshots.sql', 'sha256', '8e72852bfa92720198a0310eb977aca93b0a6b8c2a060da4adeeb870c2793336'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

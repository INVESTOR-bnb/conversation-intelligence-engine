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
    if has_table_privilege(current_user, 'storage.buckets', 'SELECT') then  -- (no short-circuit in PL/pgSQL AND)
      if exists (select 1 from storage.buckets where id = 'case-screenshots' and public) then
        v_problems := array_append(v_problems, 'bucket case-screenshots exists and is PUBLIC'::text);
      end if;
    end if;
  end if;
  -- The security-definer helpers read storage.objects (owned by Supabase's storage role);
  -- they only see every row if their owner (the deploying role) bypasses RLS.
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    v_problems := array_append(v_problems, format('role %s cannot bypass RLS, so the helpers could not see stored files', current_user));
  end if;
  -- The deploying role will own the helpers; they read storage.objects with its privileges.
  if to_regclass('storage.objects') is not null and not has_table_privilege(current_user, 'storage.objects', 'SELECT') then
    v_problems := array_append(v_problems, format('role %s lacks SELECT on storage.objects (the helpers need it)', current_user));
  end if;
  if to_regclass('storage.buckets') is not null and not has_table_privilege(current_user, 'storage.buckets', 'SELECT, INSERT, UPDATE') then
    v_problems := array_append(v_problems, format('role %s lacks SELECT/INSERT/UPDATE on storage.buckets (needed to create the bucket)', current_user));
  end if;

  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Preflight passed: Stage 2A-4b found, Storage present, no existing storage policies; applying Stage 2A-4c.';
end
$preflight$;

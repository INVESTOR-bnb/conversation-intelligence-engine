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

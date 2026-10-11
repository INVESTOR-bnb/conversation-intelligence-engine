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

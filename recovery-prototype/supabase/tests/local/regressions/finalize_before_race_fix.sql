-- REGRESSION FIXTURE (local tests only): client_finalize_screenshots exactly as committed in
-- d10e27c, before the race-condition fix. Used to prove the concurrency test detects the defect.
-- Never deploy.
create or replace function public.client_finalize_screenshots(p_case_id uuid) returns jsonb
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

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem
-- rolls everything back.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_f text;
  v_m jsonb;
  v_fsa regprocedure := 'public.founder_start_analysis(uuid)'::regprocedure;
  v_ica regprocedure := 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure;
begin
  foreach v_f in array array['private.evidence_manifest(uuid, integer)', 'private.tg_evidence_changed()', 'private.preserve_detected_restrictions(uuid, jsonb, integer)'] loop
    if to_regprocedure(v_f) is null then
      v_problems := array_append(v_problems, v_f || ' is missing');
    elsif not (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = to_regprocedure(v_f))
       or has_function_privilege('anon', to_regprocedure(v_f), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE')
       or has_function_privilege('service_role', to_regprocedure(v_f), 'EXECUTE') then
      v_problems := array_append(v_problems, v_f || ' is callable by an API role or does not pin search_path');
    end if;
  end loop;
  if (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'O' and t.tgfoid = 'private.tg_evidence_changed()'::regprocedure
        and ((t.tgname = 'rre_case_screenshots_evidence_update' and t.tgrelid = 'public.case_screenshots'::regclass and t.tgtype = 17)
          or (t.tgname = 'rre_case_screenshots_evidence_delete' and t.tgrelid = 'public.case_screenshots'::regclass and t.tgtype = 9)
          or (t.tgname = 'rre_case_messages_evidence_update' and t.tgrelid = 'public.case_messages'::regclass and t.tgtype = 17)
          or (t.tgname = 'rre_case_messages_evidence_delete' and t.tgrelid = 'public.case_messages'::regclass and t.tgtype = 9))) <> 4 then
    v_problems := array_append(v_problems, 'the four evidence triggers are not exactly as reviewed (AFTER UPDATE / AFTER DELETE, each row, enabled)'::text);
  end if;
  if (select prosrc from pg_proc where oid = v_fsa) not like '%private.evidence_manifest(%'
     or (select prosrc from pg_proc where oid = v_fsa) not like '%INSUFFICIENT_EVIDENCE%'
     or not has_function_privilege('authenticated', v_fsa, 'EXECUTE') or has_function_privilege('anon', v_fsa, 'EXECUTE') then
    v_problems := array_append(v_problems, 'founder_start_analysis does not use manifest v2 / the evidence check, or its privileges changed'::text);
  end if;
  if (select prosrc from pg_proc where oid = v_ica) not like '%private.analysis_output_problems(%'
     or (select prosrc from pg_proc where oid = v_ica) not like '%private.preserve_detected_restrictions(%'
     or not has_function_privilege('service_role', v_ica, 'EXECUTE') or has_function_privilege('authenticated', v_ica, 'EXECUTE') then
    v_problems := array_append(v_problems, 'internal_complete_analysis does not enforce the contract and preserve restrictions, or its privileges changed'::text);
  end if;
  v_m := private.evidence_manifest(gen_random_uuid(), 1);
  if v_m ->> 'manifest_version' is distinct from '2' or jsonb_array_length(v_m -> 'screenshots') <> 0 or not v_m ? 'excluded_screenshots' then
    v_problems := array_append(v_problems, 'the evidence manifest does not behave as reviewed'::text);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
             and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%')) then
    v_problems := array_append(v_problems, 'analyses or contact_restrictions are no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: evidence integrity installed; contract and founder-only access unchanged.';
end
$postcheck$;

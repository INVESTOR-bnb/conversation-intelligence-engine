-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem
-- rolls everything back. Changes no data: the behavioural check judges an
-- in-memory synthetic analysis row that is never stored.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_f regprocedure := 'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'::regprocedure;
  v_ica regprocedure := 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure;
  v_body text := (select prosrc from pg_proc where oid = v_f);
  v_out jsonb := '{"contract_version": "rre-analysis/1",
    "evidence_assessment": {"sufficiency": "SUFFICIENT", "summary": "Synthetic self-check.", "missing_evidence": []},
    "observations": [], "hypotheses": [], "unknowns": [],
    "recommendation": {"pursue": "PURSUE", "strategy": "Synthetic.", "psychological_rationale": "Synthetic.", "based_on_hypotheses": [],
                       "next_action": {"type": "SEND_MESSAGE", "text": "Synthetic pitch."}},
    "contact_restrictions": [], "reasons_not_to_pursue": []}';
  v_active text;
  v_dismissed text;
  v_missing text;
begin
  if not coalesce((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = v_f), false)
     or has_function_privilege('anon', v_f, 'EXECUTE') or has_function_privilege('authenticated', v_f, 'EXECUTE')
     or has_function_privilege('service_role', v_f, 'EXECUTE') then
    v_problems := array_append(v_problems, 'the contract is callable by an API role or does not pin search_path'::text);
  end if;
  if v_body not like '%Stage 2A-5d-1%' or v_body not like '%p_analysis.evidence_manifest -> ''restrictions''%'
     or v_body not like '%private.has_active_restriction(p_analysis.case_id)%' then
    v_problems := array_append(v_problems, 'the contract does not read the restrictions in the evidence snapshot'::text);
  end if;
  if (select prosrc from pg_proc where oid = v_ica) not like '%private.analysis_output_problems(%'
     or (select prosrc from pg_proc where oid = v_ica) not like '%private.preserve_detected_restrictions(%'
     or not has_function_privilege('service_role', v_ica, 'EXECUTE') or has_function_privilege('authenticated', v_ica, 'EXECUTE') then
    v_problems := array_append(v_problems, 'internal_complete_analysis no longer enforces the contract or preserves restrictions, or its privileges changed'::text);
  end if;
  -- Behaviour: the same contact-recommending output on synthetic in-memory snapshots.
  v_active := array_to_string(private.analysis_output_problems(jsonb_populate_record(null::public.analyses, jsonb_build_object(
      'id', gen_random_uuid(), 'case_id', gen_random_uuid(), 'evidence_manifest',
      '{"manifest_version": 2, "messages": [], "screenshots": [], "restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "EXPLICIT_OPT_OUT", "source": "CLIENT", "status": "ACTIVE"}]}'::jsonb)),
    'COMPLETE', v_out, 'GREEN', 'Synthetic pitch.', '[]'), ' | ');
  v_dismissed := array_to_string(private.analysis_output_problems(jsonb_populate_record(null::public.analyses, jsonb_build_object(
      'id', gen_random_uuid(), 'case_id', gen_random_uuid(), 'evidence_manifest',
      '{"manifest_version": 2, "messages": [], "screenshots": [], "restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "EXPLICIT_OPT_OUT", "source": "AI_DETECTED", "status": "DISMISSED_AS_MISREAD"}]}'::jsonb)),
    'COMPLETE', v_out, 'GREEN', 'Synthetic pitch.', '[]'), ' | ');
  v_missing := array_to_string(private.analysis_output_problems(jsonb_populate_record(null::public.analyses, jsonb_build_object(
      'id', gen_random_uuid(), 'case_id', gen_random_uuid(), 'evidence_manifest', '{"manifest_version": 2, "messages": [], "screenshots": []}'::jsonb)),
    'COMPLETE', v_out, 'GREEN', 'Synthetic pitch.', '[]'), ' | ');
  if strpos(v_active, 'an active contact restriction in the evidence snapshot requires DO_NOT_PURSUE') = 0
     or strpos(v_active, 'requires classification RED') = 0 or strpos(v_active, 'allows no proposed message') = 0
     or strpos(v_dismissed, 'active contact restriction') > 0
     or strpos(v_missing, 'the evidence snapshot has no restriction list') = 0 then
    v_problems := array_append(v_problems, 'the restriction rule does not behave as reviewed'::text);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
             and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%')) then
    v_problems := array_append(v_problems, 'analyses or contact_restrictions are no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: active restrictions in the evidence snapshot now forbid contact recommendations; founder-only access unchanged.';
end
$postcheck$;

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem
-- rolls everything back. Changes no data: the behavioural checks judge
-- in-memory synthetic analysis rows that are never stored.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_f regprocedure := 'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'::regprocedure;
  v_ica regprocedure := 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure;
  v_body text := (select prosrc from pg_proc where oid = v_f);
  v_row public.analyses := jsonb_populate_record(null::public.analyses, jsonb_build_object('id', gen_random_uuid(), 'case_id', gen_random_uuid(),
    'evidence_manifest', '{"manifest_version": 2, "messages": [], "screenshots": [], "restrictions": []}'::jsonb));
  v_restricted public.analyses := jsonb_populate_record(null::public.analyses, jsonb_build_object('id', gen_random_uuid(), 'case_id', gen_random_uuid(),
    'evidence_manifest', '{"manifest_version": 2, "messages": [], "screenshots": [], "restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "EXPLICIT_OPT_OUT", "source": "CLIENT", "status": "ACTIVE"}]}'::jsonb));
  v_v1 jsonb := '{"contract_version": "rre-analysis/1",
    "evidence_assessment": {"sufficiency": "SUFFICIENT", "summary": "Synthetic self-check.", "missing_evidence": []},
    "observations": [], "hypotheses": [], "unknowns": [],
    "recommendation": {"pursue": "PURSUE", "strategy": "Synthetic.", "psychological_rationale": "Synthetic.", "based_on_hypotheses": [],
                       "next_action": {"type": "SEND_MESSAGE", "text": "Synthetic pitch."}},
    "contact_restrictions": [], "reasons_not_to_pursue": []}';
  v_fab jsonb;
  v_rej jsonb;
  v_t text;
begin
  if not coalesce((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = v_f), false)
     or has_function_privilege('anon', v_f, 'EXECUTE') or has_function_privilege('authenticated', v_f, 'EXECUTE')
     or has_function_privilege('service_role', v_f, 'EXECUTE') then
    v_problems := array_append(v_problems, 'the contract is callable by an API role or does not pin search_path'::text);
  end if;
  if v_body not like '%Stage 2A-5d-2%' or v_body not like '%Stage 2A-5d-1%'
     or v_body not like '%private.ac_refs_problems(p_analysis, v_r.c -> ''evidence''%' then
    v_problems := array_append(v_problems, 'the contract does not validate the adversarial review or lost the restriction rule'::text);
  end if;
  if (select prosrc from pg_proc where oid = v_ica) not like '%private.analysis_output_problems(%'
     or (select prosrc from pg_proc where oid = v_ica) not like '%private.preserve_detected_restrictions(%'
     or not has_function_privilege('service_role', v_ica, 'EXECUTE') or has_function_privilege('authenticated', v_ica, 'EXECUTE') then
    v_problems := array_append(v_problems, 'internal_complete_analysis no longer enforces the contract or preserves restrictions, or its privileges changed'::text);
  end if;
  -- Behaviour on synthetic in-memory rows.
  v_fab := v_v1 || jsonb_build_object('contract_version', 'rre-analysis/2', 'adversarial_review', jsonb_build_object(
    'challenges', jsonb_build_array(jsonb_build_object('id', 'C1', 'target', 'RECOMMENDATION', 'severity', 'LOW', 'challenge', 'Synthetic.',
      'evidence', jsonb_build_array(jsonb_build_object('type', 'MESSAGE', 'message_id', gen_random_uuid(), 'quote', 'fabricated')))),
    'verdict', 'UPHOLD_WITH_CONCERNS', 'verdict_rationale', 'Synthetic.'));
  v_rej := jsonb_set(jsonb_set(v_fab, '{adversarial_review,verdict}', '"REJECT_RECOMMENDATION"'),
                     '{adversarial_review,challenges}', '[{"id": "C1", "target": "RECOMMENDATION", "severity": "HIGH", "challenge": "Synthetic.", "evidence": []}]');
  v_t := array_to_string(private.analysis_output_problems(v_row, 'COMPLETE', v_fab, 'GREEN', 'Synthetic pitch.', '[]'), ' | ');
  if strpos(v_t, 'adversarial_review.challenges[0].evidence[0]: message is not part of this analysis''s evidence') = 0 then
    v_problems := array_append(v_problems, 'a fabricated review citation is not rejected'::text);
  end if;
  v_t := array_to_string(private.analysis_output_problems(v_row, 'COMPLETE', v_rej, 'GREEN', 'Synthetic pitch.', '[]'), ' | ');
  if strpos(v_t, 'cannot remain PURSUE') = 0 or strpos(v_t, 'cannot carry a message or question') = 0 or strpos(v_t, 'allows no proposed message') = 0 then
    v_problems := array_append(v_problems, 'a rejecting review does not prevent a contact message'::text);
  end if;
  v_t := array_to_string(private.analysis_output_problems(v_row, 'COMPLETE', jsonb_set(v_v1, '{contract_version}', '"rre-analysis/2"'), 'GREEN', 'Synthetic pitch.', '[]'), ' | ');
  if strpos(v_t, 'missing adversarial_review') = 0 then
    v_problems := array_append(v_problems, 'rre-analysis/2 without a review is not rejected'::text);
  end if;
  v_t := array_to_string(private.analysis_output_problems(v_row, 'COMPLETE', v_v1, 'GREEN', 'Synthetic pitch.', '[]'), ' | ');
  if strpos(v_t, 'contract_version') > 0 or strpos(v_t, 'adversarial') > 0 then
    v_problems := array_append(v_problems, 'rre-analysis/1 is no longer accepted as before'::text);
  end if;
  v_t := array_to_string(private.analysis_output_problems(v_restricted, 'COMPLETE', jsonb_set(v_fab, '{adversarial_review}',
           '{"challenges": [], "verdict": "UPHOLD", "verdict_rationale": "Synthetic."}'), 'GREEN', 'Synthetic pitch.', '[]'), ' | ');
  if strpos(v_t, 'an active contact restriction in the evidence snapshot requires DO_NOT_PURSUE') = 0 then
    v_problems := array_append(v_problems, 'the Stage 2A-5d-1 restriction rule does not hold for rre-analysis/2'::text);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
             and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%'))
     or exists (select 1 from pg_views where schemaname not in ('pg_catalog', 'information_schema') and definition ~* '\manalyses\M') then
    v_problems := array_append(v_problems, 'analyses or contact_restrictions are no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: rre-analysis/2 adversarial review enforced; rre-analysis/1 and the restriction rule unchanged; founder-only access unchanged.';
end
$postcheck$;

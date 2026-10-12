-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5a ROLLBACK (single transaction)
-- Removes the analysis output contract: restores internal_complete_analysis
-- exactly as Stage 2A-1 defined it and drops the seven contract functions.
-- Changes no data: every analysis, restriction and audit entry is kept.
-- WARNING: afterwards any output is stored unchecked again.
-- Safe to re-run: if 2A-5a is not applied it refuses and changes nothing.
-- Afterwards run stage2a1_verify.sql.
-- ===================================================================

begin;

do $preflight$
begin
  if to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)') is null then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-5a is not applied.';
  end if;
  if to_regprocedure('private.evidence_manifest(uuid, integer)') is not null then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-5b (evidence integrity) is applied; run stage2a5b_rollback.sql first.';
  end if;
  perform set_config('rre.analyses_before', (select count(*) from public.analyses)::text, true);
  perform set_config('rre.audit_before', (select count(*) from public.audit_log)::text, true);
  perform set_config('rre.restrictions_before', (select count(*) from public.contact_restrictions)::text, true);
end
$preflight$;

-- internal_complete_analysis exactly as in migration 20261009120200_stage2a1_functions.sql
-- (CREATE OR REPLACE keeps its owner and privileges: service_role only).
create or replace function public.internal_complete_analysis(
  p_analysis_id uuid,
  p_status public.analysis_status,
  p_model text default null,
  p_prompt_version text default null,
  p_output jsonb default null,
  p_ai_classification public.classification default null,
  p_ai_proposed_message text default null,
  p_detected_restrictions jsonb default '[]'::jsonb,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_estimated_cost_usd numeric default null,
  p_error text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_analysis public.analyses;
  v_case public.cases;
  v_restrictions jsonb := coalesce(p_detected_restrictions, '[]'::jsonb);
  v_message text;
  v_item jsonb;
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
  select * into v_analysis from public.analyses where id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found');
  end if;
  if v_analysis.status <> 'PENDING' then
    perform private.fail('INVALID_STATE', 'analysis already completed');
  end if;
  if p_status = 'PENDING' then
    perform private.fail('VALIDATION', 'a completed analysis cannot be PENDING');
  end if;
  if jsonb_typeof(v_restrictions) <> 'array' then
    perform private.fail('VALIDATION', 'detected restrictions must be an array');
  end if;
  select * into v_case from public.cases where id = v_analysis.case_id for update;

  if p_status = 'ERROR' or v_case.evidence_version <> v_analysis.evidence_version or v_case.workflow_state <> 'ANALYZING' then
    update public.analyses set status = 'ERROR',
      error = left(coalesce(case when p_status = 'ERROR' then p_error end, 'STALE: evidence changed during analysis'), 2000),
      model = p_model, prompt_version = p_prompt_version, input_tokens = p_input_tokens,
      output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
    where id = v_analysis.id;
    update public.cases set workflow_state = v_analysis.prior_state
    where id = v_case.id and workflow_state = 'ANALYZING';
    perform private.audit('ANALYSIS_FAILED', v_case.id, v_case.business_id, 'SERVICE', null,
      jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version));
    return;
  end if;

  -- Invariant: no proposed message for RED or when any restriction is detected.
  v_message := case when p_ai_classification = 'RED' or jsonb_array_length(v_restrictions) > 0 then null
                    else nullif(btrim(coalesce(p_ai_proposed_message, '')), '') end;

  update public.analyses set status = p_status, model = p_model, prompt_version = p_prompt_version, output = p_output,
    ai_classification = p_ai_classification, ai_proposed_message = v_message, input_tokens = p_input_tokens,
    output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
  where id = v_analysis.id;

  for v_item in select * from jsonb_array_elements(v_restrictions) loop
    insert into public.contact_restrictions (case_id, business_id, kind, source, note, evidence)
    values (v_case.id, v_case.business_id, (v_item ->> 'kind')::public.restriction_kind, 'AI_DETECTED',
            left(v_item ->> 'note', 1000), v_item -> 'evidence');
  end loop;

  update public.cases set workflow_state = 'AWAITING_ADMIN_REVIEW' where id = v_case.id;
  perform private.audit('ANALYSIS_COMPLETED', v_case.id, v_case.business_id, 'SERVICE', null,
    jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version, 'status', p_status,
                       'detected_restrictions', jsonb_array_length(v_restrictions)));
end $$;

drop function private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb);
drop function private.ac_refs_problems(public.analyses, jsonb, text, integer);
drop function private.ac_ref_problems(public.analyses, jsonb, text);
drop function private.ac_arr(jsonb);
drop function private.ac_norm(text);
drop function private.ac_extra_keys(jsonb, text[]);
drop function private.ac_text(jsonb, integer);

do $postcheck$
begin
  if to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)') is not null
     or (select prosrc from pg_proc where oid = 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure) like '%analysis_output_problems%' then
    raise exception 'ROLLBACK ABORTED (rolled back): the contract remains';
  end if;
  if not has_function_privilege('service_role', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE') then
    raise exception 'ROLLBACK ABORTED (rolled back): internal_complete_analysis privileges changed';
  end if;
  if (select count(*) from public.analyses)::text <> current_setting('rre.analyses_before')
     or (select count(*) from public.audit_log)::text <> current_setting('rre.audit_before')
     or (select count(*) from public.contact_restrictions)::text <> current_setting('rre.restrictions_before') then
    raise exception 'ROLLBACK ABORTED (rolled back): analyses, restrictions or audit history would change';
  end if;
  raise notice 'Rollback self-check passed: contract removed; data unchanged.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_ROLLED_BACK', jsonb_build_object('stage', '2A-5a', 'removed', 'analysis output contract rre-analysis/1'));

commit;
-- END OF ROLLBACK FILE — if this line is missing, the copy is incomplete: do not run.

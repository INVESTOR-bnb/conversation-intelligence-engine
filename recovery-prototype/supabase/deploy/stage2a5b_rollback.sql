-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5b ROLLBACK (single transaction)
-- Removes evidence integrity: drops the four evidence triggers and the three
-- functions, and restores founder_start_analysis (as Stage 2A-1 defined it)
-- and internal_complete_analysis (as Stage 2A-5a defined it). The 2A-5a
-- contract stays. Changes no data: every analysis, restriction (including
-- those preserved from rejected analyses) and audit entry is kept.
-- WARNING: afterwards deleted screenshots count as evidence again, evidence
-- edits no longer make analyses stale, and restrictions from rejected
-- analyses are lost again.
-- Safe to re-run: if 2A-5b is not applied it refuses and changes nothing.
-- Afterwards run stage2a5a_verify.sql and stage2a1_verify.sql.
-- ===================================================================

begin;

do $preflight$
begin
  if to_regprocedure('private.evidence_manifest(uuid, integer)') is null then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-5b is not applied.';
  end if;
  perform set_config('rre.counts_before', (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.contact_restrictions),
    (select count(*) from public.audit_log), (select coalesce(sum(evidence_version), 0) from public.cases))), true);
end
$preflight$;

drop trigger rre_case_screenshots_evidence_update on public.case_screenshots;
drop trigger rre_case_screenshots_evidence_delete on public.case_screenshots;
drop trigger rre_case_messages_evidence_update on public.case_messages;
drop trigger rre_case_messages_evidence_delete on public.case_messages;

-- founder_start_analysis exactly as in migration 20261009120200_stage2a1_functions.sql
create or replace function public.founder_start_analysis(p_case_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_version integer;
  v_manifest jsonb;
  v_id uuid;
begin
  if v_case.workflow_state not in ('SUBMITTED', 'PROSPECT_REPLIED', 'REANALYZING') then
    perform private.fail('INVALID_STATE', 'case is not waiting for analysis');
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.analyses where case_id = v_case.id;
  v_manifest := jsonb_build_object(
    'evidence_version', v_case.evidence_version,
    'screenshots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'sha256', s.sha256)
                                              order by s.position)
                             from public.case_screenshots s where s.case_id = v_case.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'created_at', m.created_at)
                                           order by m.created_at, m.id)
                          from public.case_messages m where m.case_id = v_case.id), '[]'::jsonb),
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'source', r.source, 'status', r.status)
                                               order by r.created_at)
                              from public.contact_restrictions r where r.case_id = v_case.id), '[]'::jsonb));

  insert into public.analyses (case_id, business_id, version, evidence_version, evidence_manifest, prior_state, requested_by)
  values (v_case.id, v_case.business_id, v_version, v_case.evidence_version, v_manifest, v_case.workflow_state, (select auth.uid()))
  returning id into v_id;
  update public.cases set workflow_state = 'ANALYZING' where id = v_case.id;
  perform private.audit('ANALYSIS_STARTED', v_case.id, v_case.business_id, 'FOUNDER', null,
    jsonb_build_object('analysis_id', v_id, 'version', v_version, 'evidence_version', v_case.evidence_version));
  return v_id;
end $$;

-- internal_complete_analysis exactly as in migration 20261014120000_stage2a5a_analysis_contract.sql
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
  v_problems text[];
  v_failure text;
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
  if jsonb_typeof(v_restrictions) is distinct from 'array' then
    perform private.fail('VALIDATION', 'detected restrictions must be an array');
  end if;
  select * into v_case from public.cases where id = v_analysis.case_id for update;

  if p_status = 'ERROR' then
    v_failure := coalesce(p_error, 'analysis failed');
  elsif v_case.evidence_version <> v_analysis.evidence_version or v_case.workflow_state <> 'ANALYZING' then
    v_failure := 'STALE: evidence changed during analysis';
  else
    v_problems := private.analysis_output_problems(v_analysis, p_status, p_output, p_ai_classification,
                                                   p_ai_proposed_message, v_restrictions);
    if cardinality(v_problems) > 0 then
      v_failure := 'REJECTED by analysis contract rre-analysis/1: ' || array_to_string(v_problems[1:10], '; ')
                   || case when cardinality(v_problems) > 10 then format(' (+%s more)', cardinality(v_problems) - 10) else '' end;
    end if;
  end if;

  if v_failure is not null then
    -- Nothing from a failed, stale or rejected analysis is kept as findings.
    update public.analyses set status = 'ERROR', error = left(v_failure, 2000),
      model = p_model, prompt_version = p_prompt_version, input_tokens = p_input_tokens,
      output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
    where id = v_analysis.id;
    update public.cases set workflow_state = v_analysis.prior_state
    where id = v_case.id and workflow_state = 'ANALYZING';
    perform private.audit(case when v_problems is not null and cardinality(v_problems) > 0 then 'ANALYSIS_REJECTED' else 'ANALYSIS_FAILED' end,
      v_case.id, v_case.business_id, 'SERVICE', null,
      jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version)
      || case when cardinality(v_problems) > 0 then jsonb_build_object('problems', cardinality(v_problems)) else '{}'::jsonb end);
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

drop function private.preserve_detected_restrictions(uuid, jsonb, integer);
drop function private.tg_evidence_changed();
drop function private.evidence_manifest(uuid, integer);

do $postcheck$
begin
  if to_regprocedure('private.evidence_manifest(uuid, integer)') is not null
     or exists (select 1 from pg_trigger where tgname like 'rre_case_%evidence%')
     or (select prosrc from pg_proc where oid = 'public.founder_start_analysis(uuid)'::regprocedure) like '%private.evidence_manifest(%'
     or (select prosrc from pg_proc where oid = 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure)
        like '%preserve_detected_restrictions%' then
    raise exception 'ROLLBACK ABORTED (rolled back): Stage 2A-5b objects remain';
  end if;
  if (select prosrc from pg_proc where oid = 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure)
     not like '%private.analysis_output_problems(%' then
    raise exception 'ROLLBACK ABORTED (rolled back): the 2A-5a contract would be lost';
  end if;
  if not has_function_privilege('authenticated', 'public.founder_start_analysis(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE') then
    raise exception 'ROLLBACK ABORTED (rolled back): function privileges changed';
  end if;
  if concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.contact_restrictions),
       (select count(*) from public.audit_log), (select coalesce(sum(evidence_version), 0) from public.cases)) <> current_setting('rre.counts_before') then
    raise exception 'ROLLBACK ABORTED (rolled back): analyses, restrictions, audit history or evidence versions would change';
  end if;
  raise notice 'Rollback self-check passed: evidence integrity removed; contract kept; data unchanged.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_ROLLED_BACK', jsonb_build_object('stage', '2A-5b', 'removed', 'evidence integrity (manifest v2, staleness triggers, restriction preservation)'));

commit;
-- END OF ROLLBACK FILE — if this line is missing, the copy is incomplete: do not run.

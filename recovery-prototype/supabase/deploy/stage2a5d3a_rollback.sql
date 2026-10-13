-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5d-3a ROLLBACK (single transaction)
-- Removes the spending controls: disables spending, drops the eight spending
-- functions, and restores internal_complete_analysis (exactly as Stage 2A-5b)
-- and founder_abandon_analysis (exactly as Stage 2A-1). CREATE OR REPLACE keeps
-- their owners and privileges.
-- KEEPS the three private spending tables and every record in them (no API
-- role can reach them); a later re-deployment re-uses them.
-- WARNING: afterwards nothing reserves, limits or settles AI spending. Do not
-- run any real AI provider while rolled back.
-- Safe to re-run: if 2A-5d-3a is not applied it refuses and changes nothing.
-- Afterwards run stage2a5d2_verify.sql and the earlier verification files.
-- ===================================================================

begin;

do $preflight$
begin
  if to_regprocedure('public.internal_reserve_ai_spend(uuid, text, text)') is null then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-5d-3a is not applied.';
  end if;
  if to_regprocedure('public.internal_ai_reservation_terms(uuid)') is not null then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-6a (reservation terms) is applied; run stage2a6a_rollback.sql first.';
  end if;
  perform set_config('rre.counts_before', (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.contact_restrictions),
    (select count(*) from public.audit_log), (select coalesce(sum(evidence_version), 0) from public.cases), (select count(*) from private.ai_spend_ledger))), true);
end
$preflight$;

-- Spending off first (the record stays).
update private.ai_spend_config set enabled = false, updated_at = now() where id and enabled;

-- internal_complete_analysis exactly as in migration 20261015120000_stage2a5b_evidence_integrity.sql
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
  v_kept integer;
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
    -- Stage 2A-5b: a detected opt-out or contact restriction is a safety signal, not a
    -- finding. It is recorded even when the analysis itself is rejected, failed or stale.
    v_kept := private.preserve_detected_restrictions(v_case.id, v_restrictions, v_analysis.version);
    perform private.audit(case when v_problems is not null and cardinality(v_problems) > 0 then 'ANALYSIS_REJECTED' else 'ANALYSIS_FAILED' end,
      v_case.id, v_case.business_id, 'SERVICE', null,
      jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version, 'restrictions_preserved', v_kept)
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

-- founder_abandon_analysis exactly as in migration 20261009120200_stage2a1_functions.sql
create or replace function public.founder_abandon_analysis(p_analysis_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_analysis public.analyses;
begin
  perform private.require_founder();
  select * into v_analysis from public.analyses where id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found');
  end if;
  if v_analysis.status <> 'PENDING' then
    perform private.fail('INVALID_STATE', 'analysis is not in progress');
  end if;
  update public.analyses set status = 'ERROR', error = 'Abandoned by founder', completed_at = now() where id = v_analysis.id;
  update public.cases set workflow_state = v_analysis.prior_state where id = v_analysis.case_id and workflow_state = 'ANALYZING';
  perform private.audit('ANALYSIS_ABANDONED', v_analysis.case_id, v_analysis.business_id, 'FOUNDER', null,
    jsonb_build_object('analysis_id', v_analysis.id));
end $$;

drop function public.founder_ai_spend_summary();
drop function public.internal_reserve_ai_spend(uuid, text, text);
drop function public.internal_ai_dispatch(uuid, text);
drop function public.internal_ai_report_usage(uuid, text, integer, integer);
drop function private.ai_reconcile(uuid, numeric, text);
drop function private.ai_settle(uuid);
drop function private.ai_committed_usd();
drop function private.ai_estimate_usd(bigint, integer, integer, private.ai_model_prices, private.ai_model_prices, private.ai_spend_config);

do $postcheck$
declare
  v_ica regprocedure := 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure;
begin
  if to_regprocedure('public.internal_reserve_ai_spend(uuid, text, text)') is not null or to_regprocedure('private.ai_settle(uuid)') is not null
     or to_regprocedure('public.founder_ai_spend_summary()') is not null or to_regprocedure('public.internal_ai_dispatch(uuid, text)') is not null then
    raise exception 'ROLLBACK ABORTED (rolled back): Stage 2A-5d-3a functions remain';
  end if;
  if md5((select prosrc from pg_proc where oid = v_ica)) <> '1639e2cc87c25ac16ba4f2a1c248a778'
     or md5((select prosrc from pg_proc where oid = 'public.founder_abandon_analysis(uuid)'::regprocedure)) <> 'c3416ac9416237615b761d5fd921d513' then
    raise exception 'ROLLBACK ABORTED (rolled back): the restored functions are not the Stage 2A-5b / 2A-1 versions';
  end if;
  if not has_function_privilege('service_role', v_ica, 'EXECUTE') or has_function_privilege('authenticated', v_ica, 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.founder_abandon_analysis(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.founder_abandon_analysis(uuid)', 'EXECUTE') then
    raise exception 'ROLLBACK ABORTED (rolled back): function privileges changed';
  end if;
  if (select enabled from private.ai_spend_config where id) then
    raise exception 'ROLLBACK ABORTED (rolled back): spending is still enabled';
  end if;
  if concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.contact_restrictions),
       (select count(*) from public.audit_log), (select coalesce(sum(evidence_version), 0) from public.cases), (select count(*) from private.ai_spend_ledger))
     <> current_setting('rre.counts_before') then
    raise exception 'ROLLBACK ABORTED (rolled back): analyses, restrictions, audit history, evidence versions or spending records would change';
  end if;
  raise notice 'Rollback self-check passed: spending controls removed and disabled; records kept; functions restored.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_ROLLED_BACK', jsonb_build_object('stage', '2A-5d-3a', 'removed', 'AI spending controls (records kept, spending disabled)'));

commit;
-- END OF ROLLBACK FILE — if this line is missing, the copy is incomplete: do not run.

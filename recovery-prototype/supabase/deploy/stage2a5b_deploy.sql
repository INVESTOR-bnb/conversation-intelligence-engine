-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5b DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a5b.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-5a. Evidence integrity: analyses start only from usable
-- evidence (deleted screenshots excluded; refused when none remains), any
-- change to submitted evidence makes analyses stale, and detected contact
-- restrictions are kept even when an analysis is rejected. Three private
-- functions, four triggers, new bodies for founder_start_analysis and
-- internal_complete_analysis. Connects no AI. No data is changed.
-- All-or-nothing. Contains no credentials.
-- Refuses to run if 2A-5a is missing or 2A-5b is already applied.
-- Undo: deploy/stage2a5b_rollback.sql. Check: deploy/stage2a5b_verify.sql.
--
-- Source migration (sha256):
--   20261015120000_stage2a5b_evidence_integrity.sql  b1e3770f707f59a0cd87eddd4a3eaeda31e2118b3796bbb39aba92af53710afe
-- ===================================================================

begin;

-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-5a is applied
-- and 2A-5b is not yet applied.
-- ===================================================================
do $preflight$
begin
  if to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5a (analysis contract) is not applied.';
  end if;
  if to_regprocedure('private.evidence_manifest(uuid, integer)') is not null
     or exists (select 1 from pg_trigger where tgname in ('rre_case_screenshots_evidence_update', 'rre_case_messages_evidence_update')) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5b is already applied.';
  end if;
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): role % cannot bypass RLS, so the functions could not read the evidence', current_user;
  end if;
  raise notice 'Preflight passed: installing Stage 2A-5b evidence integrity.';
end
$preflight$;

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261015120000_stage2a5b_evidence_integrity.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-5b — evidence integrity for analyses. No AI is connected.
--
-- 1. Usable evidence: the evidence manifest an analysis starts from (v2) lists
--    only screenshots whose file is still stored; files deleted under retention
--    (case_screenshots.file_deleted_at) are listed separately as excluded and
--    can never be analysed or cited (the 2A-5a contract already refuses to cite
--    them). Messages carry a SHA-256 of their text.
-- 2. No usable evidence, no analysis: founder_start_analysis refuses
--    (INSUFFICIENT_EVIDENCE) and changes nothing when no message and no stored
--    screenshot remains.
-- 3. Staleness: any change to, or deletion of, a submitted case's evidence rows
--    (case_messages; case_screenshots incl. file_deleted_at, hash, path,
--    position) bumps cases.evidence_version. The existing checks then make an
--    analysis in progress fail as STALE and an analysis waiting for review
--    unapprovable (STALE_ANALYSIS) until it is re-run on the current evidence.
-- 4. Restrictions are never lost: when internal_complete_analysis rejects,
--    fails or finds an analysis stale, the contact restrictions it was given are
--    still recorded (AI_DETECTED, ACTIVE, audited), so known opt-outs keep
--    blocking contact. An unrecognised kind is recorded as OTHER.
--
-- The 2A-5a contract (rre-analysis/1) and founder-only access are unchanged.
-- Rollback: supabase/deploy/stage2a5b_rollback.sql.

-- ---------------------------------------------------------------- 1. evidence manifest v2
create function private.evidence_manifest(p_case_id uuid, p_evidence_version integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'manifest_version', 2,
    'evidence_version', p_evidence_version,
    'screenshots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'sha256', s.sha256) order by s.position)
                             from public.case_screenshots s where s.case_id = p_case_id and s.file_deleted_at is null), '[]'::jsonb),
    'excluded_screenshots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'sha256', s.sha256,
                                                                          'reason', 'FILE_DELETED', 'deleted_at', s.file_deleted_at) order by s.position)
                                      from public.case_screenshots s where s.case_id = p_case_id and s.file_deleted_at is not null), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'created_at', m.created_at,
                                                              'body_sha256', encode(sha256(convert_to(m.body, 'UTF8')), 'hex'))
                                           order by m.created_at, m.id)
                          from public.case_messages m where m.case_id = p_case_id), '[]'::jsonb),
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'source', r.source, 'status', r.status)
                                               order by r.created_at)
                              from public.contact_restrictions r where r.case_id = p_case_id), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------- 2. start only with usable evidence
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
  v_manifest := private.evidence_manifest(v_case.id, v_case.evidence_version);
  if jsonb_array_length(v_manifest -> 'messages') + jsonb_array_length(v_manifest -> 'screenshots') = 0 then
    perform private.fail('INSUFFICIENT_EVIDENCE',
      format('no usable evidence: no messages and no stored screenshots (%s deleted under retention)',
             jsonb_array_length(v_manifest -> 'excluded_screenshots')));
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.analyses where case_id = v_case.id;

  insert into public.analyses (case_id, business_id, version, evidence_version, evidence_manifest, prior_state, requested_by)
  values (v_case.id, v_case.business_id, v_version, v_case.evidence_version, v_manifest, v_case.workflow_state, (select auth.uid()))
  returning id into v_id;
  update public.cases set workflow_state = 'ANALYZING' where id = v_case.id;
  perform private.audit('ANALYSIS_STARTED', v_case.id, v_case.business_id, 'FOUNDER', null,
    jsonb_build_object('analysis_id', v_id, 'version', v_version, 'evidence_version', v_case.evidence_version, 'manifest_version', 2,
                       'excluded_screenshots', jsonb_array_length(v_manifest -> 'excluded_screenshots')));
  return v_id;
end $$;

-- ---------------------------------------------------------------- 3. evidence changes make analyses stale
create function private.tg_evidence_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cases uuid[];
begin
  v_cases := case when tg_op = 'UPDATE' then array[old.case_id, new.case_id] else array[old.case_id] end;
  -- Drafts are not analysed yet; their evidence is fixed at submission.
  update public.cases set evidence_version = evidence_version + 1
  where id = any (v_cases) and workflow_state <> 'DRAFT';
  return null;
end $$;

create trigger rre_case_screenshots_evidence_update after update on public.case_screenshots
  for each row
  when (old.file_deleted_at is distinct from new.file_deleted_at or old.sha256 is distinct from new.sha256
        or old.storage_path is distinct from new.storage_path or old.position is distinct from new.position
        or old.case_id is distinct from new.case_id)
  execute function private.tg_evidence_changed();
create trigger rre_case_screenshots_evidence_delete after delete on public.case_screenshots
  for each row execute function private.tg_evidence_changed();
create trigger rre_case_messages_evidence_update after update on public.case_messages
  for each row
  when (old.body is distinct from new.body or old.kind is distinct from new.kind or old.case_id is distinct from new.case_id)
  execute function private.tg_evidence_changed();
create trigger rre_case_messages_evidence_delete after delete on public.case_messages
  for each row execute function private.tg_evidence_changed();

-- ---------------------------------------------------------------- 4. never lose a detected restriction
-- Records each detected restriction (unless the same kind is already active from
-- AI detection) through private.add_restriction: ACTIVE, audited, evidence version
-- bumped. Returns how many were recorded.
create function private.preserve_detected_restrictions(p_case_id uuid, p_restrictions jsonb, p_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases;
  v_item jsonb;
  v_kind public.restriction_kind;
  v_given text;
  v_n integer := 0;
begin
  if jsonb_typeof(p_restrictions) is distinct from 'array' then
    return 0;
  end if;
  for v_item in select * from jsonb_array_elements(p_restrictions) loop
    v_given := case when jsonb_typeof(v_item) = 'object' then v_item ->> 'kind' end;
    v_kind := case when v_given in ('EXPLICIT_OPT_OUT', 'PROHIBITED_CONTACT', 'OTHER') then v_given::public.restriction_kind
                   else 'OTHER'::public.restriction_kind end;
    continue when exists (select 1 from public.contact_restrictions r
                          where r.case_id = p_case_id and r.kind = v_kind and r.source = 'AI_DETECTED' and r.status = 'ACTIVE');
    select * into v_case from public.cases where id = p_case_id;
    perform private.add_restriction(v_case, v_kind, 'AI_DETECTED',
      left(format('Detected by analysis v%s, which was not accepted. %s%s', p_version,
                  case when v_given is distinct from v_kind::text then format('Unrecognised kind "%s" recorded as OTHER. ', left(coalesce(v_given, '(none)'), 40)) else '' end,
                  coalesce(case when jsonb_typeof(v_item) = 'object' then v_item ->> 'note' end, '')), 1000),
      case when jsonb_typeof(v_item) = 'object' and jsonb_typeof(v_item -> 'evidence') in ('object', 'array')
                and octet_length((v_item -> 'evidence')::text) <= 10000 then v_item -> 'evidence' end,
      'SERVICE');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- internal_complete_analysis: the Stage 2A-5a version, plus restriction preservation on failure.
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


-- ---------------------------------------------------------------- privileges: internal only
revoke all on function private.evidence_manifest(uuid, integer), private.tg_evidence_changed(),
  private.preserve_detected_restrictions(uuid, jsonb, integer)
  from public, anon, authenticated, service_role;
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261015120000_stage2a5b_evidence_integrity.sql <<<<<<<<<<<<<<<<<<<<

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

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-5b', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261015120000_stage2a5b_evidence_integrity.sql', 'sha256', 'b1e3770f707f59a0cd87eddd4a3eaeda31e2118b3796bbb39aba92af53710afe'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

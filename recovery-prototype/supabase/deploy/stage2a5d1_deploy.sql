-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5d-1 DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a5d1.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-5b. Contract rule: an active contact restriction in an
-- analysis's evidence snapshot forbids any contact recommendation — only
-- DO_NOT_PURSUE, classification RED, STOP_CONTACT and no proposed message
-- are accepted. Replaces the body of one private function
-- (private.analysis_output_problems; same signature and privileges).
-- No table, policy, privilege or trigger changes. Connects no AI. No data is
-- changed. All-or-nothing. Contains no credentials.
-- Refuses to run unless 2A-5b is applied and the contract is exactly the
-- reviewed 2A-5a version, or if 2A-5d-1 is already applied.
-- Undo: deploy/stage2a5d1_rollback.sql. Check: deploy/stage2a5d1_verify.sql.
--
-- Source migration (sha256):
--   20261016120000_stage2a5d1_restriction_contract.sql  823073446601aaaf25f85c6de266253e6e858f0fd5455640775a6271ea8994af
-- ===================================================================

begin;

-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-5b is applied,
-- the analysis contract is exactly the reviewed Stage 2A-5a version, and
-- 2A-5d-1 is not yet applied.
-- ===================================================================
do $preflight$
declare
  v_body text := (select prosrc from pg_proc
                  where oid = to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'));
begin
  if v_body is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5a (analysis contract) is not applied.';
  end if;
  if to_regprocedure('private.evidence_manifest(uuid, integer)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5b (evidence integrity) is not applied.';
  end if;
  if v_body like '%Stage 2A-5d-1%' then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5d-1 is already applied.';
  end if;
  if md5(v_body) <> 'c72fd76ccb48d0e412442f91ea0619ff' then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): private.analysis_output_problems is not the reviewed Stage 2A-5a version (md5 %); it was changed outside the deployment files', md5(v_body);
  end if;
  if to_regprocedure('private.has_active_restriction(uuid)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): private.has_active_restriction (Stage 2A-1) is missing.';
  end if;
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): role % cannot bypass RLS, so the contract could not read restrictions', current_user;
  end if;
  raise notice 'Preflight passed: installing Stage 2A-5d-1 (active restrictions in the evidence snapshot forbid contact recommendations).';
end
$preflight$;

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261016120000_stage2a5d1_restriction_contract.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-5d-1 — contract rule: an active contact restriction in the evidence
-- snapshot forbids any contact recommendation. No AI is connected.
--
-- Gap closed: the 2A-5a contract (rre-analysis/1) forced DO_NOT_PURSUE only when
-- the analysis itself reported a restriction (output.contact_restrictions). A
-- restriction already on the case when the analysis started — recorded by the
-- founder, the client, an earlier analysis, or preserved from a rejected one
-- (2A-5b) — is in the analysis's evidence snapshot
-- (analyses.evidence_manifest -> 'restrictions', items {id, kind, source, status})
-- but was not consulted, so an output recommending PURSUE / GREEN / a message was
-- accepted. founder_approve already refused to approve such a recommendation
-- (CONTACT_RESTRICTED); now it can no longer be stored as an accepted analysis.
--
-- New rule (in private.analysis_output_problems, same signature, same privileges):
-- if the snapshot lists a restriction whose status is not DISMISSED_AS_MISREAD
-- (or the case has an ACTIVE restriction now, or the snapshot has no restriction
-- list at all), an analysis is accepted only with
--   recommendation.pursue = DO_NOT_PURSUE, classification RED,
--   next_action STOP_CONTACT, and no proposed message —
-- for COMPLETE and for INSUFFICIENT_EVIDENCE (which then carries RED, the only
-- classification it may carry). Otherwise internal_complete_analysis records it as
-- ERROR ("REJECTED by analysis contract"), keeps nothing as findings, and returns
-- the case to its prior state (unchanged 2A-5a/2A-5b behaviour). The snapshot
-- restriction also satisfies "DO_NOT_PURSUE needs a restriction or a reason".
-- Every other rule of rre-analysis/1 is unchanged; the contract version string
-- stays rre-analysis/1 (the output shape is unchanged).
--
-- Nothing else changes: no table, column, policy, privilege or trigger;
-- internal_complete_analysis, founder_start_analysis and the 2A-5b evidence
-- integrity are untouched. Analyses stay founder-only.
-- Rollback: supabase/deploy/stage2a5d1_rollback.sql (restores the 2A-5a body).

create or replace function private.analysis_output_problems(
  p_analysis public.analyses,
  p_status public.analysis_status,
  p_output jsonb,
  p_ai_classification public.classification,
  p_ai_proposed_message text,
  p_detected_restrictions jsonb
) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p text[] := '{}';
  v_x text;
  v_ea jsonb;
  v_obs jsonb;
  v_hyp jsonb;
  v_unk jsonb;
  v_rec jsonb;
  v_na jsonb;
  v_res jsonb;
  v_rnp jsonb;
  v_r record;
  v_s record;
  v_w text;
  v_obs_ids text[];
  v_hyp_ids text[];
  v_suff text;
  v_pursue text;
  v_na_type text;
  v_usable integer;
  v_restricted boolean;
begin
  if p_status not in ('COMPLETE', 'INSUFFICIENT_EVIDENCE') then
    return v_p;
  end if;
  if jsonb_typeof(p_output) is distinct from 'object' then
    return array['output must be a JSON object'];
  end if;
  if octet_length(p_output::text) > 200000 then
    return array['output is larger than 200 kB'];
  end if;
  if p_output ->> 'contract_version' is distinct from 'rre-analysis/1' then
    v_p := array_append(v_p, 'contract_version must be rre-analysis/1');
  end if;
  v_x := private.ac_extra_keys(p_output, array['contract_version', 'evidence_assessment', 'observations', 'hypotheses',
                                              'unknowns', 'recommendation', 'contact_restrictions', 'reasons_not_to_pursue']);
  if v_x is not null then v_p := array_append(v_p, 'unexpected keys ' || v_x); end if;
  foreach v_x in array array['evidence_assessment', 'observations', 'hypotheses', 'unknowns', 'recommendation',
                             'contact_restrictions', 'reasons_not_to_pursue'] loop
    if not p_output ? v_x then v_p := array_append(v_p, 'missing ' || v_x); end if;
  end loop;
  if cardinality(v_p) > 0 then
    return v_p;
  end if;

  v_ea := p_output -> 'evidence_assessment';
  v_obs := p_output -> 'observations';
  v_hyp := p_output -> 'hypotheses';
  v_unk := p_output -> 'unknowns';
  v_rec := p_output -> 'recommendation';
  v_res := p_output -> 'contact_restrictions';
  v_rnp := p_output -> 'reasons_not_to_pursue';
  -- Stage 2A-5d-1: is contact restricted for this analysis? The evidence snapshot
  -- (evidence_manifest.restrictions, written by founder_start_analysis) lists every
  -- restriction on the case as {id, kind, source, status}; any entry that is not
  -- DISMISSED_AS_MISREAD counts as active (fail closed: a malformed entry counts).
  -- A snapshot without a restriction list cannot be judged and is rejected below.
  -- An active restriction recorded on the case since the snapshot also counts.
  v_restricted := jsonb_typeof(p_analysis.evidence_manifest -> 'restrictions') is distinct from 'array'
                  or exists (select 1 from jsonb_array_elements(private.ac_arr(p_analysis.evidence_manifest -> 'restrictions')) r
                             where (case when jsonb_typeof(r) = 'object' then r ->> 'status' end) is distinct from 'DISMISSED_AS_MISREAD')
                  or private.has_active_restriction(p_analysis.case_id);
  if jsonb_typeof(p_analysis.evidence_manifest -> 'restrictions') is distinct from 'array' then
    v_p := array_append(v_p, 'the evidence snapshot has no restriction list; contact restrictions cannot be checked');
  end if;
  foreach v_x in array array['observations', 'hypotheses', 'unknowns', 'contact_restrictions', 'reasons_not_to_pursue'] loop
    if jsonb_typeof(p_output -> v_x) is distinct from 'array' or jsonb_array_length(p_output -> v_x) > 60 then
      v_p := array_append(v_p, v_x || ' must be a list (at most 60)');
    end if;
  end loop;
  if jsonb_typeof(v_ea) is distinct from 'object' or jsonb_typeof(v_rec) is distinct from 'object' then
    v_p := array_append(v_p, 'evidence_assessment and recommendation must be objects');
  end if;
  if cardinality(v_p) > 0 then
    return v_p;
  end if;

  -- evidence assessment
  v_suff := v_ea ->> 'sufficiency';
  if v_suff is null or v_suff not in ('SUFFICIENT', 'PARTIAL', 'INSUFFICIENT') then
    v_p := array_append(v_p, 'evidence_assessment.sufficiency must be SUFFICIENT, PARTIAL or INSUFFICIENT');
  end if;
  if not private.ac_text(v_ea -> 'summary', 1000) then
    v_p := array_append(v_p, 'evidence_assessment.summary is required (1-1000 characters)');
  end if;
  if jsonb_typeof(v_ea -> 'missing_evidence') is distinct from 'array' or jsonb_array_length(v_ea -> 'missing_evidence') > 20
     or exists (select 1 from jsonb_array_elements(private.ac_arr(v_ea -> 'missing_evidence')) e where not private.ac_text(e, 500)) then
    v_p := array_append(v_p, 'evidence_assessment.missing_evidence must be a list of texts (1-500 characters)');
  end if;
  v_x := private.ac_extra_keys(v_ea, array['sufficiency', 'summary', 'missing_evidence']);
  if v_x is not null then v_p := array_append(v_p, 'evidence_assessment: unexpected keys ' || v_x); end if;

  -- observations
  select array_agg(o ->> 'id') into v_obs_ids from jsonb_array_elements(v_obs) o;
  v_obs_ids := coalesce(v_obs_ids, '{}');
  if exists (select 1 from unnest(v_obs_ids) i where i is null or i !~ '^O[0-9]{1,3}$')
     or cardinality(v_obs_ids) <> (select count(distinct i) from unnest(v_obs_ids) i) then
    v_p := array_append(v_p, 'observation ids must be unique and look like O1, O2, ...');
  end if;
  for v_r in select o, i from jsonb_array_elements(v_obs) with ordinality as t(o, i) loop
    v_w := format('observations[%s]', v_r.i - 1);
    if jsonb_typeof(v_r.o) is distinct from 'object' then
      v_p := array_append(v_p, v_w || ' must be an object');
      continue;
    end if;
    if v_r.o ->> 'actor' is null or v_r.o ->> 'actor' not in ('PROSPECT', 'SELLER', 'UNCLEAR') then
      v_p := array_append(v_p, v_w || '.actor must be PROSPECT, SELLER or UNCLEAR');
    end if;
    if not private.ac_text(v_r.o -> 'behavior', 1000) then
      v_p := array_append(v_p, v_w || '.behavior is required (1-1000 characters)');
    end if;
    v_p := v_p || private.ac_refs_problems(p_analysis, v_r.o -> 'evidence', v_w || '.evidence', 1);
    -- An actor cannot be evidenced only by the other side's own messages.
    if exists (select 1 from jsonb_array_elements(private.ac_arr(v_r.o -> 'evidence')) e
               join public.case_messages m on m.id::text = e ->> 'message_id' and m.case_id = p_analysis.case_id
               where e ->> 'type' = 'MESSAGE'
                 and ((v_r.o ->> 'actor' = 'PROSPECT' and m.kind = 'RECOVERY_SENT')
                   or (v_r.o ->> 'actor' = 'SELLER' and m.kind = 'PROSPECT_RESPONSE'))) then
      v_p := array_append(v_p, v_w || ': cites a message written by the other party');
    end if;
    v_x := private.ac_extra_keys(v_r.o, array['id', 'actor', 'behavior', 'evidence']);
    if v_x is not null then v_p := array_append(v_p, v_w || ': unexpected keys ' || v_x); end if;
  end loop;

  -- hypotheses
  select array_agg(h ->> 'id') into v_hyp_ids from jsonb_array_elements(v_hyp) h;
  v_hyp_ids := coalesce(v_hyp_ids, '{}');
  if exists (select 1 from unnest(v_hyp_ids) i where i is null or i !~ '^H[0-9]{1,3}$')
     or cardinality(v_hyp_ids) <> (select count(distinct i) from unnest(v_hyp_ids) i) then
    v_p := array_append(v_p, 'hypothesis ids must be unique and look like H1, H2, ...');
  end if;
  for v_r in select h, i from jsonb_array_elements(v_hyp) with ordinality as t(h, i) loop
    v_w := format('hypotheses[%s]', v_r.i - 1);
    if jsonb_typeof(v_r.h) is distinct from 'object' then
      v_p := array_append(v_p, v_w || ' must be an object');
      continue;
    end if;
    if v_r.h ->> 'category' is null or v_r.h ->> 'category' not in
       ('EMOTIONAL_BARRIER', 'TRUST_AND_RISK', 'BUYING_MOTIVATION', 'DECISION_FRICTION', 'SELLER_CREATED_RESISTANCE') then
      v_p := array_append(v_p, v_w || '.category is not a known category');
    end if;
    if not private.ac_text(v_r.h -> 'statement', 1000) then
      v_p := array_append(v_p, v_w || '.statement is required (1-1000 characters)');
    end if;
    if not private.ac_text(v_r.h -> 'uncertainty', 1000) then
      v_p := array_append(v_p, v_w || '.uncertainty is required: say what would change this view');
    end if;
    if v_r.h ->> 'confidence' is null or v_r.h ->> 'confidence' not in ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN') then
      v_p := array_append(v_p, v_w || '.confidence must be HIGH, MEDIUM, LOW or UNKNOWN');
    end if;
    foreach v_x in array array['supporting_observations', 'contradicting_observations', 'competing_hypotheses'] loop
      if jsonb_typeof(v_r.h -> v_x) is distinct from 'array' or exists (select 1 from jsonb_array_elements(private.ac_arr(v_r.h -> v_x)) e where jsonb_typeof(e) is distinct from 'string') then
        v_p := array_append(v_p, format('%s.%s must be a list of ids', v_w, v_x));
      end if;
    end loop;
    if jsonb_array_length(private.ac_arr(v_r.h -> 'supporting_observations')) = 0 then
      v_p := array_append(v_p, v_w || ' rests on no observation; record it as an unknown instead');
    end if;
    if exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'supporting_observations')) e where e <> all (v_obs_ids))
       or exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'contradicting_observations')) e where e <> all (v_obs_ids)) then
      v_p := array_append(v_p, v_w || ' refers to an observation that does not exist');
    end if;
    if exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'supporting_observations')) e
               where e in (select jsonb_array_elements_text(private.ac_arr(v_r.h -> 'contradicting_observations')))) then
      v_p := array_append(v_p, v_w || ': an observation cannot both support and contradict it');
    end if;
    if exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'competing_hypotheses')) e
               where e <> all (v_hyp_ids) or e = v_r.h ->> 'id') then
      v_p := array_append(v_p, v_w || '.competing_hypotheses must name other hypotheses');
    end if;
    if v_r.h ->> 'basis' = 'STATED_BY_PROSPECT' then
      -- Only what the prospect actually said, quoted, may be presented as stated.
      if not exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'supporting_observations')) s
                     join jsonb_array_elements(v_obs) o on o ->> 'id' = s
                     where o ->> 'actor' = 'PROSPECT'
                       and exists (select 1 from jsonb_array_elements(private.ac_arr(o -> 'evidence')) e where private.ac_text(e -> 'quote', 500))) then
        v_p := array_append(v_p, v_w || ' is not directly supported by a quoted prospect statement; label it HYPOTHESIS');
      end if;
    elsif v_r.h ->> 'basis' = 'HYPOTHESIS' then
      if jsonb_array_length(private.ac_arr(v_r.h -> 'competing_hypotheses')) = 0 then
        v_p := array_append(v_p, v_w || ' is a hypothesis and must name at least one competing hypothesis');
      end if;
      if v_r.h ->> 'confidence' = 'HIGH' then
        v_p := array_append(v_p, v_w || ': an unstated psychological hypothesis cannot be HIGH confidence');
      end if;
    else
      v_p := array_append(v_p, v_w || '.basis must be STATED_BY_PROSPECT or HYPOTHESIS');
    end if;
    if v_r.h ->> 'confidence' = 'HIGH' and jsonb_array_length(private.ac_arr(v_r.h -> 'contradicting_observations')) > 0 then
      v_p := array_append(v_p, v_w || ': HIGH confidence is impossible while observations contradict it');
    end if;
    v_x := private.ac_extra_keys(v_r.h, array['id', 'category', 'statement', 'basis', 'supporting_observations',
                                             'contradicting_observations', 'competing_hypotheses', 'confidence', 'uncertainty']);
    if v_x is not null then v_p := array_append(v_p, v_w || ': unexpected keys ' || v_x); end if;
  end loop;

  -- unknowns
  for v_r in select u, i from jsonb_array_elements(v_unk) with ordinality as t(u, i) loop
    if not (private.ac_text(v_r.u -> 'question', 500) and private.ac_text(v_r.u -> 'why_it_matters', 500))
       or private.ac_extra_keys(v_r.u, array['question', 'why_it_matters']) is not null then
      v_p := array_append(v_p, format('unknowns[%s] needs exactly question and why_it_matters (1-500 characters)', v_r.i - 1));
    end if;
  end loop;

  -- contact restrictions and reasons not to pursue
  for v_r in select c, i from jsonb_array_elements(v_res) with ordinality as t(c, i) loop
    v_w := format('contact_restrictions[%s]', v_r.i - 1);
    if v_r.c ->> 'kind' is null or v_r.c ->> 'kind' not in ('EXPLICIT_OPT_OUT', 'PROHIBITED_CONTACT', 'OTHER') then
      v_p := array_append(v_p, v_w || '.kind must be EXPLICIT_OPT_OUT, PROHIBITED_CONTACT or OTHER');
    end if;
    if not private.ac_text(v_r.c -> 'reason', 1000) then
      v_p := array_append(v_p, v_w || '.reason is required');
    end if;
    v_p := v_p || private.ac_refs_problems(p_analysis, v_r.c -> 'evidence', v_w || '.evidence', 1);
    v_x := private.ac_extra_keys(v_r.c, array['kind', 'reason', 'evidence']);
    if v_x is not null then v_p := array_append(v_p, v_w || ': unexpected keys ' || v_x); end if;
  end loop;
  for v_r in select c, i from jsonb_array_elements(v_rnp) with ordinality as t(c, i) loop
    v_w := format('reasons_not_to_pursue[%s]', v_r.i - 1);
    if not private.ac_text(v_r.c -> 'reason', 1000) then
      v_p := array_append(v_p, v_w || '.reason is required');
    end if;
    v_p := v_p || private.ac_refs_problems(p_analysis, coalesce(v_r.c -> 'evidence', '[]'::jsonb), v_w || '.evidence', 0);
    v_x := private.ac_extra_keys(v_r.c, array['reason', 'evidence']);
    if v_x is not null then v_p := array_append(v_p, v_w || ': unexpected keys ' || v_x); end if;
  end loop;
  -- The restrictions in the output must be exactly the ones being recorded.
  if jsonb_typeof(coalesce(p_detected_restrictions, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(v_res) <> jsonb_array_length(coalesce(p_detected_restrictions, '[]'::jsonb))
     or exists (select 1 from jsonb_array_elements(v_res) with ordinality a(c, i)
                join jsonb_array_elements(coalesce(p_detected_restrictions, '[]'::jsonb)) with ordinality b(d, j) on a.i = b.j
                where a.c ->> 'kind' is distinct from b.d ->> 'kind') then
    v_p := array_append(v_p, 'contact_restrictions do not match the restrictions being recorded');
  end if;

  -- recommendation
  v_pursue := v_rec ->> 'pursue';
  v_na := v_rec -> 'next_action';
  v_na_type := v_na ->> 'type';
  if v_pursue is null or v_pursue not in ('PURSUE', 'DO_NOT_PURSUE', 'UNKNOWN') then
    v_p := array_append(v_p, 'recommendation.pursue must be PURSUE, DO_NOT_PURSUE or UNKNOWN');
  end if;
  if not private.ac_text(v_rec -> 'strategy', 1500) then
    v_p := array_append(v_p, 'recommendation.strategy is required (text or UNKNOWN)');
  end if;
  if not private.ac_text(v_rec -> 'psychological_rationale', 1500) then
    v_p := array_append(v_p, 'recommendation.psychological_rationale is required (text or UNKNOWN)');
  end if;
  if jsonb_typeof(v_rec -> 'based_on_hypotheses') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(private.ac_arr(v_rec -> 'based_on_hypotheses')) e
                where jsonb_typeof(e) is distinct from 'string' or (e #>> '{}') <> all (v_hyp_ids)) then
    v_p := array_append(v_p, 'recommendation.based_on_hypotheses must list existing hypotheses');
  end if;
  if jsonb_typeof(v_na) is distinct from 'object' or v_na_type is null
     or v_na_type not in ('SEND_MESSAGE', 'ASK_DIAGNOSTIC_QUESTION', 'WAIT', 'STOP_CONTACT')
     or not private.ac_text(v_na -> 'text', 2000)
     or private.ac_extra_keys(v_na, array['type', 'text']) is not null then
    v_p := array_append(v_p, 'recommendation.next_action needs a type (SEND_MESSAGE, ASK_DIAGNOSTIC_QUESTION, WAIT, STOP_CONTACT) and a text');
  end if;
  v_x := private.ac_extra_keys(v_rec, array['pursue', 'strategy', 'psychological_rationale', 'based_on_hypotheses', 'next_action']);
  if v_x is not null then v_p := array_append(v_p, 'recommendation: unexpected keys ' || v_x); end if;

  if v_pursue = 'PURSUE' then
    if v_rec ->> 'strategy' = 'UNKNOWN' or v_rec ->> 'psychological_rationale' = 'UNKNOWN'
       or jsonb_array_length(private.ac_arr(v_rec -> 'based_on_hypotheses')) = 0 then
      v_p := array_append(v_p, 'PURSUE needs a strategy, a psychological rationale and the hypotheses it rests on');
    end if;
    if v_na_type not in ('SEND_MESSAGE', 'ASK_DIAGNOSTIC_QUESTION') then
      v_p := array_append(v_p, 'PURSUE needs a message or a diagnostic question as the next action');
    end if;
  elsif v_pursue = 'DO_NOT_PURSUE' then
    if v_na_type is distinct from 'STOP_CONTACT' then
      v_p := array_append(v_p, 'DO_NOT_PURSUE needs STOP_CONTACT as the next action');
    end if;
    if jsonb_array_length(v_res) = 0 and jsonb_array_length(v_rnp) = 0 and not v_restricted then
      v_p := array_append(v_p, 'DO_NOT_PURSUE needs a contact restriction or a reason not to pursue');
    end if;
  elsif v_pursue = 'UNKNOWN' then
    if v_na_type not in ('ASK_DIAGNOSTIC_QUESTION', 'WAIT') then
      v_p := array_append(v_p, 'UNKNOWN pursuit needs a diagnostic question or WAIT as the next action');
    end if;
  end if;
  if jsonb_array_length(v_res) > 0 and v_pursue is distinct from 'DO_NOT_PURSUE' then
    v_p := array_append(v_p, 'a contact restriction requires DO_NOT_PURSUE');
  end if;
  -- Stage 2A-5d-1: an active contact restriction in the evidence snapshot forbids any
  -- contact recommendation, whatever the model concluded and whatever the status.
  if v_restricted then
    if v_pursue is distinct from 'DO_NOT_PURSUE' then
      v_p := array_append(v_p, 'an active contact restriction in the evidence snapshot requires DO_NOT_PURSUE');
    end if;
    if p_ai_classification is distinct from 'RED' then
      v_p := array_append(v_p, 'an active contact restriction in the evidence snapshot requires classification RED');
    end if;
    if v_na_type is distinct from 'STOP_CONTACT' then
      v_p := array_append(v_p, 'an active contact restriction in the evidence snapshot requires STOP_CONTACT as the next action');
    end if;
    if nullif(btrim(coalesce(p_ai_proposed_message, '')), '') is not null then
      v_p := array_append(v_p, 'an active contact restriction in the evidence snapshot allows no proposed message');
    end if;
  end if;
  -- classification and proposed message agree with the recommendation
  if (v_pursue = 'DO_NOT_PURSUE' and p_ai_classification is distinct from 'RED')
     or (v_pursue = 'PURSUE' and p_ai_classification is distinct from 'GREEN' and p_ai_classification is distinct from 'YELLOW')
     or (v_pursue = 'UNKNOWN' and p_ai_classification is not null) then
    v_p := array_append(v_p, 'classification does not match the recommendation (RED = DO_NOT_PURSUE, GREEN/YELLOW = PURSUE, none = UNKNOWN)');
  end if;
  if nullif(btrim(coalesce(p_ai_proposed_message, '')), '') is not null then
    if v_na_type is distinct from 'SEND_MESSAGE' or private.ac_norm(p_ai_proposed_message) <> private.ac_norm(v_na ->> 'text') then
      v_p := array_append(v_p, 'a proposed message is allowed only for SEND_MESSAGE and must equal its text');
    end if;
  elsif v_na_type = 'SEND_MESSAGE' then
    v_p := array_append(v_p, 'SEND_MESSAGE needs the proposed message');
  end if;

  -- sufficiency and status
  select count(*) into v_usable from (
    select 1 from jsonb_array_elements(private.ac_arr(p_analysis.evidence_manifest -> 'messages'))
    union all
    select 1 from jsonb_array_elements(private.ac_arr(p_analysis.evidence_manifest -> 'screenshots')) m
    where exists (select 1 from public.case_screenshots s where s.case_id = p_analysis.case_id
                  and s.position = (m ->> 'position')::integer and s.sha256 = m ->> 'sha256' and s.file_deleted_at is null)) u;
  if p_status = 'INSUFFICIENT_EVIDENCE' then
    if v_suff is distinct from 'INSUFFICIENT' then
      v_p := array_append(v_p, 'INSUFFICIENT_EVIDENCE requires sufficiency INSUFFICIENT');
    end if;
    -- (Stage 2A-5d-1: under an active contact restriction it is RED / DO_NOT_PURSUE, see above.)
    if jsonb_array_length(v_hyp) > 0 or (p_ai_classification is not null and not v_restricted)
       or nullif(btrim(coalesce(p_ai_proposed_message, '')), '') is not null
       or v_rec ->> 'strategy' is distinct from 'UNKNOWN' then
      v_p := array_append(v_p, 'INSUFFICIENT_EVIDENCE carries no hypotheses, classification (RED only under a contact restriction), proposed message or strategy (strategy UNKNOWN)');
    end if;
    if v_pursue = 'PURSUE' then
      v_p := array_append(v_p, 'INSUFFICIENT_EVIDENCE cannot recommend PURSUE');
    end if;
    if jsonb_array_length(v_unk) = 0 or jsonb_array_length(private.ac_arr(v_ea -> 'missing_evidence')) = 0 then
      v_p := array_append(v_p, 'INSUFFICIENT_EVIDENCE must state what is missing (missing_evidence and unknowns)');
    end if;
  else
    if v_usable = 0 then
      v_p := array_append(v_p, 'no usable evidence remains (none recorded, or all deleted): only INSUFFICIENT_EVIDENCE is allowed');
    end if;
    if v_suff = 'INSUFFICIENT' then
      v_p := array_append(v_p, 'sufficiency INSUFFICIENT requires status INSUFFICIENT_EVIDENCE');
    end if;
    if jsonb_array_length(v_obs) = 0 then
      v_p := array_append(v_p, 'COMPLETE needs at least one observation');
    end if;
    if v_suff = 'PARTIAL' and jsonb_array_length(v_unk) = 0 then
      v_p := array_append(v_p, 'PARTIAL evidence must list at least one unknown');
    end if;
  end if;
  return v_p;
exception when others then
  -- Fail closed: anything unexpected in the output rejects it.
  return array['output could not be validated: ' || sqlerrm];
end $$;

-- ---------------------------------------------------------------- privileges: unchanged (nobody calls the contract directly)
revoke all on function private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)
  from public, anon, authenticated, service_role;
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261016120000_stage2a5d1_restriction_contract.sql <<<<<<<<<<<<<<<<<<<<

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

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-5d-1', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261016120000_stage2a5d1_restriction_contract.sql', 'sha256', '823073446601aaaf25f85c6de266253e6e858f0fd5455640775a6271ea8994af'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

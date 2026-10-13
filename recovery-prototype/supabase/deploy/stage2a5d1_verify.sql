-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5d-1 VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- (Row 4 calls the contract on an in-memory synthetic analysis row; nothing
-- is stored.) Run after stage2a5d1_deploy.sql; then re-run
-- stage2a5b_verify.sql, stage2a5a_verify.sql and the earlier files.
-- ===================================================================
with
fn as (select p.oid, p.prosrc, p.prosecdef, p.proconfig from pg_proc p
       where p.oid = to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)')),
ica as (select prosrc from pg_proc where oid = to_regprocedure('public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)')),
probe(out) as (select '{"contract_version": "rre-analysis/1",
    "evidence_assessment": {"sufficiency": "SUFFICIENT", "summary": "Synthetic verification.", "missing_evidence": []},
    "observations": [], "hypotheses": [], "unknowns": [],
    "recommendation": {"pursue": "PURSUE", "strategy": "Synthetic.", "psychological_rationale": "Synthetic.", "based_on_hypotheses": [],
                       "next_action": {"type": "SEND_MESSAGE", "text": "Synthetic pitch."}},
    "contact_restrictions": [], "reasons_not_to_pursue": []}'::jsonb),
self_test as (
  select
    (select array_to_string(private.analysis_output_problems(jsonb_populate_record(null::public.analyses, jsonb_build_object(
        'id', gen_random_uuid(), 'case_id', gen_random_uuid(), 'evidence_manifest',
        '{"manifest_version": 2, "messages": [], "screenshots": [], "restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "EXPLICIT_OPT_OUT", "source": "CLIENT", "status": "ACTIVE"}]}'::jsonb)),
      'COMPLETE', probe.out, 'GREEN', 'Synthetic pitch.', '[]'), ' | ') from probe) as active,
    (select array_to_string(private.analysis_output_problems(jsonb_populate_record(null::public.analyses, jsonb_build_object(
        'id', gen_random_uuid(), 'case_id', gen_random_uuid(), 'evidence_manifest',
        '{"manifest_version": 2, "messages": [], "screenshots": [], "restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "EXPLICIT_OPT_OUT", "source": "AI_DETECTED", "status": "DISMISSED_AS_MISREAD"}]}'::jsonb)),
      'COMPLETE', probe.out, 'GREEN', 'Synthetic pitch.', '[]'), ' | ') from probe) as dismissed
  where exists (select 1 from fn)
),
restricted_accepted as (
  select a.* from public.analyses a
  where a.status in ('COMPLETE', 'INSUFFICIENT_EVIDENCE')
    and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(a.evidence_manifest -> 'restrictions') = 'array' then a.evidence_manifest -> 'restrictions' else '[]'::jsonb end) e
                where e ->> 'status' = 'ACTIVE')
),
checks(ord, check_name, status, detail) as (
  select 1, 'The analysis contract exists, SECURITY DEFINER with an empty search_path',
    case when (select count(*) from fn where prosecdef and proconfig @> array['search_path=""']) = 1 then 'PASS' else 'FAIL' end,
    'private.analysis_output_problems'
  union all
  select 2, 'No API role can call the contract directly',
    case when exists (select 1 from fn)
          and not exists (select 1 from fn where has_function_privilege('anon', fn.oid, 'EXECUTE') or has_function_privilege('authenticated', fn.oid, 'EXECUTE')
                                              or has_function_privilege('service_role', fn.oid, 'EXECUTE'))
         then 'PASS' else 'FAIL' end, 'anon, authenticated, service_role'
  union all
  select 3, 'The contract reads the restrictions in the evidence snapshot (Stage 2A-5d-1)',
    case when (select prosrc from fn) like '%Stage 2A-5d-1%' and (select prosrc from fn) like '%p_analysis.evidence_manifest -> ''restrictions''%'
          and (select prosrc from fn) like '%private.has_active_restriction(p_analysis.case_id)%' then 'PASS' else 'FAIL' end,
    'evidence_manifest.restrictions + current active restrictions'
  union all
  select 4, 'Self-test: contact is rejected under an active restriction, not under a dismissed one',
    case when (select strpos(active, 'an active contact restriction in the evidence snapshot requires DO_NOT_PURSUE') > 0
                      and strpos(active, 'requires classification RED') > 0 and strpos(active, 'allows no proposed message') > 0
                      and strpos(dismissed, 'active contact restriction') = 0 from self_test) then 'PASS' else 'FAIL' end,
    'synthetic in-memory analysis; nothing stored'
  union all
  select 5, 'Completion still enforces the contract and preserves detected restrictions',
    case when (select prosrc from ica) like '%private.analysis_output_problems(%' and (select prosrc from ica) like '%private.preserve_detected_restrictions(%'
          and has_function_privilege('service_role', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
         then 'PASS' else 'FAIL' end, 'internal_complete_analysis (server-side only)'
  union all
  select 6, 'Analyses and contact restrictions remain founder-only',
    case when (select count(*) from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')) = 2
          and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
                          and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%')) then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(tablename || ': ' || qual, ' | ') from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')), 'none')
  union all
  select 7, 'Stage 2A-5d-1 deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-5d-1'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-5d-1'
  union all
  select 8, 'Accepted analyses of a restricted snapshot that recommend contact (accepted before 2A-5d-1)', 'INFO',
    (select count(*) from restricted_accepted
     where ai_classification is distinct from 'RED' or ai_proposed_message is not null
        or output -> 'recommendation' ->> 'pursue' is distinct from 'DO_NOT_PURSUE')::text
    || ' — should be 0; any such case cannot be approved for contact (CONTACT_RESTRICTED) but should be re-analysed'
  union all
  select 9, 'Analyses in progress (judged by the new rule when they complete)', 'INFO',
    (select count(*) from public.analyses where status = 'PENDING')::text
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

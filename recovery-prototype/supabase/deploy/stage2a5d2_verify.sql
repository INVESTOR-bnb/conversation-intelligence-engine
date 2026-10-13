-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5d-2 VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- (Rows 4-6 call the contract on in-memory synthetic analysis rows; nothing
-- is stored.) Run after stage2a5d2_deploy.sql; then re-run
-- stage2a5d1_verify.sql, stage2a5b_verify.sql and the earlier files.
-- ===================================================================
with
fn as (select p.oid, p.prosrc, p.prosecdef, p.proconfig from pg_proc p
       where p.oid = to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)')),
ica as (select prosrc from pg_proc where oid = to_regprocedure('public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)')),
probe as (select
  jsonb_populate_record(null::public.analyses, jsonb_build_object('id', gen_random_uuid(), 'case_id', gen_random_uuid(),
    'evidence_manifest', '{"manifest_version": 2, "messages": [], "screenshots": [], "restrictions": []}'::jsonb)) as open_row,
  jsonb_populate_record(null::public.analyses, jsonb_build_object('id', gen_random_uuid(), 'case_id', gen_random_uuid(),
    'evidence_manifest', '{"manifest_version": 2, "messages": [], "screenshots": [], "restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "EXPLICIT_OPT_OUT", "source": "CLIENT", "status": "ACTIVE"}]}'::jsonb)) as restricted_row,
  '{"contract_version": "rre-analysis/2",
    "evidence_assessment": {"sufficiency": "SUFFICIENT", "summary": "Synthetic verification.", "missing_evidence": []},
    "observations": [], "hypotheses": [], "unknowns": [],
    "recommendation": {"pursue": "PURSUE", "strategy": "Synthetic.", "psychological_rationale": "Synthetic.", "based_on_hypotheses": [],
                       "next_action": {"type": "SEND_MESSAGE", "text": "Synthetic pitch."}},
    "contact_restrictions": [], "reasons_not_to_pursue": [],
    "adversarial_review": {"challenges": [{"id": "C1", "target": "RECOMMENDATION", "severity": "LOW", "challenge": "Synthetic.",
                                           "evidence": [{"type": "MESSAGE", "message_id": "00000000-0000-4000-8000-0000000000ff", "quote": "fabricated"}]}],
                           "verdict": "UPHOLD_WITH_CONCERNS", "verdict_rationale": "Synthetic."}}'::jsonb as fab),
self_test as (
  select
    (select array_to_string(private.analysis_output_problems(open_row, 'COMPLETE', fab, 'GREEN', 'Synthetic pitch.', '[]'), ' | ') from probe) as fabricated,
    (select array_to_string(private.analysis_output_problems(open_row, 'COMPLETE',
       jsonb_set(jsonb_set(fab, '{adversarial_review,verdict}', '"REJECT_RECOMMENDATION"'), '{adversarial_review,challenges}',
                 '[{"id": "C1", "target": "RECOMMENDATION", "severity": "HIGH", "challenge": "Synthetic.", "evidence": []}]'),
       'GREEN', 'Synthetic pitch.', '[]'), ' | ') from probe) as rejecting,
    (select array_to_string(private.analysis_output_problems(restricted_row, 'COMPLETE',
       jsonb_set(fab, '{adversarial_review}', '{"challenges": [], "verdict": "UPHOLD", "verdict_rationale": "Synthetic."}'),
       'GREEN', 'Synthetic pitch.', '[]'), ' | ') from probe) as restricted
  where exists (select 1 from fn)
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
  select 3, 'The contract validates rre-analysis/2 reviews and keeps the 2A-5d-1 restriction rule',
    case when (select prosrc from fn) like '%Stage 2A-5d-2%' and (select prosrc from fn) like '%Stage 2A-5d-1%'
          and (select prosrc from fn) like '%private.ac_refs_problems(p_analysis, v_r.c -> ''evidence''%' then 'PASS' else 'FAIL' end,
    'rre-analysis/1 and rre-analysis/2'
  union all
  select 4, 'Self-test: a fabricated citation in the review is rejected',
    case when (select strpos(fabricated, 'adversarial_review.challenges[0].evidence[0]: message is not part of this analysis''s evidence') > 0 from self_test)
         then 'PASS' else 'FAIL' end, 'synthetic in-memory analysis; nothing stored'
  union all
  select 5, 'Self-test: a rejecting review leaves no contact message',
    case when (select strpos(rejecting, 'cannot remain PURSUE') > 0 and strpos(rejecting, 'cannot carry a message or question') > 0
                      and strpos(rejecting, 'allows no proposed message') > 0 from self_test) then 'PASS' else 'FAIL' end,
    'REJECT_RECOMMENDATION with PURSUE + message is refused'
  union all
  select 6, 'Self-test: an active restriction still forbids contact under rre-analysis/2',
    case when (select strpos(restricted, 'an active contact restriction in the evidence snapshot requires DO_NOT_PURSUE') > 0 from self_test)
         then 'PASS' else 'FAIL' end, 'Stage 2A-5d-1 rule'
  union all
  select 7, 'Completion still enforces the contract and preserves detected restrictions',
    case when (select prosrc from ica) like '%private.analysis_output_problems(%' and (select prosrc from ica) like '%private.preserve_detected_restrictions(%'
          and has_function_privilege('service_role', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
         then 'PASS' else 'FAIL' end, 'internal_complete_analysis (server-side only)'
  union all
  select 8, 'Analyses (and their reviews) remain founder-only; no view exposes them',
    case when (select count(*) from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')) = 2
          and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
                          and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%'))
          and not exists (select 1 from pg_views where schemaname not in ('pg_catalog', 'information_schema') and definition ~* '\manalyses\M')
         then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(tablename || ': ' || qual, ' | ') from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')), 'none')
  union all
  select 9, 'Stage 2A-5d-2 deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-5d-2'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-5d-2'
  union all
  select 10, 'Stored analyses by contract version', 'INFO',
    coalesce((select string_agg(v || ': ' || n, ', ' order by v) from (select coalesce(output ->> 'contract_version', '(no output)') v, count(*) n
                                                                      from public.analyses group by 1) x), 'none')
  union all
  select 11, 'Stored analyses whose review rejects the recommendation but carry a contact message', 'INFO',
    (select count(*) from public.analyses where status in ('COMPLETE', 'INSUFFICIENT_EVIDENCE')
       and output -> 'adversarial_review' ->> 'verdict' = 'REJECT_RECOMMENDATION'
       and (ai_proposed_message is not null or output -> 'recommendation' -> 'next_action' ->> 'type' in ('SEND_MESSAGE', 'ASK_DIAGNOSTIC_QUESTION')))::text
    || ' — must be 0'
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

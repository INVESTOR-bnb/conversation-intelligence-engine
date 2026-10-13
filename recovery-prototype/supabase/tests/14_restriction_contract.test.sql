-- Stage 2A-5d-1: an active contact restriction in an analysis's evidence snapshot
-- (analyses.evidence_manifest -> 'restrictions') forbids any contact recommendation:
-- only DO_NOT_PURSUE, classification RED, STOP_CONTACT and no proposed message are
-- accepted, whatever the model output says. Synthetic data only; no AI.
begin;
select tests.as_owner();
select tests.seed();

-- ---------------------------------------------------------------- fixtures
-- :r — restricted by the founder BEFORE analysis; :u — unrestricted control.
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'RC-1', 'Synthetic product', 'Referral', 'TEXT',
  'Prospect: Is it still available?' || chr(10) || 'Business: Yes, synthetic test.') as r \gset
select public.client_submit_case(:'r');
select public.client_create_case(gen_random_uuid(), 'RC-2', 'Synthetic product', 'Referral', 'TEXT',
  'Prospect: Is it still available?' || chr(10) || 'Business: Yes, synthetic test.') as u \gset
select public.client_submit_case(:'u');
select tests.login(tests.founder());
select public.founder_add_restriction(:'r', 'PROHIBITED_CONTACT', 'Synthetic: the business must not contact this prospect.') as rr \gset
select public.founder_start_analysis(:'r') as ar \gset
select public.founder_start_analysis(:'u') as au \gset
select tests.as_owner();

-- problems as one string ('' = accepted)
create function pg_temp.p(p_analysis uuid, p_out jsonb, p_status public.analysis_status default 'COMPLETE',
  p_class public.classification default null, p_msg text default null) returns text language sql as $$
  select coalesce(array_to_string(private.analysis_output_problems(a, p_status, p_out, p_class, p_msg, '[]'), ' | '), '<null>')
  from public.analyses a where a.id = p_analysis
$$;
-- the same, judged against a substituted evidence snapshot
create function pg_temp.pm(p_analysis uuid, p_manifest jsonb, p_out jsonb, p_class public.classification, p_msg text) returns text language sql as $$
  select coalesce(array_to_string(private.analysis_output_problems(
    jsonb_populate_record(a, jsonb_build_object('evidence_manifest', p_manifest)), 'COMPLETE', p_out, p_class, p_msg, '[]'), ' | '), '<null>')
  from public.analyses a where a.id = p_analysis
$$;
create function pg_temp.has(p_text text, p_sub text) returns boolean language sql as $$ select strpos(p_text, p_sub) > 0 $$;
create function pg_temp.na(p_out jsonb, p_pursue text, p_type text, p_text text) returns jsonb language sql as $$
  select jsonb_set(jsonb_set(p_out, '{recommendation,pursue}', to_jsonb(p_pursue)), '{recommendation,next_action}',
                   jsonb_build_object('type', p_type, 'text', p_text))
$$;
-- an INSUFFICIENT_EVIDENCE output with the given recommendation
create function pg_temp.insufficient(p_pursue text, p_type text) returns jsonb language sql as $$
  select jsonb_build_object('contract_version', 'rre-analysis/1',
    'evidence_assessment', '{"sufficiency": "INSUFFICIENT", "summary": "Synthetic: too little.", "missing_evidence": ["The rest of the conversation"]}'::jsonb,
    'observations', '[]'::jsonb, 'hypotheses', '[]'::jsonb,
    'unknowns', '[{"question": "What happened next?", "why_it_matters": "Any reading would be invented."}]'::jsonb,
    'recommendation', jsonb_build_object('pursue', p_pursue, 'strategy', 'UNKNOWN', 'psychological_rationale', 'UNKNOWN', 'based_on_hypotheses', '[]'::jsonb,
                                         'next_action', jsonb_build_object('type', p_type, 'text', 'Synthetic next action.')),
    'contact_restrictions', '[]'::jsonb, 'reasons_not_to_pursue', '[]'::jsonb)
$$;
select tests.contract_output(:'ar', 'GREEN', 'Synthetic pitch.') as green_r \gset
select tests.contract_output(:'au', 'GREEN', 'Synthetic pitch.') as green_u \gset
select tests.contract_output(:'ar', 'RED', null) as red_r \gset

-- ---------------------------------------------------------------- the snapshot structure the rule reads (not assumed)
select tests.ok((select evidence_manifest -> 'restrictions' @> jsonb_build_array(jsonb_build_object('id', :'rr', 'kind', 'PROHIBITED_CONTACT', 'source', 'FOUNDER', 'status', 'ACTIVE'))
                        and jsonb_typeof(evidence_manifest -> 'restrictions') = 'array'
                 from public.analyses where id = :'ar'), 'the evidence snapshot lists the restriction as {id, kind, source, status: ACTIVE}');
select tests.is((select evidence_manifest -> 'restrictions' from public.analyses where id = :'au'), '[]'::jsonb, 'the control case snapshot has an empty restriction list');

-- ---------------------------------------------------------------- control: the same output is fine without a restriction
select tests.is(pg_temp.p(:'au', :'green_u'::jsonb, 'COMPLETE', 'GREEN', 'Synthetic pitch.'), '', 'control: GREEN / PURSUE / message is accepted on an unrestricted case');
select tests.is(pg_temp.p(:'au', pg_temp.na(:'green_u'::jsonb, 'UNKNOWN', 'ASK_DIAGNOSTIC_QUESTION', 'Ask whether they still want it.'), 'COMPLETE', null, null),
  '', 'control: UNKNOWN with a diagnostic question is accepted on an unrestricted case');

-- ---------------------------------------------------------------- restricted: every contact recommendation is rejected
-- Behaviour, independent of wording: no contact-recommending output is accepted, for any reason.
select tests.ok(pg_temp.p(:'ar', :'green_r'::jsonb, 'COMPLETE', 'GREEN', 'Synthetic pitch.') <> ''
            and pg_temp.p(:'ar', :'green_r'::jsonb, 'COMPLETE', 'YELLOW', 'Synthetic pitch.') <> ''
            and pg_temp.p(:'ar', pg_temp.na(:'green_r'::jsonb, 'PURSUE', 'ASK_DIAGNOSTIC_QUESTION', 'Are you still interested?'), 'COMPLETE', 'YELLOW', null) <> ''
            and pg_temp.p(:'ar', pg_temp.na(:'red_r'::jsonb, 'UNKNOWN', 'ASK_DIAGNOSTIC_QUESTION', 'Ask whether they still want it.'), 'COMPLETE', null, null) <> ''
            and pg_temp.p(:'ar', pg_temp.na(:'red_r'::jsonb, 'UNKNOWN', 'WAIT', 'Wait a week.'), 'COMPLETE', null, null) <> ''
            and pg_temp.p(:'ar', pg_temp.insufficient('UNKNOWN', 'ASK_DIAGNOSTIC_QUESTION'), 'INSUFFICIENT_EVIDENCE', null, null) <> ''
            and pg_temp.p(:'ar', pg_temp.insufficient('UNKNOWN', 'WAIT'), 'INSUFFICIENT_EVIDENCE', null, null) <> '',
  'no PURSUE, UNKNOWN, diagnostic-question or WAIT output is accepted under the restriction');
select pg_temp.p(:'ar', :'green_r'::jsonb, 'COMPLETE', 'GREEN', 'Synthetic pitch.') as x \gset
select tests.ok(pg_temp.has(:'x', 'an active contact restriction in the evidence snapshot requires DO_NOT_PURSUE'), 'GREEN / PURSUE is rejected: DO_NOT_PURSUE required');
select tests.ok(pg_temp.has(:'x', 'an active contact restriction in the evidence snapshot requires classification RED'), '... classification RED required');
select tests.ok(pg_temp.has(:'x', 'an active contact restriction in the evidence snapshot requires STOP_CONTACT as the next action'), '... STOP_CONTACT required');
select tests.ok(pg_temp.has(:'x', 'an active contact restriction in the evidence snapshot allows no proposed message'), '... no proposed message allowed');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', :'green_r'::jsonb, 'COMPLETE', 'YELLOW', 'Synthetic pitch.'), 'requires classification RED'), 'YELLOW / PURSUE is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', pg_temp.na(:'green_r'::jsonb, 'PURSUE', 'ASK_DIAGNOSTIC_QUESTION', 'Are you still interested?'), 'COMPLETE', 'YELLOW', null),
  'requires DO_NOT_PURSUE'), 'PURSUE through a diagnostic question (no message) is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', pg_temp.na(:'red_r'::jsonb, 'UNKNOWN', 'ASK_DIAGNOSTIC_QUESTION', 'Ask whether they still want it.'), 'COMPLETE', null, null),
  'requires DO_NOT_PURSUE'), 'UNKNOWN with a diagnostic question is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', pg_temp.na(:'red_r'::jsonb, 'UNKNOWN', 'WAIT', 'Wait a week.'), 'COMPLETE', null, null),
  'requires classification RED'), 'UNKNOWN / WAIT without a classification is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', :'red_r'::jsonb, 'COMPLETE', 'YELLOW', null), 'requires classification RED'), 'DO_NOT_PURSUE with YELLOW is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', :'red_r'::jsonb, 'COMPLETE', 'RED', 'Just checking in!'), 'allows no proposed message'), 'RED with a proposed message is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', pg_temp.na(:'red_r'::jsonb, 'DO_NOT_PURSUE', 'WAIT', 'Wait.'), 'COMPLETE', 'RED', null),
  'requires STOP_CONTACT'), 'DO_NOT_PURSUE with WAIT instead of STOP_CONTACT is rejected');
-- The model cannot talk its way out: an output that "forgets" the restriction is still judged by the snapshot.
select tests.ok((:'green_r'::jsonb -> 'contact_restrictions') = '[]'::jsonb and pg_temp.p(:'ar', :'green_r'::jsonb, 'COMPLETE', 'GREEN', 'Synthetic pitch.') <> '',
  'an output that reports no restriction is still rejected (the snapshot decides, not the model)');

-- ---------------------------------------------------------------- restricted: what is accepted
select tests.is(pg_temp.p(:'ar', :'red_r'::jsonb, 'COMPLETE', 'RED', null), '', 'DO_NOT_PURSUE / RED / STOP_CONTACT / no message is accepted');
select tests.is(pg_temp.p(:'ar', :'red_r'::jsonb || '{"reasons_not_to_pursue": []}'::jsonb, 'COMPLETE', 'RED', null), '',
  '... even with no reason of its own: the snapshot restriction is the reason');
select tests.is(pg_temp.p(:'ar', pg_temp.insufficient('DO_NOT_PURSUE', 'STOP_CONTACT'), 'INSUFFICIENT_EVIDENCE', 'RED', null), '',
  'INSUFFICIENT_EVIDENCE under a restriction: DO_NOT_PURSUE / RED / STOP_CONTACT is accepted');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', pg_temp.insufficient('UNKNOWN', 'ASK_DIAGNOSTIC_QUESTION'), 'INSUFFICIENT_EVIDENCE', null, null), 'requires DO_NOT_PURSUE'),
  'INSUFFICIENT_EVIDENCE under a restriction: a diagnostic question to the prospect is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'ar', pg_temp.insufficient('DO_NOT_PURSUE', 'STOP_CONTACT'), 'INSUFFICIENT_EVIDENCE', null, null), 'requires classification RED'),
  'INSUFFICIENT_EVIDENCE under a restriction: no classification is rejected (RED required)');
select tests.ok(pg_temp.has(pg_temp.p(:'au', pg_temp.insufficient('UNKNOWN', 'WAIT'), 'INSUFFICIENT_EVIDENCE', 'RED', null), 'INSUFFICIENT_EVIDENCE carries no hypotheses, classification'),
  'without a restriction INSUFFICIENT_EVIDENCE still carries no classification (unchanged)');

-- ---------------------------------------------------------------- which snapshot entries count (fail closed)
select evidence_manifest as mu from public.analyses where id = :'au' \gset
select tests.is(pg_temp.pm(:'au', :'mu'::jsonb || '{"restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "EXPLICIT_OPT_OUT", "source": "AI_DETECTED", "status": "DISMISSED_AS_MISREAD"}]}',
  :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.'), '', 'a restriction dismissed as misread does not block (no over-blocking)');
select tests.ok(pg_temp.has(pg_temp.pm(:'au', :'mu'::jsonb || '{"restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "EXPLICIT_OPT_OUT", "source": "CLIENT", "status": "ACTIVE"}]}',
  :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.'), 'requires DO_NOT_PURSUE'), 'a client-recorded active opt-out blocks');
select tests.ok(pg_temp.has(pg_temp.pm(:'au', :'mu'::jsonb || '{"restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "OTHER", "source": "AI_DETECTED", "status": "DISMISSED_AS_MISREAD"}, {"id": "00000000-0000-4000-8000-000000000002", "kind": "OTHER", "source": "FOUNDER", "status": "ACTIVE"}]}',
  :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.'), 'requires DO_NOT_PURSUE'), 'one active entry among dismissed ones blocks');
select tests.ok(pg_temp.has(pg_temp.pm(:'au', :'mu'::jsonb || '{"restrictions": [{"id": "00000000-0000-4000-8000-000000000001", "kind": "OTHER"}]}',
  :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.'), 'requires DO_NOT_PURSUE'), 'an entry without a status counts as active (fail closed)');
select tests.ok(pg_temp.has(pg_temp.pm(:'au', :'mu'::jsonb || '{"restrictions": [{"status": "active"}]}', :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.'), 'requires DO_NOT_PURSUE')
            and pg_temp.has(pg_temp.pm(:'au', :'mu'::jsonb || '{"restrictions": ["stop"]}', :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.'), 'requires DO_NOT_PURSUE'),
  'an unrecognised status or a malformed entry counts as active (fail closed)');
select tests.ok(pg_temp.has(pg_temp.pm(:'au', :'mu'::jsonb - 'restrictions', :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.'), 'the evidence snapshot has no restriction list'),
  'a snapshot without a restriction list is rejected');
select tests.ok(pg_temp.has(pg_temp.pm(:'au', :'mu'::jsonb || '{"restrictions": {"status": "DISMISSED_AS_MISREAD"}}', :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.'), 'the evidence snapshot has no restriction list')
            and pg_temp.pm(:'au', :'mu'::jsonb - 'restrictions', :'red_r'::jsonb, 'RED', null) <> '',
  'a restriction list that is not a list is rejected, and nothing passes without one');

-- ---------------------------------------------------------------- end to end on the restricted case
-- A model output recommending contact is stored as ERROR: no findings, no message, no classification.
select tests.as_service();
select public.internal_complete_analysis(:'ar', 'COMPLETE', 'synthetic-model', 'v1', :'green_r'::jsonb, 'GREEN', 'Synthetic pitch.', '[]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and error like 'REJECTED by analysis contract rre-analysis/1: %active contact restriction in the evidence snapshot requires DO_NOT_PURSUE%'
                        and output is null and ai_classification is null and ai_proposed_message is null from public.analyses where id = :'ar'),
  'end to end: GREEN on a restricted case is stored as ERROR with no findings, classification or message');
select tests.is((select workflow_state::text from public.cases where id = :'r'), 'SUBMITTED', 'the case returns to its prior state');
select tests.ok((select status = 'ACTIVE' from public.contact_restrictions where id = :'rr'), 'the restriction stays active');
select tests.ok(exists (select 1 from public.audit_log where action = 'ANALYSIS_REJECTED' and case_id = :'r' and client_label is null), 'the rejection is audited, never shown to the client');
select tests.is(tests.count(format('select 1 from public.approvals where case_id = %L union all select 1 from public.client_recommendations where case_id = %L', :'r', :'r')),
  0::bigint, 'nothing is approved or published');
-- End to end, a "just ask a question" analysis (no classification, no message) is rejected too.
select tests.login(tests.founder());
select public.founder_start_analysis(:'r') as arq \gset
select tests.as_service();
select public.internal_complete_analysis(:'arq', 'COMPLETE', 'synthetic-model', 'v1',
  pg_temp.na(tests.contract_output(:'arq', null, null), 'UNKNOWN', 'ASK_DIAGNOSTIC_QUESTION', 'Ask whether they still want it.'), null, null, '[]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and output is null from public.analyses where id = :'arq'),
  'end to end: UNKNOWN with a diagnostic question to the prospect is stored as ERROR');
-- A RED, stop-contact analysis is accepted.
select tests.login(tests.founder());
select public.founder_start_analysis(:'r') as ar2 \gset
select tests.as_service();
select public.internal_complete_analysis(:'ar2', 'COMPLETE', 'synthetic-model', 'v1', tests.contract_output(:'ar2', 'RED', null), 'RED', null, '[]');
select tests.as_owner();
select tests.ok((select status = 'COMPLETE' and ai_classification = 'RED' and ai_proposed_message is null
                        and output -> 'recommendation' ->> 'pursue' = 'DO_NOT_PURSUE' and output -> 'recommendation' -> 'next_action' ->> 'type' = 'STOP_CONTACT'
                 from public.analyses where id = :'ar2'), 'end to end: DO_NOT_PURSUE / RED / STOP_CONTACT is stored, with no message');
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, %s, %L, %L, %L, %L, %L)', :'r', :'ar2',
  (select evidence_version from public.cases where id = :'r'), 'GREEN', 's', 'n', 'Synthetic pitch.', 'EDITED'),
  '^CONTACT_RESTRICTED', 'the founder still cannot approve contact (unchanged)');

-- A restriction added while an analysis runs makes it stale (unchanged 2A-5b behaviour).
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'RC-3', 'Synthetic product', 'Referral', 'TEXT', 'Prospect: Is it still available? Business: Yes.') as s \gset
select public.client_submit_case(:'s');
select tests.login(tests.founder());
select public.founder_start_analysis(:'s') as as1 \gset
select public.founder_add_restriction(:'s', 'EXPLICIT_OPT_OUT', 'Synthetic: opted out during analysis.');
select tests.as_service();
select public.internal_complete_analysis(:'as1', 'COMPLETE', 'synthetic-model', 'v1', tests.contract_output(:'as1', 'GREEN', 'Synthetic pitch.'), 'GREEN', 'Synthetic pitch.', '[]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and error like 'STALE%' and ai_proposed_message is null from public.analyses where id = :'as1'),
  'a restriction recorded during the analysis makes it stale');

-- Defence in depth: an active restriction on the case that is not in the snapshot (written
-- without bumping the evidence version) also blocks.
insert into public.contact_restrictions (case_id, business_id, kind, source, note) values (:'u', tests.biz_a(), 'OTHER', 'FOUNDER', 'Synthetic direct insert.');
select tests.ok(pg_temp.has(pg_temp.p(:'au', :'green_u'::jsonb, 'COMPLETE', 'GREEN', 'Synthetic pitch.'), 'requires DO_NOT_PURSUE'),
  'an active restriction recorded on the case after the snapshot also blocks contact');
select tests.as_service();
select public.internal_complete_analysis(:'au', 'COMPLETE', 'synthetic-model', 'v1', :'green_u'::jsonb, 'GREEN', 'Synthetic pitch.', '[]');
select tests.as_owner();
select tests.is((select status::text from public.analyses where id = :'au'), 'ERROR', '... and end to end it is not accepted');

-- Invariant over everything accepted in this test: no accepted analysis whose snapshot lists an
-- active restriction carries anything but RED / DO_NOT_PURSUE / STOP_CONTACT / no message.
select tests.ok(not exists (
  select 1 from public.analyses a
  where a.status in ('COMPLETE', 'INSUFFICIENT_EVIDENCE')
    and exists (select 1 from jsonb_array_elements(a.evidence_manifest -> 'restrictions') e where e ->> 'status' = 'ACTIVE')
    and (a.ai_classification is distinct from 'RED' or a.ai_proposed_message is not null
         or a.output -> 'recommendation' ->> 'pursue' is distinct from 'DO_NOT_PURSUE'
         or a.output -> 'recommendation' -> 'next_action' ->> 'type' is distinct from 'STOP_CONTACT'))
  and (select count(*) > 0 from public.analyses a where a.status = 'COMPLETE'
       and exists (select 1 from jsonb_array_elements(a.evidence_manifest -> 'restrictions') e where e ->> 'status' = 'ACTIVE')),
  'invariant: no accepted analysis of a restricted snapshot recommends contact (and one was accepted)');

-- ---------------------------------------------------------------- founder-only, unchanged
select tests.login(tests.client_a());
select tests.is(tests.count('select 1 from public.analyses') + tests.count('select 1 from public.contact_restrictions'), 0::bigint,
  'the business user reads no analysis and no restriction');
select tests.ok(public.client_get_case(:'r')::text !~* '(REJECTED|contact restriction|PROHIBITED_CONTACT|Synthetic pitch|DO_NOT_PURSUE|STOP_CONTACT)',
  'the case detail leaks nothing about the rejection, the restriction or the analysis');
select tests.is((select status from public.client_list_cases() where id = :'r'), 'UNDER_REVIEW', 'the client sees only Under review');
select tests.throws(format('select private.analysis_output_problems(a, %L, %L, null, null, %L) from public.analyses a limit 1', 'COMPLETE', '{}', '[]'),
  'permission denied', 'the business user cannot call the contract');
select tests.login(tests.client_b());
select tests.throws(format('select public.client_get_case(%L)', :'r'), '^NOT_FOUND', 'another business cannot see the case');
select tests.as_owner();
select tests.ok((select prosecdef and proconfig @> array['search_path=""']
                        and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                        and not has_function_privilege('service_role', p.oid, 'EXECUTE')
                 from pg_proc p where p.oid = 'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'::regprocedure),
  'the contract function is still SECURITY DEFINER, pins search_path, and is callable by no API role');
rollback;

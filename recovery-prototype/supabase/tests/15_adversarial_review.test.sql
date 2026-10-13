-- Stage 2A-5d-2: contract rre-analysis/2 — an independent adversarial review section
-- (adversarial_review) validated in the database: structure, targets, severity,
-- evidence references against the analysis's own evidence snapshot (no fabricated
-- citations), and a verdict that, when it rejects the recommendation, leaves no
-- contact message stored anywhere. rre-analysis/1 stays valid. Founder-only.
-- Synthetic data only; no AI.
begin;
select tests.as_owner();
select tests.seed();

-- ---------------------------------------------------------------- fixtures
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'ADV-1', 'Synthetic Corolla', 'Referral', 'TEXT',
  'Prospect: I like the car but the price feels high.' || chr(10) || 'Business: It is our best price.') as c \gset
select public.client_submit_case(:'c');
select public.client_create_case(gen_random_uuid(), 'ADV-R', 'Synthetic Corolla', 'Referral', 'TEXT',
  'Prospect: I like the car but the price feels high.' || chr(10) || 'Business: It is our best price.') as r \gset
select public.client_submit_case(:'r');
select tests.login(tests.client_b());
select public.client_create_case(gen_random_uuid(), 'ADV-B', 'Synthetic Course', 'Google', 'TEXT', 'Prospect: the price feels high for business B.') as cb \gset
select tests.as_owner();
select id as m1 from public.case_messages where case_id = :'c' and kind = 'PASTED_CONVERSATION' \gset
select id as mb from public.case_messages where case_id = :'cb' \gset
select tests.login(tests.founder());
select public.founder_add_restriction(:'r', 'EXPLICIT_OPT_OUT', 'Synthetic opt-out before analysis.');
select public.founder_start_analysis(:'c') as a \gset
select public.founder_start_analysis(:'r') as ar \gset
select tests.as_owner();
-- A message added after the analysis started is not in its evidence snapshot.
insert into public.case_messages (case_id, business_id, kind, body) values (:'c', tests.biz_a(), 'PROSPECT_RESPONSE', 'Synthetic later reply: the price feels high still.')
returning id as mlate \gset

create function pg_temp.p(p_analysis uuid, p_out jsonb, p_status public.analysis_status default 'COMPLETE',
  p_class public.classification default null, p_msg text default null) returns text language sql as $$
  select coalesce(array_to_string(private.analysis_output_problems(a, p_status, p_out, p_class, p_msg, '[]'), ' | '), '<null>')
  from public.analyses a where a.id = p_analysis
$$;
create function pg_temp.has(p_text text, p_sub text) returns boolean language sql as $$ select strpos(p_text, p_sub) > 0 $$;
create function pg_temp.ref(p_m uuid, p_quote text) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('type', 'MESSAGE', 'message_id', p_m, 'quote', p_quote))
$$;
create function pg_temp.ch(p_id text, p_target text, p_target_id text, p_sev text, p_ev jsonb default '[]') returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('id', p_id, 'target', p_target, 'target_id', p_target_id, 'severity', p_sev,
    'challenge', 'SYNTHETIC-REVIEW-MARKER: the evidence may not support this.', 'evidence', p_ev))
$$;
-- an rre-analysis/2 output: a v1 output plus a review
create function pg_temp.v2(p_out jsonb, p_verdict text, p_challenges jsonb default '[]') returns jsonb language sql as $$
  select p_out || jsonb_build_object('contract_version', 'rre-analysis/2', 'adversarial_review', jsonb_build_object(
    'challenges', p_challenges, 'verdict', p_verdict, 'verdict_rationale', 'SYNTHETIC-REVIEW-MARKER: independent verdict rationale.'))
$$;
create function pg_temp.na(p_out jsonb, p_pursue text, p_type text, p_text text) returns jsonb language sql as $$
  select jsonb_set(jsonb_set(p_out, '{recommendation,pursue}', to_jsonb(p_pursue)), '{recommendation,next_action}',
                   jsonb_build_object('type', p_type, 'text', p_text))
$$;
select tests.contract_output(:'a', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?') as g \gset
select pg_temp.na(:'g'::jsonb, 'UNKNOWN', 'WAIT', 'Wait for the prospect to reply.') as w \gset
select tests.contract_output(:'a', 'RED', null) as red \gset
select pg_temp.ch('C1', 'OBSERVATION', 'O1', 'MEDIUM', pg_temp.ref(:'m1', 'the price feels high')) as c_obs \gset
select pg_temp.ch('C2', 'HYPOTHESIS', 'H1', 'LOW', pg_temp.ref(:'m1', 'It is our best price')) as c_hyp \gset
select pg_temp.ch('C3', 'RECOMMENDATION', null, 'HIGH') as c_rec_high \gset

-- ---------------------------------------------------------------- compatibility: rre-analysis/1 unchanged
select tests.is(pg_temp.p(:'a', :'g'::jsonb, 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'), '', 'rre-analysis/1 (no review) is still accepted');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'g'::jsonb || jsonb_build_object('adversarial_review', '{}'::jsonb), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'),
  'unexpected keys adversarial_review'), 'rre-analysis/1 cannot carry a review (it would be unvalidated)');

-- ---------------------------------------------------------------- rre-analysis/2: accepted
select tests.is(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD'), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'), '', 'v2: UPHOLD with no challenges');
select tests.is(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(:'c_obs'::jsonb, :'c_hyp'::jsonb)), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'),
  '', 'v2: challenges to an observation and a hypothesis, citing verified quotes');
select tests.is(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'RECOMMENDATION', null, 'MEDIUM'),
    jsonb_set(pg_temp.ch('C2', 'RECOMMENDATION', null, 'LOW'), '{target_id}', 'null'))), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'),
  '', 'v2: challenges to the recommendation (target_id absent or null), with no evidence');
select tests.is(pg_temp.p(:'a', pg_temp.v2(:'w'::jsonb, 'REJECT_RECOMMENDATION', jsonb_build_array(:'c_rec_high'::jsonb)), 'COMPLETE', null, null),
  '', 'v2: REJECT_RECOMMENDATION with WAIT and no message');
select tests.is(pg_temp.p(:'a', pg_temp.v2(:'red'::jsonb, 'REJECT_RECOMMENDATION', jsonb_build_array(:'c_rec_high'::jsonb)), 'COMPLETE', 'RED', null),
  '', 'v2: REJECT_RECOMMENDATION with DO_NOT_PURSUE / RED / STOP_CONTACT');
select tests.is(pg_temp.p(:'a', pg_temp.v2('{"contract_version": "rre-analysis/1",
    "evidence_assessment": {"sufficiency": "INSUFFICIENT", "summary": "Too little.", "missing_evidence": ["The rest"]},
    "observations": [], "hypotheses": [], "unknowns": [{"question": "What next?", "why_it_matters": "Otherwise invented."}],
    "recommendation": {"pursue": "UNKNOWN", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [],
                       "next_action": {"type": "WAIT", "text": "Wait for more evidence."}},
    "contact_restrictions": [], "reasons_not_to_pursue": []}'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'RECOMMENDATION', null, 'MEDIUM'))),
  'INSUFFICIENT_EVIDENCE', null, null), '', 'v2: INSUFFICIENT_EVIDENCE with a review');

-- ---------------------------------------------------------------- structure
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'g'::jsonb, '{contract_version}', '"rre-analysis/2"'), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'),
  'missing adversarial_review'), 'v2 without a review is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(pg_temp.v2(:'g'::jsonb, 'UPHOLD'), '{adversarial_review}', '"looks fine"')), 'adversarial_review must be an object'), 'a review that is not an object');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(pg_temp.v2(:'g'::jsonb, 'UPHOLD'), '{adversarial_review,verdict}', '"APPROVE"')), 'verdict must be'), 'an unknown verdict');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD') #- '{adversarial_review,verdict}'), 'verdict must be'), 'a missing verdict');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(pg_temp.v2(:'g'::jsonb, 'UPHOLD'), '{adversarial_review,verdict_rationale}', '"  "')), 'verdict_rationale is required'), 'a blank rationale');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD') #- '{adversarial_review,challenges}'), 'challenges must be a list'), 'missing challenges');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS',
    (select jsonb_agg(pg_temp.ch('C' || i, 'RECOMMENDATION', null, 'LOW')) from generate_series(1, 31) i))), 'at most 30'), 'more than 30 challenges');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(pg_temp.v2(:'g'::jsonb, 'UPHOLD'), '{adversarial_review,secret_score}', '9')), 'adversarial_review: unexpected keys secret_score'), 'unknown review keys');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(:'c_obs'::jsonb, :'c_obs'::jsonb))), 'must be unique'), 'duplicate challenge ids');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('X1', 'RECOMMENDATION', null, 'LOW')))), 'look like C1'), 'malformed challenge id');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', '["just a string"]')), 'challenges[0] must be an object'), 'a challenge that is not an object');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'PERSONALITY', null, 'LOW')))), 'target must be'), 'an unknown target');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O9', 'LOW')))), 'must name an existing observation'), 'a challenge to an observation that does not exist');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'H1', 'LOW')))), 'must name an existing observation'), 'a hypothesis id used as an observation');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'HYPOTHESIS', 'H7', 'LOW')))), 'must name an existing hypothesis'), 'a challenge to a hypothesis that does not exist');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'HYPOTHESIS', null, 'LOW')))), 'must name an existing hypothesis'), 'a challenge to a hypothesis without its id');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'RECOMMENDATION', 'O1', 'LOW')))), 'has no target_id'), 'a recommendation challenge naming a target id');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'RECOMMENDATION', null, 'CRITICAL')))), 'severity must be'), 'an unknown severity');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(jsonb_set(pg_temp.ch('C1', 'RECOMMENDATION', null, 'LOW'), '{challenge}', '""')))), 'challenge is required'), 'an empty challenge');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'RECOMMENDATION', null, 'LOW') - 'evidence'))), 'evidence: must be a list'), 'a challenge without an evidence list');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'RECOMMENDATION', null, 'LOW') || '{"html": "<script>"}'))), 'unexpected keys html'), 'unknown challenge keys');

-- ---------------------------------------------------------------- fabricated citations are rejected
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'HIGH', pg_temp.ref(:'m1', 'I will never buy this car'))))),
  'quote does not appear in the cited message'), 'a quote that is not in the message');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'LOW', pg_temp.ref(gen_random_uuid(), 'the price feels high'))))),
  'message is not part of this analysis''s evidence'), 'a message id that does not exist');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'LOW', pg_temp.ref(:'mb', 'the price feels high'))))),
  'message is not part of this analysis''s evidence'), 'a real message of ANOTHER business (with a matching quote) cannot be cited');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'LOW', pg_temp.ref(:'mlate', 'the price feels high'))))),
  'message is not part of this analysis''s evidence'), 'a message of the same case added after the snapshot cannot be cited');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'LOW', '[{"type": "SCREENSHOT", "position": 2}]')))),
  'screenshot is not part of this analysis''s evidence'), 'a screenshot that is not in the snapshot');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'LOW', '[{"type": "URL", "url": "https://example.test"}]')))),
  'evidence type must be MESSAGE or SCREENSHOT'), 'an outside source');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'LOW',
    (select jsonb_agg(e) from (select jsonb_array_elements(pg_temp.ref(:'m1', 'the price feels high')) e from generate_series(1, 11)) x))))), 'must be a list of 0-10'),
  'more than 10 references');
-- A screenshot deleted under retention after the snapshot cannot be cited by the review.
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'ADV-S', 'Synthetic Hilux', 'Referral', 'SCREENSHOTS') as s \gset
select tests.as_owner();
insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
select :'s', tests.biz_a(), p, format('%s/%s/%s-%s.png', tests.biz_a(), :'s', p, repeat(p::text, 64)), 'image/png', 1000, repeat(p::text, 64), tests.client_a()
from generate_series(1, 2) p;
update public.cases set workflow_state = 'SUBMITTED', evidence_version = 1 where id = :'s';
select tests.login(tests.founder());
select public.founder_start_analysis(:'s') as sa \gset
select tests.as_owner();
update public.case_screenshots set file_deleted_at = now() where case_id = :'s' and position = 2;
create function pg_temp.shot_v2(p_pos int) returns jsonb language sql as $$
  select pg_temp.v2(jsonb_build_object('contract_version', 'rre-analysis/1',
    'evidence_assessment', '{"sufficiency": "SUFFICIENT", "summary": "Screenshots.", "missing_evidence": []}'::jsonb,
    'observations', '[{"id": "O1", "actor": "PROSPECT", "behavior": "Asked about delivery.", "evidence": [{"type": "SCREENSHOT", "position": 1}]}]'::jsonb,
    'hypotheses', '[]'::jsonb, 'unknowns', '[]'::jsonb,
    'recommendation', '{"pursue": "UNKNOWN", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [],
                        "next_action": {"type": "WAIT", "text": "Wait."}}'::jsonb,
    'contact_restrictions', '[]'::jsonb, 'reasons_not_to_pursue', '[]'::jsonb),
    'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'MEDIUM', jsonb_build_array(jsonb_build_object('type', 'SCREENSHOT', 'position', p_pos)))))
$$;
select tests.is(pg_temp.p(:'sa', pg_temp.shot_v2(1)), '', 'the review can cite a stored screenshot of the snapshot');
select tests.ok(pg_temp.has(pg_temp.p(:'sa', pg_temp.shot_v2(2)), 'screenshot was deleted or changed and cannot be cited'), 'the review cannot cite a screenshot deleted under retention');

-- ---------------------------------------------------------------- verdict rules
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD', jsonb_build_array(:'c_rec_high'::jsonb)), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'),
  'UPHOLD is impossible with a HIGH-severity challenge'), 'UPHOLD despite a HIGH challenge is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS'), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'),
  'UPHOLD_WITH_CONCERNS needs at least one challenge'), 'concerns without a challenge are rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'w'::jsonb, 'REJECT_RECOMMENDATION', jsonb_build_array(:'c_obs'::jsonb))),
  'REJECT_RECOMMENDATION needs at least one HIGH-severity challenge'), 'a rejection without a HIGH challenge is rejected');
-- A rejected recommendation leaves no contact message anywhere.
select pg_temp.p(:'a', pg_temp.v2(:'g'::jsonb, 'REJECT_RECOMMENDATION', jsonb_build_array(:'c_rec_high'::jsonb)), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?') as x \gset
select tests.ok(pg_temp.has(:'x', 'cannot remain PURSUE') and pg_temp.has(:'x', 'cannot carry a message or question to the prospect')
                and pg_temp.has(:'x', 'rejected by the adversarial review allows no proposed message'),
  'REJECT_RECOMMENDATION with PURSUE / SEND_MESSAGE / a proposed message is rejected on every count');
select tests.ok(pg_temp.p(:'a', pg_temp.v2(pg_temp.na(:'g'::jsonb, 'UNKNOWN', 'ASK_DIAGNOSTIC_QUESTION', 'SYNTHETIC-PITCH: still interested?'), 'REJECT_RECOMMENDATION',
    jsonb_build_array(:'c_rec_high'::jsonb)), 'COMPLETE', null, null) <> '', 'REJECT_RECOMMENDATION with a question to the prospect is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.v2(:'w'::jsonb, 'REJECT_RECOMMENDATION', jsonb_build_array(:'c_rec_high'::jsonb)), 'COMPLETE', null, 'SYNTHETIC-PITCH: hello?'),
  'allows no proposed message'), 'REJECT_RECOMMENDATION with a proposed message passed separately is rejected');

-- ---------------------------------------------------------------- the Stage 2A-5d-1 restriction rule still holds for v2
select tests.contract_output(:'ar', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?') as gr \gset
select tests.ok(pg_temp.has(pg_temp.p(:'ar', pg_temp.v2(:'gr'::jsonb, 'UPHOLD'), 'COMPLETE', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'),
  'an active contact restriction in the evidence snapshot requires DO_NOT_PURSUE'), 'a review that upholds contact cannot override an active restriction');
select tests.is(pg_temp.p(:'ar', pg_temp.v2(tests.contract_output(:'ar', 'RED', null), 'REJECT_RECOMMENDATION', jsonb_build_array(:'c_rec_high'::jsonb)), 'COMPLETE', 'RED', null),
  '', 'restricted: DO_NOT_PURSUE / RED with a rejecting review is accepted');

-- ---------------------------------------------------------------- end to end through internal_complete_analysis
-- A fabricated citation in the review discards the whole analysis.
select tests.as_service();
select public.internal_complete_analysis(:'a', 'COMPLETE', 'synthetic-model', 'v2',
  pg_temp.v2(:'g'::jsonb, 'UPHOLD_WITH_CONCERNS', jsonb_build_array(pg_temp.ch('C1', 'OBSERVATION', 'O1', 'LOW', pg_temp.ref(:'m1', 'I will pay cash today')))),
  'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?', '[]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and error like 'REJECTED by analysis contract%adversarial_review.challenges[0].evidence[0]: quote does not appear%'
                        and output is null and ai_classification is null and ai_proposed_message is null from public.analyses where id = :'a'),
  'end to end: a fabricated review citation is stored as ERROR, with nothing kept');
select tests.is((select workflow_state::text from public.cases where id = :'c'), 'SUBMITTED', 'the case returns to its prior state');
-- A rejecting review with a draft message: ERROR, nothing kept.
select tests.login(tests.founder());
select public.founder_start_analysis(:'c') as a2 \gset
select tests.as_service();
select public.internal_complete_analysis(:'a2', 'COMPLETE', 'synthetic-model', 'v2',
  pg_temp.v2(tests.contract_output(:'a2', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'), 'REJECT_RECOMMENDATION', jsonb_build_array(:'c_rec_high'::jsonb)),
  'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?', '[]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and output is null and ai_proposed_message is null from public.analyses where id = :'a2'),
  'end to end: a rejected recommendation that still carries a message is not stored');
-- A rejecting review with WAIT: stored, with no message in any column or in the output.
select tests.login(tests.founder());
select public.founder_start_analysis(:'c') as a3 \gset
select tests.as_service();
select public.internal_complete_analysis(:'a3', 'COMPLETE', 'synthetic-model', 'v2',
  pg_temp.v2(pg_temp.na(tests.contract_output(:'a3', 'GREEN', 'SYNTHETIC-PITCH: viewing on Saturday?'), 'UNKNOWN', 'WAIT', 'Wait for the prospect to reply.'),
             'REJECT_RECOMMENDATION', jsonb_build_array(:'c_obs'::jsonb, :'c_rec_high'::jsonb)), null, null, '[]');
select tests.as_owner();
select tests.ok((select status = 'COMPLETE' and ai_proposed_message is null and ai_classification is null
                        and output ->> 'contract_version' = 'rre-analysis/2' and output -> 'adversarial_review' ->> 'verdict' = 'REJECT_RECOMMENDATION'
                        and output::text not like '%SYNTHETIC-PITCH%'
                        and output -> 'recommendation' -> 'next_action' ->> 'type' = 'WAIT'
                 from public.analyses where id = :'a3'), 'end to end: a rejected recommendation is stored with no contact message anywhere');
select tests.is((select workflow_state::text from public.cases where id = :'c'), 'AWAITING_ADMIN_REVIEW', 'and it waits for the founder');
-- Invariant over everything stored: no accepted analysis with a rejecting review carries a contact message.
select tests.ok(not exists (select 1 from public.analyses where status in ('COMPLETE', 'INSUFFICIENT_EVIDENCE')
                            and output -> 'adversarial_review' ->> 'verdict' = 'REJECT_RECOMMENDATION'
                            and (ai_proposed_message is not null or output -> 'recommendation' ->> 'pursue' = 'PURSUE'
                                 or output -> 'recommendation' -> 'next_action' ->> 'type' in ('SEND_MESSAGE', 'ASK_DIAGNOSTIC_QUESTION')))
            and exists (select 1 from public.analyses where output -> 'adversarial_review' ->> 'verdict' = 'REJECT_RECOMMENDATION'),
  'invariant: no stored analysis with a rejecting review carries a contact message (and one was stored)');

-- ---------------------------------------------------------------- founder-only: tables, RPCs, APIs
select tests.login(tests.founder());
select tests.is((select output -> 'adversarial_review' -> 'challenges' -> 1 ->> 'severity' from public.analyses where id = :'a3'), 'HIGH', 'the founder reads the review');
select tests.login(tests.client_a());
select tests.is(tests.count('select 1 from public.analyses'), 0::bigint, 'the business user of the case reads no analysis (and so no review)');
select tests.is(tests.count($q$select 1 from public.analyses where output ? 'adversarial_review'$q$), 0::bigint, '... not even by filtering for reviews');
select tests.ok(public.client_get_case(:'c')::text !~* '(SYNTHETIC-REVIEW-MARKER|adversarial|verdict|REJECT_RECOMMENDATION|challenge)',
  'client_get_case carries nothing from the review');
select tests.ok(not exists (select 1 from public.client_list_cases() l where l::text ~* '(SYNTHETIC-REVIEW-MARKER|adversarial|verdict)'), 'client_list_cases carries nothing from the review');
select tests.is((select status from public.client_list_cases() where id = :'c'), 'UNDER_REVIEW', 'the client sees only Under review');
select tests.throws(format('select private.analysis_output_problems(a, %L, %L, null, null, %L) from public.analyses a limit 1', 'COMPLETE', '{}', '[]'),
  'permission denied', 'the business user cannot call the contract');
select tests.login(tests.client_a2());
select tests.is(tests.count('select 1 from public.analyses'), 0::bigint, 'another member of the same business: nothing');
select tests.login(tests.client_b());
select tests.is(tests.count('select 1 from public.analyses'), 0::bigint, 'a client of another business: nothing');
select tests.throws(format('select public.client_get_case(%L)', :'c'), '^NOT_FOUND', '... and cannot open the case');
select tests.login(tests.unassigned());
select tests.is(tests.count('select 1 from public.analyses'), 0::bigint, 'a signed-in user with no business: nothing');
select tests.as_anon();
select tests.throws('select count(*) from public.analyses', 'permission denied', 'anonymous: permission denied');
-- Structural: no API path reads analyses except through RLS (founder-only) or founder-gated functions.
select tests.as_owner();
select tests.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc ~ 'public\.analyses'
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or (has_function_privilege('authenticated', p.oid, 'EXECUTE')
             and p.prosrc !~ '(private\.require_founder\(\)|private\.founder_case_for_update\()')))
  and (select count(*) >= 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc ~ 'public\.analyses' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  'every API function that touches analyses is founder-gated (or not callable by clients); the check sees the founder functions');
select tests.ok(not exists (select 1 from pg_views where schemaname not in ('pg_catalog', 'information_schema') and definition ~* '\manalyses\M')
            and not exists (select 1 from pg_matviews where definition ~* '\manalyses\M'),
  'no view exposes analyses');
select tests.ok((select count(*) = 1 and bool_and(cmd = 'SELECT' and qual like '%is_founder%' and qual not like '%is_member%')
                 from pg_policies where schemaname = 'public' and tablename = 'analyses'), 'analyses: one SELECT policy, founder only (unchanged)');
select tests.ok((select prosecdef and proconfig @> array['search_path=""']
                        and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                        and not has_function_privilege('service_role', p.oid, 'EXECUTE')
                 from pg_proc p where p.oid = 'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'::regprocedure),
  'the contract is still SECURITY DEFINER, pins search_path, and is callable by no API role');
rollback;

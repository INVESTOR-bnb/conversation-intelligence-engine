-- Stage 2A-5a: analysis output contract rre-analysis/1 (private.analysis_output_problems,
-- enforced by public.internal_complete_analysis). Synthetic conversations only; no AI.
begin;
select tests.as_owner();
select tests.seed();

-- ---------------------------------------------------------------- fixtures
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'PSY-1', 'Synthetic Corolla', 'Referral', 'TEXT',
  'Prospect: I like the car but the price feels high.' || chr(10) || 'Business: It is our best price.' || chr(10) || 'Prospect: My wife has to agree first.') as c \gset
select public.client_submit_case(:'c');
select tests.login(tests.client_b());
select public.client_create_case(gen_random_uuid(), 'OTHER-1', 'Synthetic Course', 'Google', 'TEXT', 'Prospect: Is the course online? Business: Yes, synthetic.') as cb \gset
select tests.as_owner();
select id as m1 from public.case_messages where case_id = :'c' and kind = 'PASTED_CONVERSATION' \gset
select id as mb from public.case_messages where case_id = :'cb' \gset
-- A later prospect reply and a sent recovery message (fixture rows; the real flow is covered in 04).
insert into public.case_messages (case_id, business_id, kind, body) values (:'c', tests.biz_a(), 'PROSPECT_RESPONSE', 'Can I see it on Saturday morning?') returning id as m2 \gset
insert into public.case_messages (case_id, business_id, kind, body, attempt, approval_id, sent_exactly)
values (:'c', tests.biz_a(), 'RECOVERY_SENT', 'Hello, just checking in about the car.', 1, gen_random_uuid(), true) returning id as m3 \gset
select tests.login(tests.founder());
select public.founder_start_analysis(:'c') as a \gset
select tests.as_owner();

-- A rich, valid output for case :c (the base every mutation starts from).
create function pg_temp.base(p_m1 uuid, p_m2 uuid) returns jsonb language sql as $$
  select replace(replace($j${
  "contract_version": "rre-analysis/1",
  "evidence_assessment": {"sufficiency": "PARTIAL", "summary": "Pasted conversation and one later reply; nothing from the spouse.", "missing_evidence": ["The spouse's view"]},
  "observations": [
    {"id": "O1", "actor": "PROSPECT", "behavior": "Said the price feels high.", "evidence": [{"type": "MESSAGE", "message_id": "__M1__", "quote": "the price feels high"}]},
    {"id": "O2", "actor": "PROSPECT", "behavior": "Said the spouse has to agree first.", "evidence": [{"type": "MESSAGE", "message_id": "__M1__", "quote": "My wife has to   agree first"}]},
    {"id": "O3", "actor": "SELLER", "behavior": "Answered the price concern with a flat statement.", "evidence": [{"type": "MESSAGE", "message_id": "__M1__", "quote": "It is our best price"}]},
    {"id": "O4", "actor": "PROSPECT", "behavior": "Later asked to view the car on Saturday.", "evidence": [{"type": "MESSAGE", "message_id": "__M2__", "quote": "Can I see it on Saturday"}]}
  ],
  "hypotheses": [
    {"id": "H1", "category": "TRUST_AND_RISK", "statement": "The price is perceived as too high for the value seen so far.", "basis": "STATED_BY_PROSPECT",
     "supporting_observations": ["O1"], "contradicting_observations": [], "competing_hypotheses": ["H3"], "confidence": "HIGH", "uncertainty": "The prospect did not say what price would work."},
    {"id": "H2", "category": "DECISION_FRICTION", "statement": "The decision depends on the spouse.", "basis": "STATED_BY_PROSPECT",
     "supporting_observations": ["O2"], "contradicting_observations": [], "competing_hypotheses": [], "confidence": "MEDIUM", "uncertainty": "It may also be a polite way to delay."},
    {"id": "H3", "category": "EMOTIONAL_BARRIER", "statement": "Fear of making an expensive mistake.", "basis": "HYPOTHESIS",
     "supporting_observations": ["O1", "O2"], "contradicting_observations": ["O4"], "competing_hypotheses": ["H1", "H2"], "confidence": "LOW", "uncertainty": "Nothing in the conversation names fear directly."},
    {"id": "H4", "category": "SELLER_CREATED_RESISTANCE", "statement": "The flat price reply closed the conversation down.", "basis": "HYPOTHESIS",
     "supporting_observations": ["O3"], "contradicting_observations": [], "competing_hypotheses": ["H3"], "confidence": "MEDIUM", "uncertainty": "Tone is hard to judge from text."},
    {"id": "H5", "category": "BUYING_MOTIVATION", "statement": "Still wants the car.", "basis": "HYPOTHESIS",
     "supporting_observations": ["O4"], "contradicting_observations": [], "competing_hypotheses": ["H3"], "confidence": "UNKNOWN", "uncertainty": "One later message only."}
  ],
  "unknowns": [{"question": "Has the spouse seen the car?", "why_it_matters": "A joint viewing may resolve the decision friction."}],
  "recommendation": {"pursue": "PURSUE", "strategy": "Invite a joint viewing and acknowledge the price concern without pressure.",
     "psychological_rationale": "Addresses the stated joint decision and lowers perceived risk.", "based_on_hypotheses": ["H1", "H2", "H4"],
     "next_action": {"type": "SEND_MESSAGE", "text": "Would Saturday at 10 suit you and your wife to see it together?"}},
  "contact_restrictions": [],
  "reasons_not_to_pursue": []
}$j$, '__M1__', p_m1::text), '__M2__', p_m2::text)::jsonb
$$;
create function pg_temp.msg() returns text language sql as $$ select 'Would Saturday at 10 suit you and your wife to see it together?' $$;
-- Problems for an output (empty string = accepted).
create function pg_temp.p(p_analysis uuid, p_out jsonb, p_status public.analysis_status default 'COMPLETE',
  p_class public.classification default 'GREEN', p_msg text default pg_temp.msg(), p_restr jsonb default '[]') returns text
language sql as $$
  select coalesce(array_to_string(private.analysis_output_problems(a, p_status, p_out, p_class, p_msg, p_restr), ' | '), '<null>')
  from public.analyses a where a.id = p_analysis
$$;
create function pg_temp.has(p_text text, p_sub text) returns boolean language sql as $$ select strpos(p_text, p_sub) > 0 $$;
-- A DO_NOT_PURSUE variant (opt-out) and an INSUFFICIENT_EVIDENCE variant of the base.
create function pg_temp.opt_out(p_m2 uuid, p_base jsonb) returns jsonb language sql as $$
  select p_base
    || jsonb_build_object('contact_restrictions', jsonb_build_array(jsonb_build_object('kind', 'EXPLICIT_OPT_OUT', 'reason', 'Synthetic: asked not to be contacted.',
         'evidence', jsonb_build_array(jsonb_build_object('type', 'MESSAGE', 'message_id', p_m2, 'quote', 'Saturday morning')))))
    || jsonb_build_object('recommendation', jsonb_build_object('pursue', 'DO_NOT_PURSUE', 'strategy', 'UNKNOWN', 'psychological_rationale', 'UNKNOWN',
         'based_on_hypotheses', '[]'::jsonb, 'next_action', jsonb_build_object('type', 'STOP_CONTACT', 'text', 'Do not contact again.')))
$$;
create function pg_temp.insufficient() returns jsonb language sql as $$
  select '{"contract_version": "rre-analysis/1",
    "evidence_assessment": {"sufficiency": "INSUFFICIENT", "summary": "Too little to analyse.", "missing_evidence": ["The rest of the conversation"]},
    "observations": [], "hypotheses": [],
    "unknowns": [{"question": "What did the prospect say after the price?", "why_it_matters": "Without it any reading would be invented."}],
    "recommendation": {"pursue": "UNKNOWN", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [],
                       "next_action": {"type": "ASK_DIAGNOSTIC_QUESTION", "text": "Ask the business for the full conversation."}},
    "contact_restrictions": [], "reasons_not_to_pursue": []}'::jsonb
$$;
select pg_temp.base(:'m1', :'m2') as b \gset

-- ---------------------------------------------------------------- the contract accepts evidence-grounded analyses
select tests.is(pg_temp.p(:'a', :'b'), '', 'a rich, evidence-grounded psychological analysis is accepted');
select tests.is(pg_temp.p(:'a', pg_temp.opt_out(:'m2', :'b'), 'COMPLETE', 'RED', null, '[{"kind":"EXPLICIT_OPT_OUT"}]'), '', 'DO_NOT_PURSUE with an evidenced contact restriction is accepted');
select tests.is(pg_temp.p(:'a', pg_temp.insufficient(), 'INSUFFICIENT_EVIDENCE', null, null), '', 'INSUFFICIENT_EVIDENCE with UNKNOWNs and no findings is accepted');
select tests.is(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,1,confidence}', '"UNKNOWN"'), 'COMPLETE'), '', 'confidence may be UNKNOWN');

-- ---------------------------------------------------------------- shape
select tests.ok(pg_temp.has(pg_temp.p(:'a', '[]'), 'must be a JSON object'), 'output must be an object');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{contract_version}', '"rre-analysis/3"')), 'contract_version'), 'contract version is checked');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{contract_version}', '"rre-analysis/2"')), 'missing adversarial_review'),
  'rre-analysis/2 without its adversarial review is rejected (2A-5d-2)');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb || '{"free_text_verdict": "buyer is lying"}'), 'unexpected keys free_text_verdict'), 'no unvalidated top-level fields');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb - 'unknowns'), 'missing unknowns'), 'every section is required');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations}', '"O1"')), 'observations must be a list'), 'sections have the right types');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,0,supporting_observations}', '"O1"')), 'must be a list of ids'), 'malformed nested values are reported, not crashed on');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,0,mood}', '"angry"')), 'unexpected keys mood'), 'no unvalidated fields inside hypotheses');
-- A missing key is not the same as an empty list (regression: NULL-unsafe type checks).
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb #- '{hypotheses,2,contradicting_observations}'), 'contradicting_observations must be a list'), 'missing contradicting_observations is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb #- '{hypotheses,2,competing_hypotheses}'), 'competing_hypotheses must be a list'), 'missing competing_hypotheses is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb #- '{evidence_assessment,missing_evidence}'), 'missing_evidence must be a list'), 'missing missing_evidence is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb #- '{recommendation,based_on_hypotheses}'), 'based_on_hypotheses must list'), 'missing based_on_hypotheses is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb #- '{observations,0,evidence}'), 'must be a list of 1-10 evidence references'), 'missing observation evidence is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,0,evidence,0}', '{"type": "SCREENSHOT"}')), 'position must be 1-10'), 'a screenshot reference without a position is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,1,id}', '"O1"')), 'observation ids must be unique'), 'observation ids are unique');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{evidence_assessment,summary}', to_jsonb(repeat('x', 210000)))), 'larger than 200 kB'), 'oversized output is rejected');

-- ---------------------------------------------------------------- no invented or unusable evidence
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,0,evidence,0,message_id}', to_jsonb(gen_random_uuid()::text))), 'not part of this analysis''s evidence'), 'an invented message is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,0,evidence,0,message_id}', to_jsonb(:'mb'::text))), 'not part of this analysis''s evidence'), 'another case''s (another business''s) message is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,0,evidence,0,quote}', '"the price is far too high"')), 'quote does not appear'), 'an altered quote is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb #- '{observations,0,evidence,0,quote}'), 'needs a quote'), 'a message reference must quote the message');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,0,evidence}', '[]')), 'must be a list of 1-10 evidence references'), 'every observation cites evidence');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,0,evidence,0}', '{"type": "WEB", "url": "x"}')), 'MESSAGE or SCREENSHOT'), 'only messages and screenshots are evidence');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,0,evidence,0}', jsonb_build_object('type', 'MESSAGE', 'message_id', :'m3', 'quote', 'just checking in'))),
  'written by the other party'), 'the seller''s own recovery message cannot evidence prospect behaviour');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{observations,0,evidence,0}', '{"type": "SCREENSHOT", "position": 1}')), 'screenshot is not part of this analysis''s evidence'), 'a screenshot not in the evidence is rejected');

-- ---------------------------------------------------------------- psychology is labelled and grounded
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,0,supporting_observations}', '[]')), 'rests on no observation'), 'a hypothesis must rest on an observation');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,0,supporting_observations}', '["O9"]')), 'does not exist'), 'a hypothesis cannot cite a missing observation');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,3,basis}', '"STATED_BY_PROSPECT"')), 'label it HYPOTHESIS'),
  'a psychological reading supported only by seller behaviour cannot be presented as stated');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(jsonb_set(:'b'::jsonb, '{hypotheses,0,basis}', '"STATED_BY_PROSPECT"'), '{observations,0,actor}', '"UNCLEAR"')), 'label it HYPOTHESIS'),
  'stated basis needs a quoted PROSPECT observation');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,2,competing_hypotheses}', '[]')), 'must name at least one competing hypothesis'), 'a hypothesis needs a competing explanation');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,3,confidence}', '"HIGH"')), 'cannot be HIGH confidence'), 'an unstated psychological hypothesis is never HIGH confidence');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,0,contradicting_observations}', '["O4"]')), 'HIGH confidence is impossible'), 'HIGH confidence is impossible with contradicting evidence');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,2,contradicting_observations}', '["O1"]')), 'both support and contradict'), 'one observation cannot both support and contradict');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,4,competing_hypotheses}', '["H5"]')), 'must name other hypotheses'), 'a hypothesis cannot compete with itself');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb #- '{hypotheses,1,uncertainty}'), 'uncertainty is required'), 'every hypothesis states its uncertainty');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,0,category}', '"MIND_READING"')), 'not a known category'), 'only the defined psychological categories');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{hypotheses,0,basis}', '"CERTAIN"')), 'basis must be'), 'basis is STATED_BY_PROSPECT or HYPOTHESIS');

-- ---------------------------------------------------------------- recommendation, restrictions, classification
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{recommendation,strategy}', '"UNKNOWN"')), 'PURSUE needs a strategy'), 'PURSUE needs a strategy and rationale');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{recommendation,based_on_hypotheses}', '["H9"]')), 'must list existing hypotheses'), 'the rationale cites existing hypotheses');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{recommendation,next_action}', '{"type": "STOP_CONTACT", "text": "x"}'), 'COMPLETE', 'GREEN', null), 'PURSUE needs a message or a diagnostic question'), 'PURSUE cannot stop contact');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b'::jsonb || jsonb_build_object('contact_restrictions', pg_temp.opt_out(:'m2', :'b') -> 'contact_restrictions'),
  'COMPLETE', 'GREEN', pg_temp.msg(), '[{"kind":"EXPLICIT_OPT_OUT"}]'), 'a contact restriction requires DO_NOT_PURSUE'), 'GREEN with a message alongside an opt-out is rejected');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.opt_out(:'m2', :'b'), 'COMPLETE', 'RED', null, '[]'), 'do not match the restrictions being recorded'), 'restrictions in the output must be the ones recorded');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.opt_out(:'m2', :'b') #- '{contact_restrictions,0,evidence}', 'COMPLETE', 'RED', null, '[{"kind":"EXPLICIT_OPT_OUT"}]'), 'evidence references'), 'a contact restriction must cite its evidence');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.opt_out(:'m2', :'b') || '{"contact_restrictions": []}', 'COMPLETE', 'RED', null), 'needs a contact restriction or a reason not to pursue'), 'DO_NOT_PURSUE must say why');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b', 'COMPLETE', 'RED'), 'classification does not match'), 'PURSUE cannot be RED');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.opt_out(:'m2', :'b'), 'COMPLETE', 'YELLOW', null, '[{"kind":"EXPLICIT_OPT_OUT"}]'), 'classification does not match'), 'DO_NOT_PURSUE must be RED');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b', 'COMPLETE', 'GREEN', 'A different message'), 'must equal its text'), 'the proposed message is exactly the recommended one');
select tests.ok(pg_temp.has(pg_temp.p(:'a', :'b', 'COMPLETE', 'GREEN', null), 'SEND_MESSAGE needs the proposed message'), 'SEND_MESSAGE needs the message');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{recommendation,next_action}', '{"type": "ASK_DIAGNOSTIC_QUESTION", "text": "Ask about budget."}'), 'COMPLETE', 'GREEN', 'Sneaky message'),
  'allowed only for SEND_MESSAGE'), 'no proposed message for a diagnostic question');

-- ---------------------------------------------------------------- insufficient evidence: no fabricated findings
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.insufficient() || jsonb_build_object('hypotheses', :'b'::jsonb -> 'hypotheses'), 'INSUFFICIENT_EVIDENCE', null, null),
  'carries no hypotheses'), 'INSUFFICIENT_EVIDENCE cannot carry hypotheses');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.insufficient(), 'INSUFFICIENT_EVIDENCE', 'YELLOW', null), 'carries no hypotheses, classification'), 'INSUFFICIENT_EVIDENCE cannot carry a classification');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.insufficient() || '{"unknowns": []}', 'INSUFFICIENT_EVIDENCE', null, null), 'must state what is missing'), 'INSUFFICIENT_EVIDENCE must say what is missing');
select tests.ok(pg_temp.has(pg_temp.p(:'a', pg_temp.insufficient(), 'COMPLETE', null, null), 'requires status INSUFFICIENT_EVIDENCE'), 'insufficient evidence cannot be reported as COMPLETE');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{evidence_assessment,sufficiency}', '"SUFFICIENT"'), 'INSUFFICIENT_EVIDENCE', null, null), 'requires sufficiency INSUFFICIENT'), 'status and assessment must agree');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(jsonb_set(jsonb_set(:'b'::jsonb, '{hypotheses}', '[]'), '{recommendation,based_on_hypotheses}', '[]'), '{observations}', '[]')),
  'at least one observation'), 'COMPLETE needs at least one observation');
select tests.ok(pg_temp.has(pg_temp.p(:'a', jsonb_set(:'b'::jsonb, '{unknowns}', '[]')), 'PARTIAL evidence must list at least one unknown'), 'partial evidence must name its unknowns');

-- ---------------------------------------------------------------- deleted or changed screenshots
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'PSY-SHOT', 'Synthetic Hilux', 'Referral', 'SCREENSHOTS') as s \gset
select tests.as_owner();
insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
select :'s', tests.biz_a(), p, format('%s/%s/%s-%s.png', tests.biz_a(), :'s', p, repeat(h, 64)), 'image/png', 1000, repeat(h, 64), tests.client_a()
from (values (1, 'a'), (2, 'b')) v(p, h);
update public.cases set workflow_state = 'SUBMITTED' where id = :'s';
select tests.login(tests.founder());
select public.founder_start_analysis(:'s') as sa \gset
select tests.as_owner();
create function pg_temp.shot_output(p_pos int) returns jsonb language sql as $$
  select pg_temp.insufficient()
    || jsonb_build_object('evidence_assessment', '{"sufficiency": "SUFFICIENT", "summary": "Two screenshots.", "missing_evidence": []}'::jsonb,
                          'observations', jsonb_build_array(jsonb_build_object('id', 'O1', 'actor', 'PROSPECT', 'behavior', 'Asked for a discount.',
                            'evidence', jsonb_build_array(jsonb_build_object('type', 'SCREENSHOT', 'position', p_pos, 'quote', 'any discount?')))))
$$;
select tests.is(pg_temp.p(:'sa', pg_temp.shot_output(2), 'COMPLETE', null, null), '', 'a stored screenshot can be cited (its quote is model-reported)');
update public.case_screenshots set file_deleted_at = now() where case_id = :'s' and position = 2;
select tests.ok(pg_temp.has(pg_temp.p(:'sa', pg_temp.shot_output(2), 'COMPLETE', null, null), 'deleted or changed'), 'a screenshot deleted under retention cannot be cited');
update public.case_screenshots set sha256 = repeat('c', 64) where case_id = :'s' and position = 1;
select tests.ok(pg_temp.has(pg_temp.p(:'sa', pg_temp.shot_output(1), 'COMPLETE', null, null), 'deleted or changed'), 'a screenshot changed since the analysis started cannot be cited');
update public.case_screenshots set file_deleted_at = now() where case_id = :'s';
select tests.ok(pg_temp.has(pg_temp.p(:'sa', pg_temp.insufficient() || '{"evidence_assessment": {"sufficiency": "PARTIAL", "summary": "x", "missing_evidence": []}}', 'COMPLETE', null, null),
  'no usable evidence remains'), 'with every file deleted, only INSUFFICIENT_EVIDENCE is allowed');
select tests.is(pg_temp.p(:'sa', pg_temp.insufficient(), 'INSUFFICIENT_EVIDENCE', null, null), '', '... and INSUFFICIENT_EVIDENCE is accepted');

-- ---------------------------------------------------------------- end to end through internal_complete_analysis
-- Rejected: recorded as ERROR, nothing kept, case back to its prior state, audited, invisible to the client.
select tests.as_service();
select public.internal_complete_analysis(:'a', 'COMPLETE', 'synthetic-model', 'v1',
  jsonb_set(:'b'::jsonb, '{observations,0,evidence,0,quote}', '"I will definitely buy today"'), 'GREEN', pg_temp.msg(), '[]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and error like 'REJECTED by analysis contract rre-analysis/1: observations[0].evidence[0]: quote does not appear%'
                        and output is null and ai_classification is null and ai_proposed_message is null from public.analyses where id = :'a'),
  'a fabricated quote: analysis stored as ERROR with no findings');
select tests.is((select workflow_state::text from public.cases where id = :'c'), 'SUBMITTED', 'the case returns to its prior state');
select tests.ok(exists (select 1 from public.audit_log where action = 'ANALYSIS_REJECTED' and case_id = :'c' and client_label is null), 'rejection is audited, never shown to the client');
-- An inconsistent opt-out output is rejected, but (since Stage 2A-5b) the opt-out itself is kept.
select tests.login(tests.founder());
select public.founder_start_analysis(:'c') as a2 \gset
select tests.as_service();
select public.internal_complete_analysis(:'a2', 'COMPLETE', 'synthetic-model', 'v1', :'b', 'GREEN', pg_temp.msg(), '[{"kind":"EXPLICIT_OPT_OUT"}]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and output is null and ai_proposed_message is null from public.analyses where id = :'a2'),
  'an inconsistent opt-out output is rejected (no findings, no message)');
select tests.ok(exists (select 1 from public.contact_restrictions where case_id = :'c' and kind = 'EXPLICIT_OPT_OUT' and source = 'AI_DETECTED' and status = 'ACTIVE'),
  '... but the detected opt-out is still recorded (2A-5b)');
-- Since Stage 2A-5d-1 the kept opt-out (now in the next analysis's evidence snapshot) also
-- stops that analysis from recommending contact.
select tests.login(tests.founder());
select public.founder_start_analysis(:'c') as a3r \gset
select tests.as_service();
select public.internal_complete_analysis(:'a3r', 'COMPLETE', 'synthetic-model', 'v1', :'b', 'GREEN', pg_temp.msg(), '[]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and error like '%an active contact restriction in the evidence snapshot requires DO_NOT_PURSUE%'
                        and output is null and ai_proposed_message is null from public.analyses where id = :'a3r'),
  'with the kept opt-out in the snapshot, the GREEN analysis is rejected (2A-5d-1)');
-- Accepted, once the founder has dismissed the AI-detected opt-out as a misreading.
select tests.login(tests.founder());
select public.founder_dismiss_ai_restriction(id, 'Synthetic: the prospect was quoting someone else, not opting out.')
from public.contact_restrictions where case_id = :'c' and status = 'ACTIVE';
select public.founder_start_analysis(:'c') as a3 \gset
select tests.as_service();
select public.internal_complete_analysis(:'a3', 'COMPLETE', 'synthetic-model', 'v1', :'b', 'GREEN', pg_temp.msg(), '[]');
select tests.as_owner();
select tests.ok((select status = 'COMPLETE' and output = :'b'::jsonb and ai_proposed_message = pg_temp.msg() from public.analyses where id = :'a3'), 'a valid analysis is stored complete');
select tests.is((select workflow_state::text from public.cases where id = :'c'), 'AWAITING_ADMIN_REVIEW', 'and the case waits for the founder');

-- ---------------------------------------------------------------- founder-only
select tests.login(tests.founder());
select tests.ok((select output -> 'hypotheses' -> 2 ->> 'basis' = 'HYPOTHESIS' from public.analyses where id = :'a3'), 'the founder reads the complete analysis');
select tests.login(tests.client_a());
select tests.is(tests.count('select 1 from public.analyses'), 0::bigint, 'the business user cannot read any analysis');
select tests.is(tests.count('select 1 from public.contact_restrictions'), 0::bigint, 'nor contact restrictions');
select tests.ok((select status = 'UNDER_REVIEW' and classification is null and deal_situation is null and next_action is null and approved_message is null
                 from public.client_list_cases() where id = :'c'), 'the case list shows only "Under review"');
select tests.ok(public.client_get_case(:'c')::text !~* '(hypothes|strategy|rationale|joint viewing|Saturday at 10|TRUST_AND_RISK|psycholog)', 'the case detail leaks nothing from the analysis');
select tests.throws(format('select private.analysis_output_problems(a, %L, %L, null, null, %L) from public.analyses a limit 1', 'COMPLETE', '{}', '[]'),
  'permission denied', 'the business user cannot call the contract');
select tests.login(tests.client_b());
select tests.throws(format('select public.client_get_case(%L)', :'c'), '^NOT_FOUND', 'another business cannot see the case at all');

-- ---------------------------------------------------------------- privileges
select tests.as_owner();
select tests.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'private' and (p.proname like 'ac\_%' or p.proname = 'analysis_output_problems')
                              and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                   or has_function_privilege('service_role', p.oid, 'EXECUTE')
                                   or not (p.prosecdef and p.proconfig @> array['search_path=""'])))
  and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and (p.proname like 'ac\_%' or p.proname = 'analysis_output_problems')) = 7,
  'the 7 contract functions are callable by no API role and pin search_path');
select tests.ok(has_function_privilege('service_role', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
            and not has_function_privilege('authenticated', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE'),
  'internal_complete_analysis is still server-side only');
rollback;

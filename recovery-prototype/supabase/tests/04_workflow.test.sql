-- Workflow state machine through the guarded functions.
begin;
select tests.as_owner();
select tests.seed();

-- Creation, idempotency, validation
select tests.login(tests.client_a());
select public.client_create_case('20000000-0000-4000-8000-000000000001', 'P-1', 'Synthetic Camry', 'Referral', 'TEXT',
  'Prospect: Is the car available?' || chr(10) || 'Business: Yes.') as case1 \gset
select tests.is(public.client_create_case('20000000-0000-4000-8000-000000000001', 'P-1 retry', 'Different', 'Google', 'TEXT',
  'Prospect: a retried submission with other text'), :'case1'::uuid, 'same idempotency key returns the same case (no duplicate)');
select tests.is(tests.count('select 1 from public.cases'), 1::bigint, 'retry created no second case');
select tests.is((select status from public.client_list_cases() where id = :'case1'), 'DRAFT', 'new case is DRAFT');
select tests.throws($$select public.client_create_case(gen_random_uuid(), 'P', 'X', 'Referral', 'TEXT', 'too short')$$, '^VALIDATION', 'pasted conversation must be long enough');
select tests.throws($$select public.client_create_case(gen_random_uuid(), 'P', 'X', 'Billboard', 'TEXT', 'Prospect: long enough synthetic text')$$, 'lead_source', 'unknown lead source rejected');
select tests.throws($$select public.client_create_case(gen_random_uuid(), '', 'X', 'Referral', 'TEXT', 'Prospect: long enough synthetic text')$$, 'reference', 'empty reference rejected');
select tests.throws($$select public.client_create_case(null, 'P', 'X', 'Referral', 'TEXT', 'Prospect: long enough synthetic text')$$, '^VALIDATION', 'idempotency key required');

-- Screenshot case cannot be submitted without screenshots
select public.client_create_case(gen_random_uuid(), 'P-2', 'Synthetic Lexus', 'Google', 'SCREENSHOTS') as shot_case \gset
select tests.throws(format('select public.client_submit_case(%L)', :'shot_case'), '^VALIDATION', 'screenshot case needs at least one screenshot');

-- Submit
select tests.throws(format('select public.client_record_sent(%L)', :'case1'), '^INVALID_STATE', 'cannot mark sent before approval');
select public.client_submit_case(:'case1');
select tests.is((select status from public.client_list_cases() where id = :'case1'), 'UNDER_REVIEW', 'submitted case shows UNDER_REVIEW');
select tests.ok((select classification is null and approved_message is null from public.client_list_cases() where id = :'case1'), 'no classification or message before approval');
select tests.throws(format('select public.client_submit_case(%L)', :'case1'), '^INVALID_STATE', 'cannot submit twice');
select tests.throws(format('select public.client_record_outcome(%L, %L)', :'case1', 'WON'), '^INVALID_STATE', 'cannot close a case under review');

-- Founder analysis lifecycle (synthetic result; no AI call)
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, gen_random_uuid(), 1, %L, %L, %L, %L, %L)', :'case1', 'GREEN', 's', 'n', 'm', 'EDITED'), '^INVALID_STATE', 'cannot approve before analysis');
select public.founder_start_analysis(:'case1') as an1 \gset
select tests.throws(format('select public.founder_start_analysis(%L)', :'case1'), '^INVALID_STATE', 'only one analysis in flight per case');

-- A failed analysis never corrupts the case
select tests.as_service();
select public.internal_complete_analysis(:'an1', 'ERROR', 'synthetic-model', 'test', null, null, null, '[]', 10, 0, 0.0001, 'synthetic upstream failure');
select tests.as_owner();
select tests.is((select workflow_state::text from public.cases where id = :'case1'), 'SUBMITTED', 'failed analysis returns case to its prior state');
select tests.is((select status::text from public.analyses where id = :'an1'), 'ERROR', 'failed analysis is recorded as ERROR');
select tests.is((select count(*) from public.approvals where case_id = :'case1'), 0::bigint, 'nothing published after a failure');

select tests.login(tests.founder());
select public.founder_start_analysis(:'case1') as an2 \gset
select tests.as_service();
select tests.throws(format('select public.internal_complete_analysis(%L, %L)', :'an2', 'PENDING'), '^VALIDATION', 'cannot complete as PENDING');
select public.internal_complete_analysis(:'an2', 'COMPLETE', 'synthetic-model', 'test', '{"synthetic":true}', 'GREEN', 'AI proposed text', '[]', 1000, 200, 0.004);
select tests.throws(format('select public.internal_complete_analysis(%L, %L)', :'an2', 'COMPLETE'), '^INVALID_STATE', 'analysis cannot be completed twice');
select tests.as_owner();
select tests.is((select workflow_state::text from public.cases where id = :'case1'), 'AWAITING_ADMIN_REVIEW', 'completed analysis moves case to review');
select tests.is((select version from public.analyses where id = :'an2'), 2, 'analysis versions increment');
select tests.ok((select evidence_manifest ? 'messages' and evidence_version = 1 from public.analyses where id = :'an2'), 'analysis records evidence version and manifest');

-- Client still sees nothing during review
select tests.login(tests.client_a());
select tests.ok((select status = 'UNDER_REVIEW' and approved_message is null from public.client_list_cases() where id = :'case1'), 'client sees UNDER_REVIEW and no AI output');

-- Approval with an edited message
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, 1, %L, %L, %L, %L, %L)', :'case1', :'an2', 'GREEN', 's', 'n', 'Different text', 'UNCHANGED'), '^VALIDATION', 'UNCHANGED must match the AI proposal');
select tests.throws(format('select public.founder_approve(%L, %L, 1, %L, %L, %L, null, %L)', :'case1', :'an2', 'YELLOW', 's', 'n', 'EDITED'), '^VALIDATION', 'GREEN/YELLOW require a message');
select tests.throws(format('select public.founder_approve(%L, %L, 1, %L, %L, %L, %L, %L)', :'case1', :'an2', 'RED', 's', 'n', 'msg', 'EDITED'), '^VALIDATION', 'RED cannot carry a message');
select public.founder_approve(:'case1', :'an2', 1, 'GREEN', 'Worth another conversation.', 'Send the approved message below.', 'Founder edited text', 'EDITED') as ap1 \gset
select tests.ok((select ai_proposed_message = 'AI proposed text' and approved_message = 'Founder edited text' and founder_id = tests.founder() and evidence_version = 1 from public.approvals where id = :'ap1'),
  'approval records founder, evidence version, AI proposal and final message');

select tests.login(tests.client_a());
select tests.ok((select status = 'ACTION_REQUIRED' and classification = 'GREEN' and approved_message = 'Founder edited text' from public.client_list_cases() where id = :'case1'),
  'client receives exactly the founder-approved message');
select tests.ok((select (public.client_get_case(:'case1'))::text not like '%AI proposed text%'), 'client never receives the AI proposal');

-- Sent integrity
select tests.throws(format('select public.client_record_sent(%L, %L)', :'case1', '   '), '^VALIDATION', 'changed message must not be blank');
select public.client_record_sent(:'case1', 'What I actually sent');
select tests.ok((select status = 'WAITING' and last_sent_message = 'What I actually sent' and recovery_attempts = 1 from public.client_list_cases() where id = :'case1'),
  'actual sent text is recorded; case waits for prospect');
select tests.as_owner();
select tests.ok((select not sent_exactly and attempt = 1 from public.case_messages where case_id = :'case1' and kind = 'RECOVERY_SENT'), 'changed send recorded as not exact');

-- Response loop
select tests.login(tests.client_a());
select tests.throws(format('select public.client_add_response(%L, %L)', :'case1', ''), '^VALIDATION', 'empty response rejected');
select public.client_add_response(:'case1', 'Synthetic prospect reply: Saturday works.');
select tests.is((select status from public.client_list_cases() where id = :'case1'), 'UNDER_REVIEW', 'response returns the case to review');
select tests.throws(format('select public.client_add_response(%L, %L)', :'case1', 'again'), '^INVALID_STATE', 'no second response while under review');

-- Outcome
select tests.login(tests.founder());
select public.founder_start_analysis(:'case1') as an3 \gset
select tests.as_service();
select public.internal_complete_analysis(:'an3', 'COMPLETE', 'synthetic-model', 'test', '{}', 'GREEN', 'Next AI text', '[]');
select tests.login(tests.founder());
select public.founder_approve(:'case1', :'an3', 3, 'GREEN', 'Momentum restored.', 'Confirm the viewing.', 'Next AI text', 'UNCHANGED');
select tests.login(tests.client_a());
select tests.throws(format('select public.client_record_outcome(%L, %L, 100, null, null)', :'case1', 'WON'), '^VALIDATION', 'WON requires amount paid and date');
select public.client_record_outcome(:'case1', 'WON', 25000000, 24500000, '2026-10-08');
select tests.ok((select status = 'WON' and won_amount_paid = 24500000 and won_payment_date = '2026-10-08' from public.client_list_cases() where id = :'case1'), 'won outcome visible to client');
select tests.throws(format('select public.client_record_outcome(%L, %L)', :'case1', 'LOST'), '^INVALID_STATE', 'closed case cannot be closed again');
select tests.ok((select jsonb_array_length((public.client_get_case(:'case1')) -> 'history') >= 6), 'client sees a case history of client-safe labels');

-- Founder pause of an unrelated draft
select tests.login(tests.founder());
select public.founder_pause_case(:'shot_case', 'synthetic pause');
select tests.login(tests.client_a());
select tests.is((select status from public.client_list_cases() where id = :'shot_case'), 'PAUSED', 'founder can pause a case');

-- Rate limit: 20 new cases per business per day (2 already exist)
select tests.lives($$select public.client_create_case(gen_random_uuid(), 'R', 'P', 'Referral', 'TEXT', 'Prospect: synthetic rate-limit text') from generate_series(1, 18)$$, 'up to 20 cases per day allowed');
select tests.throws($$select public.client_create_case(gen_random_uuid(), 'R', 'P', 'Referral', 'TEXT', 'Prospect: synthetic rate-limit text')$$, '^RATE_LIMITED', '21st case in a day is rate limited');
rollback;

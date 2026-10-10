-- Tenant isolation: Client A vs Client B, unauthenticated access.
begin;
select tests.as_owner();
select tests.seed();

-- One case per business, driven through the real functions.
select tests.case_in_review(tests.client_b()) as b_case \gset
select tests.case_in_review(tests.client_a()) as a_case \gset

-- Approve B's case so B has a published recommendation and approval history.
select tests.login(tests.founder());
select public.founder_approve(:'b_case', (select id from public.analyses where case_id = :'b_case'), 1,
  'GREEN', 'Synthetic situation B', 'Send it', 'SECRET-B-MESSAGE', 'EDITED');
select public.founder_add_note(:'b_case', 'SECRET-B-FOUNDER-NOTE');

-- ---- Client A
select tests.login(tests.client_a());
-- Since 2A-4b clients read case tables only through client_* functions (never directly).
select tests.is(tests.count('select 1 from public.cases'), 0::bigint, 'A reads zero case rows directly (even its own; uses client_list_cases)');
select tests.is(tests.count(format('select 1 from public.cases where id = %L', :'b_case')), 0::bigint, 'A cannot select B''s case');
select tests.is(tests.count('select 1 from public.businesses'), 1::bigint, 'A sees only its own business');
select tests.is(tests.count(format('select 1 from public.case_messages where business_id = %L', tests.biz_b())), 0::bigint, 'A cannot read B''s messages');
select tests.is(tests.count('select 1 from public.business_members'), 1::bigint, 'A sees only its own membership row');
select tests.is(tests.count('select 1 from public.outcomes where business_id <> ' || quote_literal(tests.biz_a())), 0::bigint, 'A cannot read other outcomes');

select tests.is(tests.count('select 1 from public.analyses'), 0::bigint, 'client reads zero analyses (even its own)');
select tests.is(tests.count('select 1 from public.approvals'), 0::bigint, 'client reads zero approvals');
select tests.is(tests.count('select 1 from public.client_recommendations'), 0::bigint, 'client reads zero recommendation rows directly');
select tests.is(tests.count('select 1 from public.contact_restrictions'), 0::bigint, 'client reads zero contact restrictions');
select tests.is(tests.count('select 1 from public.founder_notes'), 0::bigint, 'client reads zero founder notes');
select tests.is(tests.count('select 1 from public.audit_log'), 0::bigint, 'client reads zero audit entries');
select tests.is(tests.count('select 1 from public.founders'), 0::bigint, 'client cannot list founders');

select tests.is(tests.count('select 1 from public.client_list_cases()'), 1::bigint, 'client_list_cases returns only A''s case');
select tests.throws(format('select public.client_get_case(%L)', :'b_case'), '^NOT_FOUND', 'client_get_case on B''s case is NOT_FOUND');
select tests.throws(format('select public.client_submit_case(%L)', :'b_case'), '^NOT_FOUND', 'A cannot submit B''s case');
select tests.throws(format('select public.client_record_sent(%L, null)', :'b_case'), '^NOT_FOUND', 'A cannot mark B''s message sent');
select tests.throws(format('select public.client_add_response(%L, %L)', :'b_case', 'x'), '^NOT_FOUND', 'A cannot add a response to B''s case');
select tests.throws(format('select public.client_record_outcome(%L, %L)', :'b_case', 'LOST'), '^NOT_FOUND', 'A cannot close B''s case');
select tests.throws(format('select public.client_report_opt_out(%L)', :'b_case'), '^NOT_FOUND', 'A cannot add restrictions to B''s case');

select tests.throws(format('update public.cases set workflow_state = %L where id = %L', 'WON', :'a_case'), 'permission denied', 'A cannot update even its own case directly');
select tests.throws(format('delete from public.cases where id = %L', :'b_case'), 'permission denied', 'A cannot delete cases');
select tests.throws(format('insert into public.case_messages (case_id, business_id, kind, body) values (%L, %L, %L, %L)', :'b_case', tests.biz_b(), 'PROSPECT_RESPONSE', 'injected'), 'permission denied', 'A cannot insert into B''s messages');
select tests.throws(format('insert into public.cases (business_id, reference, product_service, lead_source, conversation_source, idempotency_key) values (%L, %L, %L, %L, %L, gen_random_uuid())', tests.biz_b(), 'X', 'X', 'Referral', 'TEXT'), 'permission denied', 'A cannot create a case in B''s business');

-- B's private content must not appear anywhere A can reach.
select tests.ok(position('SECRET-B' in coalesce((select string_agg(to_jsonb(v)::text, '') from public.client_list_cases() v), '')) = 0,
  'none of B''s approved message or notes appears in A''s projection');

-- ---- Client B sees only the approved, client-safe fields
select tests.login(tests.client_b());
select tests.is((select approved_message from public.client_list_cases() where id = :'b_case'), 'SECRET-B-MESSAGE', 'B sees its own approved message');
select tests.ok((select (public.client_get_case(:'b_case'))::text not like '%FOUNDER-NOTE%'), 'B''s projection excludes the founder note');
select tests.ok((select (public.client_get_case(:'b_case'))::text not like '%Synthetic proposed message%'), 'B''s projection excludes the AI proposal');
select tests.ok((select not ((public.client_get_case(:'b_case')) ?| array['analysis_id','ai_classification','evidence_version','evidence_manifest','output'])), 'projection carries no analysis keys');

-- ---- Unauthenticated
select tests.as_anon();
select tests.throws('select * from public.cases', 'permission denied', 'anon cannot read cases');
select tests.throws('select * from public.analyses', 'permission denied', 'anon cannot read analyses');
select tests.throws('select public.client_list_cases()', 'permission denied', 'anon cannot call client_list_cases');
select tests.throws('select public.whoami()', 'permission denied', 'anon cannot call whoami');
select tests.throws(format('select public.client_get_case(%L)', :'a_case'), 'permission denied', 'anon cannot fetch a case');

-- ---- Signed in but not assigned to any business (invited, not yet linked)
select tests.login(tests.unassigned());
select tests.is((public.whoami()) ->> 'role', 'NONE', 'unassigned invited user has role NONE');
select tests.is(tests.count('select 1 from public.cases'), 0::bigint, 'unassigned user sees no cases');
select tests.is(tests.count('select 1 from public.client_list_cases()'), 0::bigint, 'unassigned user lists no cases');
select tests.throws($$select public.client_create_case(gen_random_uuid(), 'R', 'P', 'Referral', 'TEXT', 'Prospect: hello there, synthetic')$$, '^FORBIDDEN', 'unassigned user cannot create cases');

-- ---- Founder sees everything
select tests.login(tests.founder());
select tests.is(tests.count('select 1 from public.cases'), 2::bigint, 'founder sees both businesses'' cases');
select tests.is(tests.count('select 1 from public.analyses'), 2::bigint, 'founder sees analyses');
select tests.is(tests.count('select 1 from public.founder_notes'), 1::bigint, 'founder sees notes');
rollback;

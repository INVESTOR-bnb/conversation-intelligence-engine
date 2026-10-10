-- Stage 2A-4b: client case creation/submission through the guarded functions,
-- founder-only direct reads of case tables, and client-safe projections.
begin;
select tests.as_owner();
select tests.seed();

-- ---------------------------------------------------------------- the test identity is a real, unprivileged session
select tests.login(tests.client_a());
select tests.is(current_user::text, 'authenticated', 'client session runs as the authenticated role (not the owner)');
select tests.is((select auth.uid()), tests.client_a(), 'auth.uid() is the client''s user ID');
select tests.ok(not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user), 'client role is not superuser and does not bypass RLS');
select tests.throws(format('insert into public.founders (user_id) values (%L)', tests.client_a()), 'permission denied', 'sanity: the session has no write privileges');

-- ---------------------------------------------------------------- create + submit (pasted text)
select public.client_create_case('30000000-0000-4000-8000-000000000001', 'TEST-001', 'Synthetic Camry', 'Referral', 'TEXT',
  'Prospect: Is the car still available?' || chr(10) || 'Business: Yes, synthetic test.', 4500000, current_date - 3, 'Synthetic context') as c1 \gset
select tests.is((select status from public.client_list_cases() where id = :'c1'), 'DRAFT', 'created case is DRAFT');
select public.client_submit_case(:'c1');
select tests.is((select status from public.client_list_cases() where id = :'c1'), 'UNDER_REVIEW', 'submitted case shows UNDER_REVIEW');
select tests.is(public.client_create_case('30000000-0000-4000-8000-000000000001', 'TEST-001', 'Synthetic Camry', 'Referral', 'TEXT',
  'Prospect: Is the car still available?' || chr(10) || 'Business: Yes, synthetic test.'), :'c1'::uuid, 'network retry with the same request ID returns the same case');
select tests.is(tests.count('select 1 from public.client_list_cases()'), 1::bigint, 'the retry created no duplicate');
select tests.is((select status from public.client_list_cases() where id = :'c1'), 'UNDER_REVIEW', 'the retry did not reset the submitted case');
select tests.throws(format('select public.client_submit_case(%L)', :'c1'), '^INVALID_STATE', 'a case cannot be submitted twice');
select tests.throws($$select public.client_create_case(gen_random_uuid(), 'T', 'X', 'Referral', 'TEXT', 'too short')$$, '^VALIDATION', 'conversation under 20 characters rejected');
select tests.throws(format('select public.client_create_case(gen_random_uuid(), %L, %L, %L, %L, %L)', 'T', 'X', 'Referral', 'TEXT', repeat('a', 20001)), 'check constraint', 'conversation over 20,000 characters rejected');
select tests.ok(public.client_get_case(:'c1') -> 'history' @> '[{"label": "Case submitted"}]', 'client history shows "Case submitted"');

-- Same request ID in another business is a different case (keys are per business).
select tests.login(tests.client_b());
select tests.ok(public.client_create_case('30000000-0000-4000-8000-000000000001', 'TEST-B', 'Synthetic Course', 'Google', 'TEXT',
  'Prospect: How much is the synthetic course?') <> :'c1'::uuid, 'same request ID in another business creates a separate case');
select tests.throws(format('select public.client_submit_case(%L)', :'c1'), '^NOT_FOUND', 'client B cannot submit client A''s case');
select tests.throws(format('select public.client_get_case(%L)', :'c1'), '^NOT_FOUND', 'client B cannot open client A''s case');

-- ---------------------------------------------------------------- founder-private data on A's case
select tests.as_owner();
insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256)
values (:'c1', tests.biz_a(), 1, 'synthetic/c1/1.png', 'image/png', 10, repeat('a', 64));
select tests.case_in_review(tests.client_a()) as c2 \gset
select tests.login(tests.founder());
select public.founder_add_restriction(:'c2', 'OTHER', 'SECRET-RESTRICTION-NOTE');
select public.founder_add_note(:'c2', 'SECRET-FOUNDER-NOTE');
select public.founder_pause_case(:'c1', 'SECRET-PAUSE-NOTE');
select tests.as_owner();
select tests.is((select review_reason::text from public.cases where id = :'c2'), 'CONTACT_RESTRICTION', 'fixture: c2 has an internal review reason');
select tests.is((select note from public.outcomes where case_id = :'c1'), 'SECRET-PAUSE-NOTE', 'fixture: c1 has a founder pause note');

-- ---------------------------------------------------------------- direct table reads: founder-only
select tests.login(tests.client_a());
select tests.is(tests.count('select 1 from public.cases'), 0::bigint, 'client reads zero rows of cases directly');
select tests.is(tests.count('select 1 from public.outcomes'), 0::bigint, 'client reads zero rows of outcomes (founder pause note hidden)');
select tests.is(tests.count('select 1 from public.case_messages'), 0::bigint, 'client reads zero rows of case_messages directly');
select tests.is(tests.count('select 1 from public.case_screenshots'), 0::bigint, 'client reads zero rows of case_screenshots directly');
select tests.is(tests.count('select 1 from public.cases where review_reason is not null'), 0::bigint, 'client cannot filter on review_reason');
-- Founder-only private tables remain closed.
select tests.is(tests.count('select 1 from public.analyses') + tests.count('select 1 from public.approvals') + tests.count('select 1 from public.client_recommendations')
  + tests.count('select 1 from public.contact_restrictions') + tests.count('select 1 from public.founder_notes') + tests.count('select 1 from public.audit_log'), 0::bigint,
  'client still reads zero analyses, approvals, recommendations, restrictions, notes and audit entries');
-- Own business and membership remain readable.
select tests.is(tests.count('select 1 from public.businesses'), 1::bigint, 'client still reads its own business');

-- ---------------------------------------------------------------- client functions still work and stay client-safe
select tests.is(tests.count('select 1 from public.client_list_cases()'), 2::bigint, 'client_list_cases returns both of A''s cases');
select tests.is((select status from public.client_list_cases() where id = :'c2'), 'UNDER_REVIEW', 'a case with a restriction shows only UNDER_REVIEW');
select tests.is((select status from public.client_list_cases() where id = :'c1'), 'PAUSED', 'a paused case shows PAUSED');
select tests.ok(not (public.client_get_case(:'c2') ?| array['workflow_state', 'review_reason', 'evidence_version', 'queued_at', 'note', 'business_id', 'created_by']),
  'client_get_case returns no internal fields');
select tests.ok(public.client_get_case(:'c1')::text !~ 'SECRET' and public.client_get_case(:'c2')::text !~ 'SECRET',
  'client_get_case contains no founder notes, pause notes or restriction details');
select tests.ok(public.client_get_case(:'c2')::text !~ 'CONTACT_RESTRICTION|REANALYZING|AWAITING_ADMIN_REVIEW',
  'client_get_case reveals no internal state or review reason');
select tests.ok((select string_agg(x::text, '') from public.client_list_cases() x) !~ 'SECRET|CONTACT_RESTRICTION',
  'client_list_cases contains no private text');

-- ---------------------------------------------------------------- function configuration (catalog)
select tests.as_owner();
select tests.is(pg_get_function_result('public.client_list_cases()'::regprocedure),
  'TABLE(id uuid, reference text, product_service text, status text, classification classification, deal_situation text, next_action text, approved_message text, recovery_attempts integer, last_sent_message text, responses_added integer, won_deal_value numeric, won_amount_paid numeric, won_payment_date date, closed_at timestamp with time zone, updated_at timestamp with time zone)',
  'client_list_cases returns exactly the reviewed client-safe columns');
select tests.ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
  where oid in ('public.client_list_cases()'::regprocedure, 'public.client_get_case(uuid)'::regprocedure, 'public.client_create_case(uuid, text, text, text, public.conversation_source, text, numeric, date, text)'::regprocedure, 'public.client_submit_case(uuid)'::regprocedure)),
  'client functions are SECURITY DEFINER with an empty search_path');
select tests.ok(has_function_privilege('authenticated', 'public.client_list_cases()', 'EXECUTE') and has_function_privilege('authenticated', 'public.client_get_case(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.client_list_cases()', 'EXECUTE') and not has_function_privilege('anon', 'public.client_get_case(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.client_create_case(uuid, text, text, text, public.conversation_source, text, numeric, date, text)', 'EXECUTE'),
  'client functions are executable by authenticated users only (not anon)');

-- ---------------------------------------------------------------- founder sees everything; others nothing
select tests.login(tests.founder());
select tests.ok(tests.count('select 1 from public.cases') = 3 and tests.count('select 1 from public.outcomes') = 1
  and tests.count('select 1 from public.case_messages') >= 3 and tests.count('select 1 from public.case_screenshots') = 1,
  'founder still reads all four case tables directly');
select tests.is((select body from public.case_messages where case_id = :'c1' and kind = 'PASTED_CONVERSATION'),
  'Prospect: Is the car still available?' || chr(10) || 'Business: Yes, synthetic test.', 'founder reads the pasted conversation');
select tests.is(tests.count('select 1 from public.client_list_cases()'), 0::bigint, 'client_list_cases returns nothing to the founder');

select tests.login(tests.unassigned());
select tests.is(tests.count('select 1 from public.cases') + tests.count('select 1 from public.client_list_cases()'), 0::bigint, 'an unlinked user sees no cases');
select tests.throws($$select public.client_create_case(gen_random_uuid(), 'T', 'X', 'Referral', 'TEXT', 'Prospect: synthetic long enough text')$$, '^FORBIDDEN', 'an unlinked user cannot create cases');

select tests.as_anon();
select tests.throws('select * from public.cases', 'permission denied', 'anon cannot read cases');
select tests.throws('select * from public.client_list_cases()', 'permission denied', 'anon cannot call client_list_cases');

-- ---------------------------------------------------------------- daily limit (20 per business per day)
select tests.login(tests.client_b());
do $$ begin
  for i in 1..19 loop
    perform public.client_create_case(gen_random_uuid(), 'L-' || i, 'Synthetic item', 'Website', 'TEXT', 'Prospect: synthetic message number ' || i);
  end loop;
end $$;
select tests.is(tests.count('select 1 from public.client_list_cases()'), 20::bigint, 'twenty cases created today');
select tests.throws($$select public.client_create_case(gen_random_uuid(), 'L-21', 'Synthetic item', 'Website', 'TEXT', 'Prospect: one case too many today')$$, '^RATE_LIMITED', 'the 21st case in a day is refused');
rollback;

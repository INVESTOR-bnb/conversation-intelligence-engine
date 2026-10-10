-- Stage 2A-4a founder onboarding: founder_create_business + founder_add_member,
-- exactly as the founder screen calls them. No schema or policy changes.
begin;
select tests.as_owner();
select tests.seed();

-- ---------------------------------------------------------------- who may call
select tests.as_anon();
select tests.throws($$select public.founder_create_business('Synthetic Anon Co')$$, 'permission denied', 'anon cannot create a business');
select tests.throws(format('select public.founder_add_member(%L, %L)', tests.biz_a(), tests.unassigned()), 'permission denied', 'anon cannot link a client');

select tests.login(tests.unassigned());
select tests.throws($$select public.founder_create_business('Synthetic Pending Co')$$, '^FORBIDDEN', 'an invited, unlinked user cannot create a business');
select tests.throws(format('select public.founder_add_member(%L, %L)', tests.biz_a(), tests.unassigned()), '^FORBIDDEN', 'an invited, unlinked user cannot link itself');

select tests.login(tests.client_b());
select tests.throws(format('select public.founder_add_member(%L, %L)', tests.biz_b(), tests.unassigned()), '^FORBIDDEN', 'a client cannot link other users');

-- ---------------------------------------------------------------- create business
select tests.login(tests.founder());
select tests.throws($$select public.founder_create_business('   ')$$, 'check constraint', 'blank business name is rejected');
select tests.throws(format('select public.founder_create_business(%L)', repeat('x', 121)), 'check constraint', 'business name over 120 characters is rejected');
select tests.throws($$select public.founder_create_business('Synthetic Bad Currency', '', 'NAIRA')$$, 'check constraint', 'currency must be a 3-letter code');
select tests.throws(format('select public.founder_create_business(%L, %L)', 'Synthetic Long Industry', repeat('y', 121)), 'check constraint', 'industry over 120 characters is rejected');

create temporary table t_new (id uuid) on commit drop;
grant all on t_new to authenticated;
insert into t_new select public.founder_create_business('  Synthetic Bakery C  ', ' Food ', 'ngn');
select tests.is((select name from public.businesses where id = (select id from t_new)), 'Synthetic Bakery C', 'business name is trimmed and stored');
select tests.is((select currency from public.businesses where id = (select id from t_new)), 'NGN', 'currency is normalised to upper case');
select tests.is((select created_by from public.businesses where id = (select id from t_new)), tests.founder(), 'business records the founder as creator');
select tests.is(tests.count(format('select 1 from public.audit_log where action = %L and business_id = %L and actor = %L', 'BUSINESS_CREATED', (select id from t_new), tests.founder())), 1::bigint, 'business creation is audited once');
select tests.is(tests.count('select 1 from public.businesses'), 3::bigint, 'founder sees all businesses, including the new one');

-- ---------------------------------------------------------------- link client
select tests.throws(format('select public.founder_add_member(%L, %L)', gen_random_uuid(), tests.unassigned()), '^NOT_FOUND: business', 'unknown business is reported');
select tests.throws(format('select public.founder_add_member(%L, %L)', (select id from t_new), gen_random_uuid()), '^NOT_FOUND: user', 'unknown user is reported');
select tests.throws(format('select public.founder_add_member(%L, %L)', (select id from t_new), tests.founder()), '^VALIDATION: a founder', 'founder cannot be linked as a client');
select tests.throws(format('select public.founder_add_member(%L, %L)', (select id from t_new), tests.client_a()), '^VALIDATION: user already', 'a client of another business cannot be linked again');

select tests.lives(format('select public.founder_add_member(%L, %L)', (select id from t_new), tests.unassigned()), 'founder links the invited user to the new business');
select tests.throws(format('select public.founder_add_member(%L, %L)', (select id from t_new), tests.unassigned()), '^VALIDATION: user already', 'linking the same user twice is rejected (no duplicate membership)');
select tests.is(tests.count(format('select 1 from public.business_members where user_id = %L', tests.unassigned())), 1::bigint, 'exactly one membership row exists');
select tests.is(tests.count(format('select 1 from public.audit_log where action = %L and business_id = %L', 'MEMBER_ADDED', (select id from t_new))), 1::bigint, 'linking is audited once');

-- ---------------------------------------------------------------- linked client's view
select tests.login(tests.unassigned());
select tests.is((public.whoami()) ->> 'role', 'CLIENT', 'linked user is now a CLIENT');
select tests.is((public.whoami()) ->> 'business_name', 'Synthetic Bakery C', 'whoami reports the linked business');
select tests.is(tests.count('select 1 from public.businesses'), 1::bigint, 'linked client sees exactly one business');
select tests.is((select name from public.businesses), 'Synthetic Bakery C', 'the one business visible is their own');
select tests.is(tests.count('select 1 from public.cases'), 0::bigint, 'linked client sees no cases of other businesses');
select tests.is(tests.count('select 1 from public.business_members'), 1::bigint, 'linked client sees only its own membership');
select tests.is(tests.count('select 1 from public.audit_log'), 0::bigint, 'linked client cannot read the audit log');
select tests.throws($$select public.founder_create_business('Synthetic Escalation Co')$$, '^FORBIDDEN', 'linked client still cannot create businesses');
rollback;

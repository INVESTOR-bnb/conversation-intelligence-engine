-- Role protection: no client-controlled path to founder rights.
begin;
select tests.as_owner();
select tests.seed();

select tests.login(tests.client_a());
select tests.is((public.whoami()) ->> 'role', 'CLIENT', 'client A is CLIENT despite a FOUNDER claim in user metadata');
select tests.throws(format('insert into public.founders (user_id) values (%L)', tests.client_a()), 'permission denied', 'client cannot insert itself into founders');
select tests.throws(format('update public.founders set user_id = %L', tests.client_a()), 'permission denied', 'client cannot update founders');
select tests.throws(format('insert into public.business_members (business_id, user_id) values (%L, %L)', tests.biz_b(), tests.client_a()), 'permission denied', 'client cannot join another business');
select tests.throws(format('update public.business_members set business_id = %L', tests.biz_b()), 'permission denied', 'client cannot move its membership');
select tests.throws(format('select public.founder_add_member(%L, %L)', tests.biz_b(), tests.client_a()), '^FORBIDDEN', 'client cannot call founder_add_member');
select tests.throws($$select public.founder_create_business('Evil Co')$$, '^FORBIDDEN', 'client cannot create businesses');
select tests.throws('select private.audit(''FORGED'', null, null, ''FOUNDER'')', 'permission denied', 'client cannot write audit entries');
select tests.throws('select private.my_business_id()', 'permission denied', 'client cannot call private helpers beyond role checks');
select tests.throws('select public.internal_complete_analysis(gen_random_uuid(), ''COMPLETE'')', 'permission denied', 'client cannot record analyses');

-- A forged JWT role claim does not unlock server-only functions for an authenticated session.
select set_config('request.jwt.claims', json_build_object('sub', tests.client_a(), 'role', 'service_role')::text, true);
select tests.throws('select public.internal_complete_analysis(gen_random_uuid(), ''COMPLETE'')', 'permission denied', 'claiming service_role in the JWT does not grant execute');

-- Founder bootstrap is only possible for the database administrator.
select tests.login(tests.founder());
select tests.throws(format('insert into public.founders (user_id) values (%L)', tests.client_b()), 'permission denied', 'even a founder cannot add founders through the API');
select tests.throws(format('select public.founder_add_member(%L, %L)', tests.biz_a(), tests.founder()), '^VALIDATION', 'a founder cannot be made a client member');
select tests.throws(format('select public.founder_add_member(%L, %L)', tests.biz_b(), tests.client_a()), '^VALIDATION', 'a client cannot belong to two businesses');
select tests.lives(format('select public.founder_add_member(%L, %L)', tests.biz_b(), tests.unassigned()), 'founder links an invited user to a business');
select tests.login(tests.unassigned());
select tests.is((public.whoami()) ->> 'role', 'CLIENT', 'linked user becomes a CLIENT of that business');
rollback;

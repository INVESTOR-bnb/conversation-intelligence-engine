-- LOCAL TEST HARNESS ONLY. Assertion and identity helpers.
-- Each test file runs inside one transaction that is rolled back.

create schema tests;
grant usage on schema tests to public;

-- Synthetic identities (fixed ids; no real people).
create function tests.founder() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-00000000000f'::uuid $$;
create function tests.client_a() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-00000000000a'::uuid $$;
create function tests.client_a2() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-0000000000a2'::uuid $$;
create function tests.client_b() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-00000000000b'::uuid $$;
create function tests.unassigned() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-00000000000e'::uuid $$;
create function tests.biz_a() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-00000000000a'::uuid $$;
create function tests.biz_b() returns uuid language sql immutable as $$ select '10000000-0000-4000-8000-00000000000b'::uuid $$;

-- Seeds synthetic users, the founder row (as an administrator would) and two
-- businesses with their members. Must run as the database owner.
create function tests.seed() returns void language plpgsql as $$
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (tests.founder(), 'founder@synthetic.test', '{}'),
    (tests.client_a(), 'client-a@synthetic.test', '{"role":"FOUNDER"}'),   -- metadata claim must grant nothing
    (tests.client_a2(), 'client-a2@synthetic.test', '{}'),
    (tests.client_b(), 'client-b@synthetic.test', '{}'),
    (tests.unassigned(), 'invited@synthetic.test', '{}');
  insert into public.founders (user_id) values (tests.founder());
  insert into public.businesses (id, name, industry) values
    (tests.biz_a(), 'Synthetic Autos A', 'Automotive'), (tests.biz_b(), 'Synthetic Academy B', 'Training');
  insert into public.business_members (business_id, user_id) values
    (tests.biz_a(), tests.client_a()), (tests.biz_a(), tests.client_a2()), (tests.biz_b(), tests.client_b());
end $$;

-- Switch identity for the rest of the transaction, like PostgREST does per request.
create function tests.login(p_uid uuid, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)::text
         else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  execute format('set local role %I', p_role);
end $$;
create function tests.as_anon() returns void language sql as $$ select tests.login(null, 'anon') $$;
create function tests.as_service() returns void language sql as $$ select tests.login(null, 'service_role') $$;
create function tests.as_owner() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

create function tests.ok(p_cond boolean, p_desc text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_desc;
  end if;
  raise notice 'ok - %', p_desc;
end $$;

create function tests.is(p_actual anyelement, p_expected anyelement, p_desc text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % (expected %, got %)', p_desc, p_expected, p_actual;
  end if;
  raise notice 'ok - %', p_desc;
end $$;

-- Expects the statement to fail with an error message matching p_pattern.
create function tests.throws(p_sql text, p_pattern text, p_desc text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm ~* p_pattern then
      raise notice 'ok - %', p_desc;
      return;
    end if;
    raise exception 'FAIL: % (error "%" does not match /%/)', p_desc, sqlerrm, p_pattern;
  end;
  raise exception 'FAIL: % (statement succeeded but should have failed)', p_desc;
end $$;

-- Expects a statement to succeed.
create function tests.lives(p_sql text, p_desc text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise notice 'ok - %', p_desc;
exception when others then
  raise exception 'FAIL: % (%)', p_desc, sqlerrm;
end $$;

create function tests.count(p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin
  execute format('select count(*) from (%s) q', p_sql) into v;
  return v;
end $$;

-- Drives a new TEXT case for the given client to AWAITING_ADMIN_REVIEW with a
-- completed (synthetic) analysis. Returns the case id; leaves the session as owner.
create function tests.case_in_review(
  p_client uuid, p_ai_classification public.classification default 'GREEN',
  p_ai_message text default 'Synthetic proposed message.', p_restrictions jsonb default '[]'::jsonb
) returns uuid language plpgsql as $$
declare
  v_case uuid;
  v_analysis uuid;
begin
  perform tests.login(p_client);
  v_case := public.client_create_case(gen_random_uuid(), 'T-1', 'Synthetic product', 'Referral', 'TEXT',
    'Prospect: Is it available?' || chr(10) || 'Business: Yes it is, synthetic test.');
  perform public.client_submit_case(v_case);
  perform tests.login(tests.founder());
  v_analysis := public.founder_start_analysis(v_case);
  perform tests.as_service();
  perform public.internal_complete_analysis(v_analysis, 'COMPLETE', 'synthetic-model', 'test', '{"synthetic":true}'::jsonb,
    p_ai_classification, case when p_ai_classification = 'RED' then null else p_ai_message end, p_restrictions);
  perform tests.as_owner();
  return v_case;
end $$;

create function tests.latest_analysis(p_case uuid) returns public.analyses language sql as $$
  select * from public.analyses where case_id = p_case order by version desc limit 1
$$;

grant execute on all functions in schema tests to public;

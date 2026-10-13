-- Stage 2A-6a: internal_ai_reservation_terms returns exactly what the ledger reserved
-- (per-call model, output cap, input bound and snapshotted prices), to the service role
-- only, without writing anything. Synthetic data and synthetic prices only.
begin;
select tests.as_owner();
select tests.seed();

create function pg_temp.new_case(p_bytes integer default 100) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.cases (business_id, reference, product_service, lead_source, conversation_source, idempotency_key, workflow_state, evidence_version)
  values (tests.biz_a(), 'RT-' || left(gen_random_uuid()::text, 8), 'Synthetic', 'Referral', 'TEXT', gen_random_uuid(), 'SUBMITTED', 1) returning id into v;
  insert into public.case_messages (case_id, business_id, kind, body) values (v, tests.biz_a(), 'PASTED_CONVERSATION', rpad('Prospect: synthetic ', p_bytes, 'x'));
  return v;
end $$;
create function pg_temp.start(p_case uuid) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform tests.login(tests.founder());
  v := public.founder_start_analysis(p_case);
  perform tests.as_owner();
  return v;
end $$;
create function pg_temp.as_service(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform tests.as_service();
  execute p_sql into v;
  perform tests.as_owner();
  return v;
end $$;
create function pg_temp.terms(p_analysis uuid) returns jsonb language sql as $$
  select pg_temp.as_service(format('select public.internal_ai_reservation_terms(%L)', p_analysis))
$$;

update private.ai_spend_config set enabled = true where id;
insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note) values
  ('test-cheap', 1, 5, 1000, true, 'synthetic'), ('test-dear', 10, 50, 2000, true, 'synthetic');

-- ---------------------------------------------------------------- the terms are the ledger's, per call
select pg_temp.new_case() as c0 \gset
select pg_temp.start(:'c0') as a0 \gset
select pg_temp.as_service(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a0', 'test-cheap', 'test-dear')) as r0 \gset
select pg_temp.terms(:'a0') as t0 \gset

select tests.is(:'t0'::jsonb -> 'analyst',
  '{"model": "test-cheap", "max_output_tokens": 1000, "input_bound": 8664, "input_usd_per_mtok": 1.000000, "output_usd_per_mtok": 5.000000}'::jsonb,
  'analyst terms: model, output cap, input bound (8000 + 6 x 100 bytes + 64), snapshotted prices');
select tests.is(:'t0'::jsonb -> 'reviewer',
  '{"model": "test-dear", "max_output_tokens": 2000, "input_bound": 10664, "input_usd_per_mtok": 10.000000, "output_usd_per_mtok": 50.000000}'::jsonb,
  'reviewer terms: its own prices and cap; its input bound also covers the analyst output (+ 2 x 1000)');
select tests.ok((:'t0'::jsonb ->> 'reserved_usd')::numeric = (:'r0'::jsonb ->> 'reserved_usd')::numeric
                and (:'t0'::jsonb ->> 'reserved_usd')::numeric = 0.2204, 'the reserved amount equals the reservation''s (0.2204)');
select tests.ok(:'t0'::jsonb ->> 'status' = 'RESERVED' and :'t0'::jsonb ->> 'analysis_id' = :'a0', 'status and analysis id');
select tests.ok((:'t0'::jsonb -> 'analyst') - array['input_bound', 'input_usd_per_mtok', 'output_usd_per_mtok'] = :'r0'::jsonb -> 'analyst'
                and (:'t0'::jsonb -> 'reviewer') - array['input_bound', 'input_usd_per_mtok', 'output_usd_per_mtok'] = :'r0'::jsonb -> 'reviewer',
  'the model and cap agree with what the reservation itself returned');
select tests.ok((select (:'t0'::jsonb -> 'analyst' ->> 'input_bound')::int = analyst_input_bound
                        and (:'t0'::jsonb -> 'reviewer' ->> 'input_bound')::int = reviewer_input_bound
                        and (:'t0'::jsonb -> 'reviewer' ->> 'output_usd_per_mtok')::numeric = reviewer_out_price
                 from private.ai_spend_ledger where analysis_id = :'a0'), 'every value is the ledger row''s');
-- the reservation's own arithmetic, recomputed from the returned terms
select tests.ok((select ceil(((t -> 'analyst' ->> 'input_bound')::numeric * (t -> 'analyst' ->> 'input_usd_per_mtok')::numeric
                             + (t -> 'analyst' ->> 'max_output_tokens')::numeric * (t -> 'analyst' ->> 'output_usd_per_mtok')::numeric
                             + (t -> 'reviewer' ->> 'input_bound')::numeric * (t -> 'reviewer' ->> 'input_usd_per_mtok')::numeric
                             + (t -> 'reviewer' ->> 'max_output_tokens')::numeric * (t -> 'reviewer' ->> 'output_usd_per_mtok')::numeric) / 1000000 * 10000) / 10000
                 from (select :'t0'::jsonb t) x) = 0.2204, 'the returned terms reproduce the reserved amount exactly');

-- prices are the snapshot: a later price change does not alter an existing reservation's terms
update private.ai_model_prices set input_usd_per_mtok = 99, output_usd_per_mtok = 99 where model = 'test-cheap';
select tests.is(pg_temp.terms(:'a0') -> 'analyst' ->> 'input_usd_per_mtok', '1.000000', 'prices are the snapshot taken at reservation, not today''s price list');
update private.ai_model_prices set input_usd_per_mtok = 1, output_usd_per_mtok = 5 where model = 'test-cheap';

-- swapped models: each call carries its own model's terms
select pg_temp.new_case() as c1 \gset
select pg_temp.start(:'c1') as a1 \gset
select pg_temp.as_service(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a1', 'test-dear', 'test-cheap'));
select tests.ok((pg_temp.terms(:'a1') -> 'analyst' ->> 'model') = 'test-dear' and (pg_temp.terms(:'a1') -> 'reviewer' ->> 'input_bound')::int = 8664 + 2 * 2000,
  'swapped models: the analyst carries the dear model; the reviewer bound covers the dear analyst''s larger cap');

-- the status follows the ledger through settlement (terms stay readable for reconciliation)
select pg_temp.as_service(format('select public.internal_ai_dispatch(%L, %L)', :'a0', 'ANALYST'));
select tests.as_owner();
select tests.login(tests.founder());
select public.founder_abandon_analysis(:'a0');
select tests.as_owner();
select tests.is(pg_temp.terms(:'a0') ->> 'status', 'HELD', 'after an abandoned dispatched run the terms report HELD');

-- ---------------------------------------------------------------- refusals
select pg_temp.new_case() as c2 \gset
select pg_temp.start(:'c2') as a2 \gset
select tests.as_service();
select tests.throws(format('select public.internal_ai_reservation_terms(%L)', gen_random_uuid()), '^NOT_RESERVED', 'no reservation: NOT_RESERVED');
select tests.as_service();
select tests.throws(format('select public.internal_ai_reservation_terms(%L)', :'a2'), '^NOT_RESERVED', 'a started analysis without a reservation: NOT_RESERVED');
select tests.as_owner();

-- ---------------------------------------------------------------- authorisation
select tests.login(tests.founder());
select tests.throws(format('select public.internal_ai_reservation_terms(%L)', :'a1'), 'permission denied', 'the founder session cannot read reservation terms');
select tests.login(tests.client_a());
select tests.throws(format('select public.internal_ai_reservation_terms(%L)', :'a1'), 'permission denied', 'a business user cannot read reservation terms');
select tests.as_anon();
select tests.throws(format('select public.internal_ai_reservation_terms(%L)', :'a1'), 'permission denied', 'anonymous callers cannot read reservation terms');
select tests.as_owner();
set local role service_role;
select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "00000000-0000-4000-8000-00000000000f"}', true);
select tests.throws(format('select public.internal_ai_reservation_terms(%L)', :'a1'), '^FORBIDDEN', 'a non-service JWT is refused inside the function');
select tests.as_owner();

-- ---------------------------------------------------------------- definition
select tests.ok((select prosecdef and provolatile = 's' and proconfig @> array['search_path=""']
                 from pg_proc where oid = 'public.internal_ai_reservation_terms(uuid)'::regprocedure),
  'SECURITY DEFINER, STABLE (cannot write), empty search_path');
select tests.ok(has_function_privilege('service_role', 'public.internal_ai_reservation_terms(uuid)', 'EXECUTE')
                and not has_function_privilege('authenticated', 'public.internal_ai_reservation_terms(uuid)', 'EXECUTE')
                and not has_function_privilege('anon', 'public.internal_ai_reservation_terms(uuid)', 'EXECUTE'),
  'only the service role may execute it');
select (select count(*) from public.audit_log) || '/' || (select md5(string_agg(l::text, '' order by analysis_id)) from private.ai_spend_ledger l) as before_read \gset
select pg_temp.terms(:'a1'), pg_temp.terms(:'a1'), pg_temp.terms(:'a0');
select tests.is((select count(*) from public.audit_log) || '/' || (select md5(string_agg(l::text, '' order by analysis_id)) from private.ai_spend_ledger l), :'before_read',
  'reading the terms writes nothing: no audit row, ledger unchanged');
rollback;

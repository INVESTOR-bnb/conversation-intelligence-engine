-- Stage 2A-6e: the kimi-k3 price row exists exactly as reviewed (3/15, no cached-input
-- discount), INACTIVE; it cannot be reserved; the other price rows, the configuration and the
-- disabled state are unchanged; nobody but the database owner can read prices. When activated
-- (inside this rolled-back test only) one analysis reserves BOTH calls at their caps.
-- Synthetic data only; everything is rolled back.
begin;
select tests.as_owner();
select tests.seed();

select tests.is((select format('%s:%s:%s:%s:%s', model, input_usd_per_mtok::numeric(8,2), output_usd_per_mtok::numeric(8,2), max_output_tokens, active)
                 from private.ai_model_prices where model = 'kimi-k3'),
  'kimi-k3:3.00:15.00:8000:f', 'kimi-k3 3/15 per million tokens, cap 8000, inactive');
select tests.is((select string_agg(model, ',' order by model) from private.ai_model_prices where active), 'FAKE-PROVIDER-NOT-AI',
  'the fake provider is still the only active model');
select tests.ok((select not enabled and budget_usd = 20 and stop_at_usd = 18 and max_reservation_usd = 1 from private.ai_spend_config where id),
  'spending disabled; budget 20, stop 18, max 1 per analysis');

-- The inactive row cannot be reserved, even with spending enabled (inside this rolled-back test).
update private.ai_spend_config set enabled = true where id;
insert into public.cases (business_id, reference, product_service, lead_source, conversation_source, idempotency_key, workflow_state, evidence_version)
values (tests.biz_a(), 'KP-1', 'Synthetic', 'Referral', 'TEXT', gen_random_uuid(), 'SUBMITTED', 1);
insert into public.case_messages (case_id, business_id, kind, body)
select id, tests.biz_a(), 'PASTED_CONVERSATION', rpad('Prospect: synthetic ', 100, 'x') from public.cases where reference = 'KP-1';
select tests.login(tests.founder());
select public.founder_start_analysis((select id from public.cases where reference = 'KP-1')) as a \gset
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a', 'kimi-k3', 'kimi-k3'), '^MODEL_NOT_PRICED',
  'an inactive kimi-k3 cannot be reserved');
select tests.as_owner();
select tests.ok(not exists (select 1 from private.ai_spend_ledger where analysis_id = :'a'), 'nothing was reserved');

-- Activated (rolled back at the end): the reservation prices both calls at the full cap.
update private.ai_model_prices set active = true where model = 'kimi-k3';
select tests.as_service();
select public.internal_reserve_ai_spend(:'a', 'kimi-k3', 'kimi-k3') as r \gset
select tests.as_owner();
select tests.is((select format('%s|%s|%s|%s|%s', reserved_usd, analyst_max_output, reviewer_max_output, analyst_in_price + reviewer_in_price, analyst_out_price + reviewer_out_price)
                 from private.ai_spend_ledger where analysis_id = :'a'),
  '0.3400|8000|8000|6.000000|30.000000', 'one analysis reserves analyst AND reviewer, 8000 output each, at 3/15: USD 0.34 (within the USD 1 limit)');

-- Prices are private.
select tests.login(tests.founder());
select tests.throws('select count(*) from private.ai_model_prices', 'permission denied', 'the founder session cannot read prices');
select tests.login(tests.client_a());
select tests.throws('select count(*) from private.ai_model_prices', 'permission denied', 'a business user cannot read prices');
select tests.as_owner();
rollback;

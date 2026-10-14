-- Stage 2A-6c: the two Anthropic price rows exist exactly as reviewed, INACTIVE; they cannot be
-- reserved; the fake row, the configuration and the disabled state are unchanged; nobody but
-- the database owner can read prices. Synthetic data only; everything is rolled back.
begin;
select tests.as_owner();
select tests.seed();

select tests.is((select string_agg(format('%s:%s:%s:%s:%s', model, input_usd_per_mtok::numeric(8,2), output_usd_per_mtok::numeric(8,2), max_output_tokens, active), ',' order by model)
                 from private.ai_model_prices where model in ('claude-opus-5-5', 'claude-sonnet-5-5')),
  'claude-opus-5-5:4.00:20.00:8000:f,claude-sonnet-5-5:2.00:10.00:8000:f',
  'Opus 4/20 and Sonnet 2/10 per million tokens, cap 8000 each, both inactive');
select tests.is((select string_agg(model, ',' order by model) from private.ai_model_prices where active), 'FAKE-PROVIDER-NOT-AI',
  'the fake provider is the only active model');
select tests.ok((select input_usd_per_mtok = 0 and output_usd_per_mtok = 0 and max_output_tokens = 1 from private.ai_model_prices where model = 'FAKE-PROVIDER-NOT-AI'),
  'the fake row is unchanged (0/0, cap 1)');
select tests.ok((select not enabled and budget_usd = 20 and stop_at_usd = 18 and max_reservation_usd = 1 from private.ai_spend_config where id),
  'spending disabled; budget 20, stop 18, max 1 per analysis');

-- Inactive rows cannot be reserved, even with spending enabled (inside this rolled-back test).
update private.ai_spend_config set enabled = true where id;
insert into public.cases (business_id, reference, product_service, lead_source, conversation_source, idempotency_key, workflow_state, evidence_version)
values (tests.biz_a(), 'MP-1', 'Synthetic', 'Referral', 'TEXT', gen_random_uuid(), 'SUBMITTED', 1);
insert into public.case_messages (case_id, business_id, kind, body)
select id, tests.biz_a(), 'PASTED_CONVERSATION', rpad('Prospect: synthetic ', 100, 'x') from public.cases where reference = 'MP-1';
select tests.login(tests.founder());
select public.founder_start_analysis((select id from public.cases where reference = 'MP-1')) as a \gset
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a', 'claude-opus-5-5', 'claude-opus-5-5'), '^MODEL_NOT_PRICED',
  'an inactive Opus cannot be reserved');
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a', 'FAKE-PROVIDER-NOT-AI', 'claude-sonnet-5-5'), '^MODEL_NOT_PRICED',
  'an inactive Sonnet cannot be reserved as the reviewer');
select tests.as_owner();
select tests.ok(not exists (select 1 from private.ai_spend_ledger where analysis_id = :'a'), 'nothing was reserved');

-- Prices are private.
select tests.login(tests.founder());
select tests.throws('select count(*) from private.ai_model_prices', 'permission denied', 'the founder session cannot read prices');
select tests.login(tests.client_a());
select tests.throws('select count(*) from private.ai_model_prices', 'permission denied', 'a business user cannot read prices');
select tests.as_owner();
rollback;

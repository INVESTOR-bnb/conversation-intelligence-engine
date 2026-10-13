-- Stage 2A-5d-3a: server-enforced AI spending controls. Reservations computed by the
-- database, dispatch recorded before any provider request, settlement only from the
-- dispatch record (never from caller-reported zeros), budget and rate limits,
-- reconciliation, founder-only visibility. Synthetic data and synthetic prices only.
begin;
select tests.as_owner();
select tests.seed();

-- ---------------------------------------------------------------- fixtures
-- A submitted TEXT case of business A whose pasted conversation is exactly p_bytes ASCII bytes.
create function pg_temp.new_case(p_bytes integer default 100) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.cases (business_id, reference, product_service, lead_source, conversation_source, idempotency_key, workflow_state, evidence_version)
  values (tests.biz_a(), 'SP-' || left(gen_random_uuid()::text, 8), 'Synthetic', 'Referral', 'TEXT', gen_random_uuid(), 'SUBMITTED', 1) returning id into v;
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
create function pg_temp.reserve(p_analysis uuid, p_a text default 'test-cheap', p_r text default 'test-dear') returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform tests.as_service();
  v := public.internal_reserve_ai_spend(p_analysis, p_a, p_r);
  perform tests.as_owner();
  return v;
end $$;
create function pg_temp.dispatch(p_analysis uuid, p_role text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform tests.as_service();
  v := public.internal_ai_dispatch(p_analysis, p_role);
  perform tests.as_owner();
  return v;
end $$;
create function pg_temp.usage(p_analysis uuid, p_role text, p_in integer, p_out integer) returns void language plpgsql as $$
begin
  perform tests.as_service();
  perform public.internal_ai_report_usage(p_analysis, p_role, p_in, p_out);
  perform tests.as_owner();
end $$;
-- Completes the analysis as ERROR (as the pipeline does on a failure), reporting whatever tokens it is given.
create function pg_temp.fail_run(p_analysis uuid, p_in integer default 0, p_out integer default 0) returns void language plpgsql as $$
begin
  perform tests.as_service();
  perform public.internal_complete_analysis(p_analysis, 'ERROR', p_input_tokens => p_in, p_output_tokens => p_out, p_error => 'PIPELINE_ERROR: SYNTHETIC');
  perform tests.as_owner();
end $$;
create function pg_temp.abandon(p_analysis uuid) returns void language plpgsql as $$
begin
  perform tests.login(tests.founder());
  perform public.founder_abandon_analysis(p_analysis);
  perform tests.as_owner();
end $$;
create function pg_temp.ledger(p_analysis uuid) returns private.ai_spend_ledger language sql as $$
  select * from private.ai_spend_ledger where analysis_id = p_analysis
$$;
create function pg_temp.committed() returns numeric language sql as $$ select private.ai_committed_usd() $$;
create function pg_temp.age_ledger() returns void language sql as $$
  update private.ai_spend_ledger set created_at = created_at - interval '25 hours'
$$;

-- Synthetic prices (USD per million tokens) for two differently priced test models.
insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note) values
  ('test-cheap', 1, 5, 1000, true, 'synthetic'), ('test-dear', 10, 50, 2000, true, 'synthetic'),
  ('test-inactive', 1, 1, 100, false, 'synthetic');

-- ---------------------------------------------------------------- the approved defaults; disabled by default
select tests.ok((select budget_usd = 20 and stop_at_usd = 18 and max_reservation_usd = 1 and founder_attempts_24h = 10
                        and case_attempts_24h = 3 and case_attempts_total = 10 and not enabled from private.ai_spend_config),
  'defaults: $20 budget, stop at $18, $1 per analysis, 10/founder/24h, 3/case/24h, 10/case total, DISABLED');
select tests.ok((select active and input_usd_per_mtok = 0 and output_usd_per_mtok = 0 from private.ai_model_prices where model = 'FAKE-PROVIDER-NOT-AI'),
  'only the fake provider is seeded, at price 0');
select pg_temp.new_case() as c0 \gset
select pg_temp.start(:'c0') as a0 \gset
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a0', 'test-cheap', 'test-dear'), '^SPENDING_DISABLED', 'spending is disabled by default: no reservation');
select tests.as_owner();
select tests.is(tests.count('select 1 from private.ai_spend_ledger'), 0::bigint, '... and nothing was written');
update private.ai_spend_config set enabled = true;

-- ---------------------------------------------------------------- authorisation
select tests.login(tests.founder());
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a0', 'test-cheap', 'test-dear'), 'permission denied', 'the founder cannot reserve (service role only)');
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a0', 'ANALYST'), 'permission denied', 'the founder cannot dispatch');
select tests.throws(format('select public.internal_ai_report_usage(%L, %L, 1, 1)', :'a0', 'ANALYST'), 'permission denied', 'the founder cannot report usage');
select tests.throws('update private.ai_spend_config set budget_usd = 1000', 'permission denied', 'the founder cannot raise the budget');
select tests.throws('update private.ai_spend_config set enabled = true', 'permission denied', 'the founder cannot enable spending');
select tests.throws('insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active) values (''x'', 0, 0, 1, true)',
  'permission denied', 'the founder cannot add or change prices');
select tests.throws('select count(*) from private.ai_spend_ledger', 'permission denied', 'the founder cannot read the ledger directly');
select tests.throws(format('select private.ai_reconcile(%L, 0, %L)', :'a0', 'a synthetic reconciliation note'), 'permission denied', 'the founder cannot reconcile');
select tests.throws(format('select private.ai_settle(%L)', :'a0'), 'permission denied', 'the founder cannot settle');
select tests.ok((public.founder_ai_spend_summary() ->> 'enabled')::boolean, 'the founder reads the spending summary');
select tests.login(tests.client_a());
select tests.throws('select public.founder_ai_spend_summary()', '^FORBIDDEN', 'a business user cannot read the summary');
select tests.throws('select count(*) from private.ai_spend_ledger', 'permission denied', 'a business user cannot read the ledger');
select tests.throws('select count(*) from private.ai_spend_config', 'permission denied', 'a business user cannot read the configuration');
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a0', 'test-cheap', 'test-dear'), 'permission denied', 'a business user cannot reserve');
select tests.as_anon();
select tests.throws('select public.founder_ai_spend_summary()', 'permission denied', 'anonymous: no summary');
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a0', 'ANALYST'), 'permission denied', 'anonymous: no dispatch');
select tests.as_service();
select tests.throws('select public.founder_ai_spend_summary()', 'permission denied', 'the service role has no founder summary');
select tests.throws('update private.ai_spend_config set budget_usd = 1000', 'permission denied', 'the service role cannot raise the budget');
select tests.throws(format('select private.ai_reconcile(%L, 0, %L)', :'a0', 'a synthetic reconciliation note'), 'permission denied', 'the service role cannot reconcile');
select tests.as_owner();
-- The function itself also checks the JWT role (defence in depth, as internal_complete_analysis does).
select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "00000000-0000-4000-8000-00000000000f"}', true);
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a0', 'test-cheap', 'test-dear'), '^FORBIDDEN', 'a non-service JWT is refused inside the function');
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a0', 'ANALYST'), '^FORBIDDEN', '... dispatch too');
select tests.throws(format('select public.internal_ai_report_usage(%L, %L, 1, 1)', :'a0', 'ANALYST'), '^FORBIDDEN', '... usage too');
select tests.as_owner();

-- ---------------------------------------------------------------- the reservation formula (per model, per call)
-- 100-byte conversation, 1 message, 0 screenshots; analyst test-cheap (1/5 per M, cap 1000), reviewer test-dear (10/50, cap 2000):
--   E = 6*100 + 64 = 664;  A_in = 8000 + 664 = 8664;  A_out = 1000;  R_in = 8664 + 2*1000 = 10664;  R_out = 2000
--   USD = (8664*1 + 1000*5 + 10664*10 + 2000*50) / 1e6 = 0.220304 -> 0.2204 (rounded up)
select pg_temp.reserve(:'a0') as r0 \gset
select tests.is((:'r0'::jsonb ->> 'reserved_usd')::numeric, 0.2204, 'reservation: each call at its own model''s prices and output cap, reviewer receives the analyst output');
select tests.is(:'r0'::jsonb -> 'analyst', '{"model": "test-cheap", "max_output_tokens": 1000}'::jsonb, 'the analyst output cap the pipeline must use');
select tests.is(:'r0'::jsonb -> 'reviewer', '{"model": "test-dear", "max_output_tokens": 2000}'::jsonb, 'the reviewer output cap the pipeline must use');
select tests.ok((select analyst_input_bound = 8664 and reviewer_input_bound = 10664 and analyst_in_price = 1 and reviewer_out_price = 50 and status = 'RESERVED'
                 from private.ai_spend_ledger where analysis_id = :'a0'), 'the ledger snapshots bounds and prices');
-- Swapping the models changes the amount (prices are per role, not averaged).
select pg_temp.new_case() as c1 \gset
select pg_temp.start(:'c1') as a1 \gset
-- A_in*10 + A_out(2000)*50 + R_in(8664+4000)*1 + R_out(1000)*5 = 86640 + 100000 + 12664 + 5000 = 204304 -> 0.2044
select tests.is((pg_temp.reserve(:'a1', 'test-dear', 'test-cheap') ->> 'reserved_usd')::numeric, 0.2044, 'swapped models: a different, per-role amount');
-- Screenshots and message count are included.
select pg_temp.new_case() as c2 \gset
insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
select :'c2', tests.biz_a(), p, format('%s/%s/%s-%s.png', tests.biz_a(), :'c2', p, repeat(p::text, 64)), 'image/png', 1000, repeat(p::text, 64), tests.client_a()
from generate_series(1, 2) p;
select pg_temp.start(:'c2') as a2 \gset
-- E = 664 + 2*5000 = 10664: A_in 18664, R_in 20664 -> 18664 + 5000 + 206640 + 100000 = 330304 -> 0.3304
select tests.is((pg_temp.reserve(:'a2') ->> 'reserved_usd')::numeric, 0.3304, 'two screenshots add the per-image ceiling to both calls');
select pg_temp.abandon(:'a1');
select pg_temp.abandon(:'a2');

-- ---------------------------------------------------------------- refusals (nothing written)
select pg_temp.new_case() as c3 \gset
select pg_temp.start(:'c3') as a3 \gset
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a3', 'no-such-model', 'test-dear'), '^MODEL_NOT_PRICED', 'an unknown model is refused');
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a3', 'test-cheap', 'test-inactive'), '^MODEL_NOT_PRICED', 'an inactive (unapproved) model is refused');
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a3', 'test-inactive', 'test-dear'), '^MODEL_NOT_PRICED', '... as the analyst too');
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a0', 'test-cheap', 'test-dear'), '^INVALID_STATE', 'a second reservation for the same analysis is refused');
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', gen_random_uuid(), 'test-cheap', 'test-dear'), '^NOT_FOUND', 'an unknown analysis is refused');
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a1', 'test-cheap', 'test-dear'), '^INVALID_STATE', 'a finished analysis cannot reserve');
select tests.as_owner();
update private.ai_spend_config set max_reservation_usd = 0.2;
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a3', 'test-cheap', 'test-dear'), '^RESERVATION_TOO_LARGE', 'a reservation above the per-analysis maximum is refused');
select tests.as_owner();
update private.ai_spend_config set max_reservation_usd = 1;
-- A snapshot that cannot be measured (a listed message no longer readable) refuses.
select pg_temp.new_case() as c4 \gset
select pg_temp.start(:'c4') as a4 \gset
delete from public.case_messages where case_id = :'c4';
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a4', 'test-cheap', 'test-dear'), '^VALIDATION', 'an unmeasurable evidence snapshot is refused');
select tests.as_owner();
select tests.is(tests.count(format('select 1 from private.ai_spend_ledger where analysis_id in (%L, %L)', :'a3', :'a4')), 0::bigint, 'refusals write nothing');
select pg_temp.abandon(:'a3');
select pg_temp.abandon(:'a4');

-- ---------------------------------------------------------------- dispatch rules
select tests.as_service();
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a0', 'REVIEWER'), '^INVALID_STATE', 'the reviewer cannot be dispatched before the analyst');
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a0', 'JUDGE'), '^VALIDATION', 'unknown role');
select tests.throws(format('select public.internal_ai_report_usage(%L, %L, 1, 1)', :'a0', 'ANALYST'), '^NOT_DISPATCHED', 'usage cannot be reported for an undispatched call');
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a3', 'ANALYST'), '^NOT_RESERVED', 'no dispatch without a reservation');
select tests.as_owner();
select tests.is(pg_temp.dispatch(:'a0', 'ANALYST'), '{"model": "test-cheap", "max_output_tokens": 1000}'::jsonb, 'analyst dispatch is recorded and returns the cap');
select tests.ok((pg_temp.ledger(:'a0')).analyst_dispatched_at is not null, '... the dispatch time is stored before any request');
select tests.as_service();
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a0', 'ANALYST'), '^ALREADY_DISPATCHED', 'no second analyst request (no retries within a reservation)');
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a0', 'REVIEWER'), '^INVALID_STATE', 'the reviewer waits for the analyst''s usage');
select tests.throws(format('select public.internal_ai_report_usage(%L, %L, -1, 1)', :'a0', 'ANALYST'), '^VALIDATION', 'negative tokens are refused');
select tests.throws(format('select public.internal_ai_report_usage(%L, %L, null, 1)', :'a0', 'ANALYST'), '^VALIDATION', 'missing tokens are refused');
select tests.as_owner();
select pg_temp.usage(:'a0', 'ANALYST', 5000, 800);
select tests.as_service();
select tests.throws(format('select public.internal_ai_report_usage(%L, %L, 1, 1)', :'a0', 'ANALYST'), '^ALREADY_REPORTED', 'usage is reported once');
select tests.as_owner();
select pg_temp.dispatch(:'a0', 'REVIEWER');
select pg_temp.usage(:'a0', 'REVIEWER', 7000, 1500);

-- ---------------------------------------------------------------- settlement: reported usage (different-priced models)
select tests.as_service();
select public.internal_complete_analysis(:'a0', 'COMPLETE', 'synthetic', 'v1', tests.contract_output(:'a0', 'GREEN', 'Synthetic pitch.'),
  'GREEN', 'Synthetic pitch.', '[]', 1, 1, 0);
select tests.as_owner();
-- analyst 5000*1 + 800*5 = 9000; reviewer 7000*10 + 1500*50 = 145000 -> 0.154
select tests.ok((select status = 'SETTLED' and settled_by = 'REPORTED_USAGE' and actual_usd = 0.1540 and not overrun from private.ai_spend_ledger where analysis_id = :'a0'),
  'settled from per-call usage at each model''s own snapshotted prices (not from the completion''s token totals)');
select tests.is((select status::text from public.analyses where id = :'a0'), 'COMPLETE', 'the analysis itself is stored as before (contract unchanged)');
select tests.is((select estimated_cost_usd from public.analyses where id = :'a0'), 0::numeric(10,4), '... and the pipeline''s own reported figures are kept as reported');

-- ---------------------------------------------------------------- settlement: $0 only when nothing was dispatched
select pg_temp.age_ledger();   -- keep the founder's 24-hour attempt window clear for the cases below
select pg_temp.new_case() as c5 \gset
select pg_temp.start(:'c5') as a5 \gset
select pg_temp.reserve(:'a5');
select pg_temp.fail_run(:'a5', 999, 999);
select tests.ok((select status = 'SETTLED' and settled_by = 'NO_DISPATCH' and actual_usd = 0 from private.ai_spend_ledger where analysis_id = :'a5'),
  'no dispatch recorded: released at $0 (whatever tokens the completion reports)');

-- A request that fails AFTER dispatch, with zero tokens reported, is NOT released.
select pg_temp.new_case() as c6 \gset
select pg_temp.start(:'c6') as a6 \gset
select pg_temp.reserve(:'a6');
select pg_temp.dispatch(:'a6', 'ANALYST');
select pg_temp.fail_run(:'a6', 0, 0);
select tests.ok((select status = 'HELD' and settled_by = 'UNKNOWN_USAGE' and actual_usd = 0 and reserved_usd = 0.2204 from private.ai_spend_ledger where analysis_id = :'a6'),
  'dispatched, then failed with "0 tokens" reported: HELD at the full reservation (no false zero)');
select tests.is(pg_temp.committed() >= 0.1540 + 0.2204, true, 'the held reservation still counts in full');
-- A late usage report is stored but does not release a held reservation.
select pg_temp.usage(:'a6', 'ANALYST', 10, 10);
select tests.is((pg_temp.ledger(:'a6')).status, 'HELD', 'a late usage report does not release a held reservation');

-- Analyst reported, reviewer dispatched but lost: HELD, counting max(reservation, known usage).
select pg_temp.new_case() as c7 \gset
select pg_temp.start(:'c7') as a7 \gset
select pg_temp.reserve(:'a7');
select pg_temp.dispatch(:'a7', 'ANALYST');
select pg_temp.usage(:'a7', 'ANALYST', 5000, 800);
select pg_temp.dispatch(:'a7', 'REVIEWER');
select pg_temp.fail_run(:'a7');
select tests.ok((select status = 'HELD' and actual_usd = 0.0090 from private.ai_spend_ledger where analysis_id = :'a7'),
  'partial usage known (analyst), reviewer lost: HELD, with the known part recorded');

-- Abandoned runs: no dispatch -> $0; dispatched -> HELD.
select pg_temp.new_case() as c8 \gset
select pg_temp.start(:'c8') as a8 \gset
select pg_temp.reserve(:'a8');
select pg_temp.abandon(:'a8');
select tests.is((pg_temp.ledger(:'a8')).settled_by, 'NO_DISPATCH', 'abandoned before any dispatch: released at $0');
select pg_temp.new_case() as c9 \gset
select pg_temp.start(:'c9') as a9 \gset
select pg_temp.reserve(:'a9');
select pg_temp.dispatch(:'a9', 'ANALYST');
select pg_temp.abandon(:'a9');
select tests.is((pg_temp.ledger(:'a9')).status, 'HELD', 'abandoned after dispatch (e.g. a crash or timeout): HELD');
select tests.as_service();
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'a9', 'REVIEWER'), '^INVALID_STATE', 'no dispatch after settlement');
select tests.as_owner();

-- A stuck run (process killed, analysis still PENDING) keeps its reservation in full.
select pg_temp.new_case() as c10 \gset
select pg_temp.start(:'c10') as a10 \gset
select pg_temp.reserve(:'a10');
select pg_temp.dispatch(:'a10', 'ANALYST');
select tests.is((pg_temp.ledger(:'a10')).status, 'RESERVED', 'a crashed run stays RESERVED (counted in full) while its analysis is PENDING');
select tests.throws(format('select private.ai_reconcile(%L, 0.01, %L)', :'a10', 'synthetic: provider console shows 0.01'), '^INVALID_STATE',
  'a reservation whose analysis is still running cannot be reconciled');

-- A rejected analysis still settles what was spent.
select pg_temp.new_case() as c11 \gset
select pg_temp.start(:'c11') as a11 \gset
select pg_temp.reserve(:'a11');
select pg_temp.dispatch(:'a11', 'ANALYST');
select pg_temp.usage(:'a11', 'ANALYST', 100, 100);
select tests.as_service();
select public.internal_complete_analysis(:'a11', 'COMPLETE', 'synthetic', 'v1', '{"verdict": "nonsense"}', 'GREEN', 'x', '[]');
select tests.as_owner();
select tests.ok((select a.status = 'ERROR' and a.error like 'REJECTED by analysis contract%' and l.status = 'SETTLED' and l.actual_usd = 0.0006
                 from public.analyses a join private.ai_spend_ledger l on l.analysis_id = a.id where a.id = :'a11'),
  'a contract-rejected analysis is still rejected, and its real spend is settled');

-- ---------------------------------------------------------------- reconciliation (database owner only)
select tests.throws(format('select private.ai_reconcile(%L, 0.01, %L)', :'a6', 'short'), '^VALIDATION', 'reconciliation needs a real explanation');
select tests.throws(format('select private.ai_reconcile(%L, -1, %L)', :'a6', 'synthetic: provider console shows nothing'), '^VALIDATION', 'no negative amounts');
select tests.throws(format('select private.ai_reconcile(%L, 0.01, %L)', :'a0', 'synthetic: provider console shows 0.01'), '^INVALID_STATE', 'a settled reservation is not reconciled');
select pg_temp.committed() as before_rec \gset
select private.ai_reconcile(:'a6', 0.0123, 'synthetic: provider console shows 0.0123 for this request');
select tests.ok((select status = 'RECONCILED' and actual_usd = 0.0123 and reconciliation_note like 'synthetic%' from private.ai_spend_ledger where analysis_id = :'a6'),
  'a held reservation is reconciled to the billed amount');
select tests.is(pg_temp.committed(), :'before_rec'::numeric - 0.2204 + 0.0123, 'committed spend drops by exactly the released part');
select tests.ok(exists (select 1 from public.audit_log where action = 'AI_SPEND_RECONCILED' and details ->> 'analysis_id' = :'a6' and client_label is null),
  'reconciliation is audited (never shown to clients)');

-- ---------------------------------------------------------------- overrun: recorded, flagged, spending disabled
select pg_temp.new_case() as c12 \gset
select pg_temp.start(:'c12') as a12 \gset
select pg_temp.reserve(:'a12');
select pg_temp.dispatch(:'a12', 'ANALYST');
select pg_temp.usage(:'a12', 'ANALYST', 2000000, 200000);
select pg_temp.fail_run(:'a12');
select tests.ok((select status = 'SETTLED' and overrun and actual_usd = 3.0000 from private.ai_spend_ledger where analysis_id = :'a12'),
  'usage above the reservation is recorded at its real amount and flagged');
select tests.ok(not (select enabled from private.ai_spend_config), '... and all further spending is disabled');
select tests.ok(exists (select 1 from public.audit_log where action = 'AI_SPEND_OVERRUN' and details ->> 'analysis_id' = :'a12'), '... and audited');
select pg_temp.new_case() as c13 \gset
select pg_temp.start(:'c13') as a13 \gset
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a13', 'test-cheap', 'test-dear'), '^SPENDING_DISABLED', 'after an overrun no new reservation is accepted');
select tests.as_owner();
update private.ai_spend_config set enabled = true;

-- ---------------------------------------------------------------- budget: stop line, exhaustion
select pg_temp.age_ledger();
update private.ai_spend_config set stop_at_usd = pg_temp.committed() + 0.4408;
select pg_temp.reserve(:'a13');
select pg_temp.new_case() as c14 \gset
select pg_temp.start(:'c14') as a14 \gset
select pg_temp.reserve(:'a14');
select tests.ok(pg_temp.committed() = (select stop_at_usd from private.ai_spend_config), 'reservations up to exactly the stop line are accepted');
select pg_temp.new_case() as c15 \gset
select pg_temp.start(:'c15') as a15 \gset
select tests.as_service();
select tests.throws(format('select public.internal_reserve_ai_spend(%L, %L, %L)', :'a15', 'test-cheap', 'test-dear'), '^BUDGET_EXCEEDED', 'the next reservation would pass the stop line: refused');
select tests.as_owner();
-- A zero-priced (fake) run still fits; settling a reservation frees exactly its unused part.
select tests.is((pg_temp.reserve(:'a15', 'FAKE-PROVIDER-NOT-AI', 'FAKE-PROVIDER-NOT-AI') ->> 'reserved_usd')::numeric, 0::numeric, 'the fake provider reserves $0');
select pg_temp.abandon(:'a14');
select tests.ok(pg_temp.committed() < (select stop_at_usd from private.ai_spend_config), 'releasing an undispatched reservation frees budget');
update private.ai_spend_config set stop_at_usd = 18;
select pg_temp.abandon(:'a13');
select pg_temp.abandon(:'a15');

-- ---------------------------------------------------------------- rate limits
select pg_temp.age_ledger();
-- Per case: 3 per 24 hours ...
select pg_temp.new_case() as rc \gset
create function pg_temp.attempt(p_case uuid) returns text language plpgsql as $$
declare v uuid;
begin
  v := pg_temp.start(p_case);
  begin
    perform pg_temp.reserve(v);
  exception when others then
    perform tests.as_owner();
    perform pg_temp.abandon(v);
    return split_part(sqlerrm, ':', 1);
  end;
  perform pg_temp.abandon(v);
  return 'OK';
end $$;
select tests.is(pg_temp.attempt(:'rc') || pg_temp.attempt(:'rc') || pg_temp.attempt(:'rc'), 'OKOKOK', 'three attempts on one case within 24 hours');
select tests.is(pg_temp.attempt(:'rc'), 'RATE_LIMITED', 'the fourth within 24 hours is refused');
-- ... and 10 in total.
select pg_temp.age_ledger();
select pg_temp.attempt(:'rc'), pg_temp.attempt(:'rc'), pg_temp.attempt(:'rc');
select pg_temp.age_ledger();
select pg_temp.attempt(:'rc'), pg_temp.attempt(:'rc'), pg_temp.attempt(:'rc');
select pg_temp.age_ledger();
select tests.is(pg_temp.attempt(:'rc'), 'OK', 'the tenth attempt on the case');
select tests.is(pg_temp.attempt(:'rc'), 'RATE_LIMITED', 'an eleventh attempt on the case, ever, is refused');
-- Per founder: 10 per 24 hours (across cases).
select pg_temp.age_ledger();
select tests.is((select string_agg(pg_temp.attempt(pg_temp.new_case()), ',') from generate_series(1, 10)), 'OK,OK,OK,OK,OK,OK,OK,OK,OK,OK', 'ten attempts by the founder within 24 hours');
select tests.is(pg_temp.attempt(pg_temp.new_case()), 'RATE_LIMITED', 'the eleventh founder attempt within 24 hours is refused');

-- ---------------------------------------------------------------- dispatch guards, each on its own
select pg_temp.age_ledger();
select pg_temp.new_case() as cg1 \gset
select pg_temp.start(:'cg1') as ag1 \gset
select pg_temp.reserve(:'ag1');
select pg_temp.dispatch(:'ag1', 'ANALYST');
select pg_temp.usage(:'ag1', 'ANALYST', 100, 10);
select pg_temp.dispatch(:'ag1', 'REVIEWER');
select tests.as_service();
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'ag1', 'REVIEWER'), '^ALREADY_DISPATCHED', 'no second reviewer request (no retries within a reservation)');
select tests.as_owner();
select pg_temp.fail_run(:'ag1');
-- A reservation left RESERVED while its analysis finished (e.g. completed during a rollback window): no dispatch.
select pg_temp.new_case() as cg2 \gset
select pg_temp.start(:'cg2') as ag2 \gset
select pg_temp.reserve(:'ag2');
update public.analyses set status = 'ERROR', error = 'synthetic: finished without settlement', completed_at = now() where id = :'ag2';
select tests.as_service();
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'ag2', 'ANALYST'), '^INVALID_STATE', 'no dispatch once the analysis is no longer running, even if the reservation is open');
select tests.as_owner();
-- A held reservation whose analysis row still reads PENDING (inconsistent state): no dispatch either.
select pg_temp.new_case() as cg3 \gset
select pg_temp.start(:'cg3') as ag3 \gset
select pg_temp.reserve(:'ag3');
update private.ai_spend_ledger set status = 'HELD', settled_by = 'UNKNOWN_USAGE', actual_usd = 0, settled_at = now() where analysis_id = :'ag3';
select tests.as_service();
select tests.throws(format('select public.internal_ai_dispatch(%L, %L)', :'ag3', 'ANALYST'), '^INVALID_STATE', 'no dispatch on a settled or held reservation, even if the analysis reads PENDING');
select tests.as_owner();
select tests.throws(format('select private.ai_reconcile(%L, 0.02, %L)', :'a6', 'synthetic: a second reconciliation attempt'), '^INVALID_STATE', 'a reconciled reservation cannot be reconciled again');

-- ---------------------------------------------------------------- founder summary; records survive deletion; clients see nothing
select pg_temp.age_ledger();
select pg_temp.committed() as expect_committed \gset
select tests.login(tests.founder());
select public.founder_ai_spend_summary() as s \gset
select tests.ok((:'s'::jsonb ->> 'budget_usd')::numeric = 20 and (:'s'::jsonb ->> 'stop_at_usd')::numeric = 18
                and (:'s'::jsonb ->> 'committed_usd')::numeric = :'expect_committed'::numeric
                and (:'s'::jsonb ->> 'held_reservations')::int >= 2 and (:'s'::jsonb ->> 'overruns')::int = 1,
  'the founder summary reports budget, committed spend, held reservations and overruns');
select tests.as_owner();
select pg_temp.committed() as before_delete \gset
delete from public.cases where id = :'c6';
select tests.ok(exists (select 1 from private.ai_spend_ledger where analysis_id = :'a6') and pg_temp.committed() = :'before_delete'::numeric,
  'spending records survive deletion of the case');
select tests.login(tests.client_a());
select tests.ok(public.client_get_case(:'c0')::text !~* '(reserved|spend|usd|ledger|dispatch)', 'the client''s case detail carries nothing about spending');
select tests.as_owner();
select tests.ok((select bool_and(c.relrowsecurity) and not bool_or(has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'SELECT')
                        or has_table_privilege('service_role', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'UPDATE'))
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'private' and c.relname in ('ai_spend_config', 'ai_model_prices', 'ai_spend_ledger')),
  'the three spending tables: RLS on, no privilege for any API role');
select tests.ok(not exists (select 1 from pg_policies where schemaname = 'private' and tablename like 'ai\_%'), '... and no policies at all');
rollback;

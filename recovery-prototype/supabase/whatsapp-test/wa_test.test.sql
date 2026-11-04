-- WhatsApp feasibility test: database rules, against the real schema (local only).
begin;
select tests.as_owner();
select tests.seed();

-- ---------------------------------------------------------------- nobody but the service role may write
select tests.as_anon();
select tests.throws($$select public.internal_wa_register_number('100000000000001', '200000000000001', tests.biz_a(), tests.founder())$$, 'permission denied', 'anon cannot register a number');
select tests.login(tests.founder());
select tests.throws($$select public.internal_wa_record_events('[]')$$, 'permission denied', 'even the founder cannot write events directly');
select tests.login(tests.client_a());
select tests.throws($$select public.internal_wa_reserve_send(gen_random_uuid(), '100000000000001', 'TEXT', tests.client_a())$$, 'permission denied', 'a business cannot reserve a send');

-- ---------------------------------------------------------------- number → business mapping (server side)
select tests.as_service();
select tests.throws(format('select public.internal_wa_register_number(%L, %L, %L, %L)', '100000000000001', '200000000000001', tests.biz_a(), tests.client_a()),
  '^FORBIDDEN', 'only a founder can be recorded as registering a number');
select public.internal_wa_register_number('100000000000001', '200000000000001', tests.biz_a(), tests.founder());
select public.internal_wa_register_number('100000000000002', '200000000000002', tests.biz_b(), tests.founder());
select tests.throws(format('select public.internal_wa_register_number(%L, %L, %L, %L)', '100000000000001', '200000000000001', tests.biz_b(), tests.founder()),
  '^CONFLICT', 'a number mapped to one business cannot be re-mapped to another');
select tests.is(public.internal_wa_business_for_number('100000000000002'), tests.biz_b(), 'the second number belongs to business B');

-- ---------------------------------------------------------------- events: business from the mapping, duplicates once, unknown numbers dropped
select tests.is(public.internal_wa_record_events(jsonb_build_array(
  jsonb_build_object('dedupe_key', 'in:wamid.A1', 'phone_number_id', '100000000000001', 'kind', 'INBOUND', 'contact_hash', repeat('a', 64),
    'is_test_contact', true, 'wa_message_id', 'wamid.A1', 'body', 'TEST-OK', 'occurred_at', '1793793600', 'business_id', tests.biz_b()),
  jsonb_build_object('dedupe_key', 'in:wamid.B1', 'phone_number_id', '100000000000002', 'kind', 'INBOUND', 'contact_hash', repeat('b', 64),
    'wa_message_id', 'wamid.B1', 'occurred_at', '1793793600'),
  jsonb_build_object('dedupe_key', 'in:wamid.X1', 'phone_number_id', '999999999999999', 'kind', 'INBOUND', 'wa_message_id', 'wamid.X1'))), 2,
  'two events stored; the one for an unknown number is dropped');
select tests.as_owner();
select tests.is((select business_id from private.wa_test_events where dedupe_key = 'in:wamid.A1'), tests.biz_a(),
  'the business comes from the mapping, not from a business_id the caller supplied');
select tests.as_service();
select tests.throws($$select count(*) from private.wa_test_events$$, 'permission denied', 'the service role itself has no table access, only the functions');
select tests.is(public.internal_wa_record_events(jsonb_build_array(
  jsonb_build_object('dedupe_key', 'in:wamid.A1', 'phone_number_id', '100000000000001', 'kind', 'INBOUND', 'wa_message_id', 'wamid.A1'))), 0,
  'a duplicate delivery (retry) stores nothing');
select tests.as_owner();
select tests.is((select count(*) from private.wa_test_events), 2::bigint, 'still two events');
select tests.as_service();
select tests.throws($$select public.internal_wa_record_events(jsonb_build_array(jsonb_build_object('dedupe_key', 'in:wamid.C1', 'phone_number_id', '100000000000001',
  'kind', 'INBOUND', 'is_test_contact', false, 'body', 'a real customer message')))$$, 'check constraint', 'text from anyone but the test contact cannot be stored');
select tests.is(public.internal_wa_last_inbound_at('100000000000001', repeat('a', 64)), to_timestamp(1793793600), 'last inbound time of the test contact (24-hour window)');

-- ---------------------------------------------------------------- sends: idempotent, capped, mapped numbers only
select tests.is(public.internal_wa_reserve_send('40000000-0000-4000-8000-000000000001', '100000000000001', 'TEXT', tests.founder()), 'NEW', 'first send reserved');
select tests.is(public.internal_wa_reserve_send('40000000-0000-4000-8000-000000000001', '100000000000001', 'TEXT', tests.founder()), 'DUPLICATE', 'same key: never sent twice');
select tests.is(public.internal_wa_reserve_send(gen_random_uuid(), '999999999999999', 'TEXT', tests.founder()), 'UNKNOWN_NUMBER', 'an unmapped number cannot send');
select public.internal_wa_reserve_send('40000000-0000-4000-8000-000000000002', '100000000000001', 'TEMPLATE', tests.founder());
select public.internal_wa_reserve_send('40000000-0000-4000-8000-000000000003', '100000000000001', 'TEMPLATE', tests.founder());
select tests.is(public.internal_wa_reserve_send(gen_random_uuid(), '100000000000001', 'TEXT', tests.founder()), 'CAP_REACHED', 'at most 3 sends per number in total');
select public.internal_wa_finish_send('40000000-0000-4000-8000-000000000001', 'ACCEPTED', 'wamid.OUT1', null);
select public.internal_wa_finish_send('40000000-0000-4000-8000-000000000001', 'FAILED', null, 'HTTP_500');
select tests.as_owner();
select tests.is((select status || ':' || wa_message_id from private.wa_test_outbound where idempotency_key = '40000000-0000-4000-8000-000000000001'),
  'ACCEPTED:wamid.OUT1', 'a finished send is not overwritten');
select tests.as_service();

-- ---------------------------------------------------------------- the reply is linked to the send and the right business
select public.internal_wa_record_events(jsonb_build_array(
  jsonb_build_object('dedupe_key', 'st:wamid.OUT1:delivered', 'phone_number_id', '100000000000001', 'kind', 'STATUS', 'wa_message_id', 'wamid.OUT1', 'status', 'delivered', 'occurred_at', '1793793700'),
  jsonb_build_object('dedupe_key', 'in:wamid.R1', 'phone_number_id', '100000000000001', 'kind', 'INBOUND', 'contact_hash', repeat('a', 64), 'is_test_contact', true,
    'wa_message_id', 'wamid.R1', 'reply_to', 'wamid.OUT1', 'body', 'TEST-OK', 'occurred_at', '1793793800'),
  jsonb_build_object('dedupe_key', 'hist:100000000000001:x', 'phone_number_id', '100000000000001', 'kind', 'HISTORY',
    'summary', jsonb_build_object('phase', 0, 'threads', 2, 'messages', 3, 'oldest', '2026-05-28T20:26:40.000Z'))));

select tests.login(tests.founder());
select public.founder_wa_test_summary() as s \gset
select tests.ok(exists (select 1 from jsonb_array_elements(:'s'::jsonb -> 'outbound') o
  where o ->> 'wa_message_id' = 'wamid.OUT1' and o ->> 'status' = 'ACCEPTED' and o -> 'delivery' = '["delivered"]'::jsonb),
  'founder sees the accepted send and its delivery status');
select tests.ok(exists (select 1 from jsonb_array_elements(:'s'::jsonb -> 'test_contact_messages') m
  where m ->> 'reply_to' = 'wamid.OUT1' and (m ->> 'replies_to_test_send')::boolean and m ->> 'business' = 'Synthetic Autos A'),
  'founder sees the reply, linked to the test send, under the right business');
select tests.ok((:'s'::jsonb -> 'history' -> 0 ->> 'messages') = '3', 'founder sees the history counts');

-- ---------------------------------------------------------------- businesses see nothing
select tests.login(tests.client_a());
select tests.throws($$select public.founder_wa_test_summary()$$, '^FORBIDDEN', 'a business cannot read the test summary');
select tests.throws($$select count(*) from private.wa_test_events$$, 'permission denied', 'a business cannot read the event table');
select tests.login(tests.client_b());
select tests.throws($$select public.founder_wa_test_summary()$$, '^FORBIDDEN', 'another business cannot read the test summary');
select tests.as_anon();
select tests.throws($$select public.founder_wa_test_summary()$$, 'permission denied', 'anon cannot read the test summary');
rollback;

-- RRE WhatsApp integration: database rules, end to end, on the real schema (local only, synthetic data).
begin;
select tests.as_owner();
select tests.seed();
\set TPL_TEXT 'Hello from Synthetic Autos A. Are you still interested in what you asked us about? Reply STOP to opt out.'

-- ---------------------------------------------------------------- sequencing: authorization BEFORE any connection or history request
select tests.as_service();
select tests.throws(format('select public.internal_wa_record_connection(%L, %L, %L, %L, %L, %L, %L, null)', tests.biz_a(), tests.client_a(),
  '100000000000001', '200000000000001', '0001', 'enc:tokenA', 'CONNECTING'), '^AUTHORIZATION_REQUIRED', 'no connection is recorded before the owner authorizes');
select tests.is(public.internal_wa_has_authorization(tests.biz_a()), 'false'::jsonb, 'the Edge Function can check authorization before the Meta exchange');

-- ---------------------------------------------------------------- the owner's explicit authorization
select tests.login(tests.client_a());
select tests.throws($$select public.client_wa_authorize('v1', 12, 'AUTOMATIC', 5, 2, 1, null, null, null)$$, 'check constraint', 'history scope is at most 6 months');
select tests.throws($$select public.client_wa_authorize('v1', 3, 'AUTOMATIC', 5, 2, 500, null, null, null)$$, 'check constraint', 'spending limit is capped');
select public.client_wa_authorize('v1', 3, 'AUTOMATIC', 5, 2, 1, 'rre_reopen', 'en', :'TPL_TEXT');
select tests.is(public.client_wa_status() -> 'authorization' ->> 'send_mode', 'AUTOMATIC', 'authorization recorded with its limits');
select tests.login(tests.client_b());
select public.client_wa_authorize('v1', 3, 'AUTOMATIC', 5, 2, 1, null, null, null);

-- ---------------------------------------------------------------- connection: members only, one business per number, mapping saved first
select tests.as_service();
select tests.throws(format('select public.internal_wa_record_connection(%L, %L, %L, %L, %L, %L, %L, null)', tests.biz_b(), tests.client_a(),
  '100000000000002', '200000000000002', '0002', 'enc:x', 'CONNECTING'), '^FORBIDDEN', 'a member of business A cannot connect business B');
select public.internal_wa_record_connection(tests.biz_a(), tests.client_a(), '100000000000001', '200000000000001', '0001', 'enc:tokenA', 'CONNECTING', null);
select public.internal_wa_record_connection(tests.biz_b(), tests.client_b(), '100000000000002', '200000000000002', '0002', 'enc:tokenB', 'CONNECTING', null);
select tests.is(public.internal_wa_mark_history_requested(tests.biz_b()), 'SYNCING', 'B: history requested, now syncing');
select tests.throws(format('select public.internal_wa_record_connection(%L, %L, %L, %L, %L, %L, %L, null)', tests.biz_b(), tests.client_b(),
  '100000000000001', '200000000000001', '0001', 'enc:x', 'CONNECTING'), '^CONFLICT', 'a number connected to A cannot be bound to B');
select tests.as_anon();
select tests.throws($$select public.internal_wa_ingest('[]')$$, 'permission denied', 'anon cannot post events');
select tests.login(tests.client_a());
select tests.throws($$select public.internal_wa_claim_sends(5)$$, 'permission denied', 'a business cannot run the send worker');
select tests.is(public.client_wa_status() ->> 'status', 'CONNECTING', 'owner sees Connecting (not Connected)');

-- ---------------------------------------------------------------- immediate and out-of-order history: the FINAL batch arrives first, before the request returned
select tests.as_service();
select public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'HISTORY_CHUNK', 'phone_number_id', '100000000000001',
  'chunk_key', 'p2-c9', 'phase', 2, 'chunk_order', 9, 'progress', 100, 'messages', '[]'::jsonb)));
select tests.as_owner();
select tests.is((select status || '/' || history_status from private.wa_connections where business_id = tests.biz_a()), 'CONNECTING/COMPLETE',
  'an immediate webhook finds the mapping saved before the request; still not Connected before the request is confirmed');
select tests.as_service();
select tests.is(public.internal_wa_mark_history_requested(tests.biz_a()), 'CONNECTED', 'request confirmed after the history already completed: Connected');
-- an earlier batch arrives late (out of order): stored, history stays COMPLETE
select public.internal_wa_ingest(jsonb_build_array(
  jsonb_build_object('kind', 'HISTORY_CHUNK', 'phone_number_id', '100000000000001', 'chunk_key', 'p0-c1', 'phase', 0, 'chunk_order', 1, 'progress', 60,
    'messages', jsonb_build_array(
      jsonb_build_object('wa_id', '2348000000011', 'wamid', 'h.11b', 'direction', 'OUT_HUMAN', 'msg_type', 'text', 'body', 'It is 9,500.', 'content_available', true,
        'sent_at', extract(epoch from now() - interval '10 days' + interval '5 minutes')),
      jsonb_build_object('wa_id', '2348000000011', 'wamid', 'h.11a', 'direction', 'IN', 'msg_type', 'text', 'body', 'How much is the hatchback?', 'content_available', true,
        'sent_at', extract(epoch from now() - interval '10 days')),
      jsonb_build_object('wa_id', '2348000000010', 'wamid', 'h.10a', 'direction', 'IN', 'msg_type', 'text', 'body', 'Is the course available?', 'content_available', true,
        'sent_at', extract(epoch from now() - interval '40 days')),
      jsonb_build_object('wa_id', '2348000000010', 'wamid', 'h.10b', 'direction', 'IN', 'msg_type', 'image', 'body', null, 'content_available', false,
        'sent_at', extract(epoch from now() - interval '40 days' + interval '1 minute')),
      jsonb_build_object('wa_id', '2348000000010', 'wamid', 'h.10c', 'direction', 'OUT_HUMAN', 'msg_type', 'text', 'body', 'Yes it is.', 'content_available', true,
        'sent_at', extract(epoch from now() - interval '40 days' + interval '2 minutes')),
      jsonb_build_object('wa_id', '2348000000010', 'wamid', 'h.10old', 'direction', 'IN', 'msg_type', 'text', 'body', 'very old', 'content_available', true,
        'sent_at', extract(epoch from now() - interval '300 days'))))));
select tests.is(public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'HISTORY_CHUNK', 'phone_number_id', '100000000000001',
  'chunk_key', 'p0-c1', 'progress', 60, 'messages', '[]'::jsonb))) ->> 'duplicates', '1', 'a re-delivered history chunk is ignored');
select tests.is(public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'HISTORY_CHUNK', 'phone_number_id', '999999999999999',
  'chunk_key', 'x', 'messages', '[]'::jsonb))) ->> 'unknown_number', '1', 'events for an unmapped number are rejected');
select tests.as_owner();
select tests.is((select history_status from private.wa_connections where business_id = tests.biz_a()), 'COMPLETE', 'a late partial batch never moves history back');
select tests.is((select count(*) from private.wa_messages where business_id = tests.biz_a()), 5::bigint, 'five in-scope messages kept');
select tests.is((select sum(discarded) from private.wa_history_chunks where business_id = tests.biz_a() and chunk_key = 'p0-c1'), 1::bigint,
  'the message outside the 3-month scope was discarded');
select tests.ok((select evidence_incomplete from private.wa_contacts where wa_id = '2348000000010'), 'an image without importable content marks the evidence incomplete');
select tests.ok((select last_live_inbound_at is null from private.wa_contacts where wa_id = '2348000000011'), 'imported history never opens the reply window');
select tests.login(tests.client_a());
select tests.ok(public.client_wa_status() ->> 'status' = 'CONNECTED' and public.client_wa_status() -> 'history' ->> 'status' = 'COMPLETE'
  and (public.client_wa_status() -> 'history' ->> 'kept')::int = 5, 'Connected only once history has been received; owner sees what was kept');

-- ---------------------------------------------------------------- no analysis of an unsettled import
select tests.as_service();
select tests.is(public.internal_wa_import_cases(tests.biz_a(), 10), 0, 'batches still arriving (within 10 minutes): no case is created yet');
select tests.as_owner();
update private.wa_history_chunks set received_at = now() - interval '11 minutes' where business_id = tests.biz_a();

-- ---------------------------------------------------------------- chats → ordinary RRE cases (speakers, order, missing content)
select tests.as_service();
select tests.is(public.internal_wa_import_cases(tests.biz_a(), 10), 2, 'two conversations with both sides become cases');
select tests.is(public.internal_wa_import_cases(tests.biz_a(), 10), 0, 'importing again creates no duplicate cases');
select tests.as_owner();
select case_id as c11 from private.wa_contacts where wa_id = '2348000000011' \gset
select case_id as c10 from private.wa_contacts where wa_id = '2348000000010' \gset
select id as k11 from private.wa_contacts where wa_id = '2348000000011' \gset
select id as k10 from private.wa_contacts where wa_id = '2348000000010' \gset
select tests.ok((select body ~ '^\[[0-9-]+ [0-9:]+\] Prospect: How much is the hatchback\?\n\[[0-9-]+ [0-9:]+\] Business: It is 9,500\.$'
  from public.case_messages where case_id = :'c11' and kind = 'PASTED_CONVERSATION'), 'transcript: oldest first, speakers attributed (out-of-order input sorted)');
select tests.ok((select body like '%Prospect: [image not available to RRE — content not imported]%' and body not like '%very old%'
  from public.case_messages where case_id = :'c10' and kind = 'PASTED_CONVERSATION'), 'missing content is marked, never invented; out-of-scope text absent');
select tests.is((select workflow_state::text from public.cases where id = :'c11'), 'SUBMITTED', 'imported case is submitted for founder analysis');

-- ---------------------------------------------------------------- founder analysis and approval (unchanged workflow)
select tests.login(tests.founder());
select public.founder_start_analysis(:'c11') as a11 \gset
select tests.as_service();
select public.internal_complete_analysis(:'a11', 'COMPLETE', 'synthetic-model', 'test', tests.contract_output(:'a11', 'GREEN', 'AI text'), 'GREEN', 'AI text', '[]');
select tests.login(tests.founder());
select public.founder_approve(:'c11', :'a11', (select evidence_version from public.cases where id = :'c11'), 'GREEN', 's', 'n', 'Approved follow-up one.', 'EDITED');
select public.founder_start_analysis(:'c10') as a10 \gset
select tests.as_service();
select public.internal_complete_analysis(:'a10', 'COMPLETE', 'synthetic-model', 'test', tests.contract_output(:'a10', 'GREEN', 'AI text'), 'GREEN', 'AI text', '[]');
select tests.login(tests.founder());
select public.founder_approve(:'c10', :'a10', (select evidence_version from public.cases where id = :'c10'), 'GREEN', 's', 'n', 'Approved for ten.', 'EDITED');

-- ---------------------------------------------------------------- sending gates
select tests.as_service();
select tests.is(public.internal_wa_plan_sends(), 2, 'two approved cases planned');
select tests.is(public.internal_wa_plan_sends(), 0, 'planning again creates no duplicates');
select tests.is(jsonb_array_length(public.internal_wa_claim_sends(10)), 0, 'nothing leaves while the global sending switch is off');
select tests.as_owner();
select tests.is((select status_detail from private.wa_sends where contact_id = :'k11'), 'SENDING_SWITCH_OFF', 'held, not cancelled, while switched off');
select tests.login(tests.founder());
select public.founder_wa_set_sending(true);
select tests.as_service();
select tests.is(jsonb_array_length(public.internal_wa_claim_sends(10)), 0, 'no recipient permission yet: nothing is sent');
select tests.as_owner();
select tests.ok((select bool_and(status = 'QUEUED' and status_detail = 'NO_RECIPIENT_PERMISSION') from private.wa_sends),
  'unknown permission is ineligible: held (not sent) until the owner records permission');

-- the owner records permission: the held send for the same approval is released
select tests.login(tests.client_a());
select tests.throws(format('select public.client_wa_set_permission(%L, true, %L)', :'k11', 'yes'), '^VALIDATION', 'permission needs a stated basis');
select public.client_wa_set_permission(:'k11', true, 'Customer asked us to follow up on WhatsApp.');
select public.client_wa_set_permission(:'k10', true, 'Customer asked us to follow up on WhatsApp.');
select tests.login(tests.client_b());
select tests.throws(format('select public.client_wa_set_permission(%L, true, %L)', :'k11', 'Customer asked us to follow up.'), '^NOT_FOUND',
  'another business cannot touch this contact');
select tests.is(jsonb_array_length(public.client_wa_contacts()), 0, 'another business sees none of these conversations');
select tests.as_service();
select public.internal_wa_claim_sends(10) as claim1 \gset
select tests.is(jsonb_array_length(:'claim1'::jsonb), 1, 'one send released (the incomplete-evidence contact stays blocked)');
select tests.ok((:'claim1'::jsonb -> 0 ->> 'kind') = 'REOPEN_TEMPLATE' and (:'claim1'::jsonb -> 0 ->> 'body') = :'TPL_TEXT'
  and (:'claim1'::jsonb -> 0 ->> 'to') = '2348000000011' and (:'claim1'::jsonb -> 0 ->> 'template_name') = 'rre_reopen',
  'an old prospect gets only the approved reopening template, never free text');
select tests.as_owner();
select tests.is((select status_detail from private.wa_sends where contact_id = :'k10' and status = 'CANCELLED' order by created_at desc limit 1),
  'EVIDENCE_INCOMPLETE', 'incomplete evidence prevents automatic outreach');

-- ---------------------------------------------------------------- late history after the case exists: evidence updated, approval invalidated
select tests.as_owner();
select evidence_version as ev10_before from public.cases where id = :'c10' \gset
select tests.is((select workflow_state::text from public.cases where id = :'c10'), 'CLIENT_ACTION_REQUIRED', 'case 10 was approved');
select tests.as_service();
select public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'HISTORY_CHUNK', 'phone_number_id', '100000000000001',
  'chunk_key', 'p1-c4-late', 'phase', 1, 'chunk_order', 4, 'progress', 100, 'messages', jsonb_build_array(
    jsonb_build_object('wa_id', '2348000000010', 'wamid', 'h.10late', 'direction', 'IN', 'msg_type', 'text', 'body', 'Do you offer a weekend class?',
      'content_available', true, 'sent_at', extract(epoch from now() - interval '41 days'))))));
select tests.is(public.internal_wa_apply_late_history(tests.biz_a()), 0, 'not applied while batches are still arriving');
select tests.as_owner();
update private.wa_history_chunks set received_at = now() - interval '11 minutes' where business_id = tests.biz_a();
select tests.as_service();
select tests.is(public.internal_wa_apply_late_history(tests.biz_a()), 1, 'late history applied to the existing case');
select tests.is(public.internal_wa_apply_late_history(tests.biz_a()), 0, 'applied once');
select tests.as_owner();
select tests.ok((select workflow_state::text = 'REANALYZING' and evidence_version > :ev10_before from public.cases where id = :'c10'),
  'the approved case returns to the founder with a new evidence version (the old approval is unusable)');
select tests.ok((select count(*) = 2 and bool_or(body like '[Additional WhatsApp history received later%Prospect: Do you offer a weekend class?')
  from public.case_messages where case_id = :'c10' and kind = 'PASTED_CONVERSATION'), 'the late messages are added as labelled evidence, not merged unseen');
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, %s, %L, %L, %L, %L, %L)', :'c10', :'a10', :ev10_before, 'GREEN', 's', 'n', 'x', 'EDITED'),
  '^(INVALID_STATE|STALE)', 'the outdated analysis can no longer be approved');
select tests.as_service();
select public.internal_wa_finish_send((:'claim1'::jsonb -> 0 ->> 'send_id')::uuid, 'ACCEPTED', 'wamid.R1', null);
select tests.as_owner();
select tests.ok((select workflow_state::text = 'WAITING_FOR_PROSPECT' from public.cases where id = :'c11')
  and (select not sent_exactly and body = :'TPL_TEXT' from public.case_messages where case_id = :'c11' and kind = 'RECOVERY_SENT'),
  'accepted: the case records exactly what was sent and waits for the prospect');
select tests.is((select status from private.wa_sends where wamid = 'wamid.R1'), 'ACCEPTED', 'accepted is not delivered');

-- ---------------------------------------------------------------- delivery statuses: out of order, never backwards
select tests.as_service();
select public.internal_wa_ingest(jsonb_build_array(
  jsonb_build_object('kind', 'STATUS', 'phone_number_id', '100000000000001', 'wamid', 'wamid.R1', 'status', 'delivered'),
  jsonb_build_object('kind', 'STATUS', 'phone_number_id', '100000000000001', 'wamid', 'wamid.R1', 'status', 'sent'),
  jsonb_build_object('kind', 'STATUS', 'phone_number_id', '100000000000002', 'wamid', 'wamid.R1', 'status', 'read')));
select tests.as_owner();
select tests.is((select status from private.wa_sends where wamid = 'wamid.R1'), 'DELIVERED', 'a late "sent" does not undo "delivered"; another business''s number cannot touch it');

-- ---------------------------------------------------------------- the live reply opens the window and returns to the founder
select tests.as_service();
select public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'MESSAGE', 'phone_number_id', '100000000000001', 'wa_id', '2348000000011',
  'wamid', 'wamid.IN1', 'direction', 'IN', 'source', 'LIVE', 'msg_type', 'text', 'body', 'Yes, still interested. Can I see it Saturday?',
  'content_available', true, 'sent_at', extract(epoch from now()))));
select tests.is(public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'MESSAGE', 'phone_number_id', '100000000000001', 'wa_id', '2348000000011',
  'wamid', 'wamid.IN1', 'direction', 'IN', 'source', 'LIVE', 'msg_type', 'text', 'body', 'Yes, still interested. Can I see it Saturday?',
  'content_available', true, 'sent_at', extract(epoch from now())))) ->> 'duplicates', '1', 'a retried reply is ignored');
select tests.as_owner();
select tests.ok((select workflow_state::text = 'PROSPECT_REPLIED' from public.cases where id = :'c11')
  and (select count(*) = 1 from public.case_messages where case_id = :'c11' and kind = 'PROSPECT_RESPONSE'),
  'the reply reaches the founder''s response loop once, on the right case');
select tests.login(tests.client_a());
select tests.is((public.client_wa_status() -> 'counts' ->> 'replies_received')::int, 1, 'owner sees one reply');

-- second approval inside the window: free-form reply allowed; an ambiguous result is never resent
select tests.login(tests.founder());
select public.founder_start_analysis(:'c11') as a11b \gset
select tests.as_service();
select public.internal_complete_analysis(:'a11b', 'COMPLETE', 'synthetic-model', 'test', tests.contract_output(:'a11b', 'GREEN', 'AI text'), 'GREEN', 'AI text', '[]');
select tests.login(tests.founder());
select public.founder_approve(:'c11', :'a11b', (select evidence_version from public.cases where id = :'c11'), 'GREEN', 's', 'n', 'Saturday at 10 works. See you then!', 'EDITED');
select tests.as_service();
select public.internal_wa_plan_sends();
select public.internal_wa_claim_sends(10) as claim2 \gset
select tests.ok((:'claim2'::jsonb -> 0 ->> 'kind') = 'REPLY_TEXT' and (:'claim2'::jsonb -> 0 ->> 'body') = 'Saturday at 10 works. See you then!',
  'inside the live window the founder-approved personal reply is released');
select public.internal_wa_finish_send((:'claim2'::jsonb -> 0 ->> 'send_id')::uuid, 'UNKNOWN', null, 'TIMEOUT');
select public.internal_wa_plan_sends();
select tests.is(jsonb_array_length(public.internal_wa_claim_sends(10)), 0, 'an UNKNOWN result is held: no automatic resend, no duplicate plan');
select tests.login(tests.founder());
select tests.is(jsonb_array_length(public.founder_wa_overview() -> 'businesses' -> 0 -> 'unknown_sends')
  + jsonb_array_length(public.founder_wa_overview() -> 'businesses' -> 1 -> 'unknown_sends'), 1, 'the founder sees the send to reconcile');
select public.founder_wa_resolve_unknown((:'claim2'::jsonb -> 0 ->> 'send_id')::uuid, true, 'wamid.R2');
select tests.as_owner();
select tests.ok((select workflow_state::text = 'WAITING_FOR_PROSPECT' from public.cases where id = :'c11')
  and (select count(*) = 2 from public.case_messages where case_id = :'c11' and kind = 'RECOVERY_SENT'), 'reconciled as sent: recorded once');

-- ---------------------------------------------------------------- takeover, opt-out, pause, disconnect, account loss, crashed worker
select tests.as_service();
select public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'MESSAGE', 'phone_number_id', '100000000000001', 'wa_id', '2348000000011',
  'wamid', 'wamid.ECHO1', 'direction', 'OUT_HUMAN', 'source', 'ECHO', 'msg_type', 'text', 'body', 'Owner here, I will handle this.', 'content_available', true,
  'sent_at', extract(epoch from now()))));
select tests.as_owner();
select tests.ok((select takeover_at is not null from private.wa_contacts where id = :'k11'), 'an owner message from the app marks human takeover');
-- a queued send for a taken-over contact is cancelled at claim time
insert into private.wa_sends (business_id, contact_id, case_id, approval_id, authorization_id, kind, category, body, est_cost_usd)
values (tests.biz_a(), :'k11', :'c11', gen_random_uuid(), (select id from private.wa_authorizations where business_id = tests.biz_a() and revoked_at is null),
        'REPLY_TEXT', 'SERVICE', 'x', 0.01);
select tests.as_service();
select tests.is(jsonb_array_length(public.internal_wa_claim_sends(10)), 0, 'nothing is sent after the owner took over');

select public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'MESSAGE', 'phone_number_id', '100000000000001', 'wa_id', '2348000000010',
  'wamid', 'wamid.STOP', 'direction', 'IN', 'source', 'LIVE', 'msg_type', 'text', 'body', ' stop ', 'content_available', true, 'sent_at', extract(epoch from now()))));
select tests.as_owner();
select tests.ok((select permission = 'OPTED_OUT' from private.wa_contacts where id = :'k10') and private.has_active_restriction(:'c10'),
  'STOP opts the prospect out and restricts the case');
select tests.login(tests.client_a());
select tests.throws(format('select public.client_wa_set_permission(%L, true, %L)', :'k10', 'Customer asked us to follow up.'), '^CONTACT_RESTRICTED',
  'the owner cannot override a prospect''s STOP');
select tests.is(public.client_wa_pause(true), 'PAUSED', 'owner pauses immediately');
select tests.as_owner();
insert into private.wa_sends (business_id, contact_id, case_id, approval_id, authorization_id, kind, category, body, est_cost_usd, status, claimed_at)
values (tests.biz_a(), :'k10', :'c10', gen_random_uuid(), (select id from private.wa_authorizations where business_id = tests.biz_a() and revoked_at is null),
        'REPLY_TEXT', 'SERVICE', 'y', 0.01, 'SENDING', now() - interval '20 minutes');
select tests.as_service();
select public.internal_wa_claim_sends(10);
select tests.as_owner();
select tests.is((select status from private.wa_sends where body = 'y'), 'UNKNOWN', 'a send left by a crashed worker becomes UNKNOWN, not resent');
select tests.as_service();
select tests.ok(public.internal_wa_active_businesses() @> jsonb_build_array(tests.biz_b()) and not public.internal_wa_active_businesses() @> jsonb_build_array(tests.biz_a()),
  'the worker serves connected businesses only (A is paused)');
select public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'ACCOUNT', 'waba_id', '200000000000002', 'event', 'PARTNER_REMOVED')));
select tests.login(tests.client_b());
select tests.ok(public.client_wa_status() ->> 'status' = 'ACTION_REQUIRED' and public.client_wa_status() ->> 'action_code' = 'PARTNER_REMOVED',
  'a removed permission puts the connection in Action required');
select tests.login(tests.client_a());
select public.client_wa_disconnect();
select tests.as_owner();
select tests.ok((select status = 'DISCONNECTED' and token_ciphertext is null from private.wa_connections where business_id = tests.biz_a()),
  'disconnect removes the stored credential');
select tests.as_service();
select tests.is(public.internal_wa_ingest(jsonb_build_array(jsonb_build_object('kind', 'MESSAGE', 'phone_number_id', '100000000000001', 'wa_id', '2348000000011',
  'wamid', 'wamid.after', 'direction', 'IN', 'source', 'LIVE', 'msg_type', 'text', 'body', 'hello', 'content_available', true,
  'sent_at', extract(epoch from now())))) ->> 'unknown_number', '1', 'after disconnect, events for the number are rejected');

-- ---------------------------------------------------------------- client-safe views; founder-only tools
select tests.login(tests.client_a());
select tests.ok(public.client_wa_status()::text !~ '(output|hypotheses|observations|adversarial|token|ciphertext|approved_message)',
  'the owner''s status carries no analysis or credential');
select tests.throws($$select public.founder_wa_overview()$$, '^FORBIDDEN', 'the owner cannot open founder diagnostics');
select tests.throws($$select public.founder_wa_set_sending(true)$$, '^FORBIDDEN', 'the owner cannot flip the global switch');
select tests.throws($$select count(*) from private.wa_messages$$, 'permission denied', 'no direct table access');
select tests.as_anon();
select tests.throws($$select public.client_wa_status()$$, 'permission denied', 'anon gets nothing');
rollback;

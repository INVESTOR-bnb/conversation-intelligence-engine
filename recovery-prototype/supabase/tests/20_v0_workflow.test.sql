-- V0 screens against the real database: every call the founder decision, timeline and business case
-- screens make (src/live/workflowUi.tsx), with the same named parameters PostgREST passes, and the
-- release boundary enforced by the database rather than by the screens. Synthetic data only.
begin;
select tests.as_owner();
select tests.seed();

-- The founder reviews a completed analysis (AI proposal GREEN + a message).
select tests.case_in_review(tests.client_a(), 'GREEN', 'AI proposed: synthetic internal wording') as c1 \gset
select (tests.latest_analysis(:'c1')).id as a1 \gset

-- Before release the business sees the case as under review, with nothing from the analysis.
select tests.login(tests.client_a());
select public.client_get_case(p_case_id => :'c1') as before_release \gset
select tests.is(:'before_release'::jsonb ->> 'status', 'UNDER_REVIEW', 'business: case under review before the founder decides');
select tests.ok((:'before_release'::jsonb ->> 'approved_message') is null and (:'before_release'::jsonb ->> 'classification') is null,
  'business: no classification or message before release');

-- Founder edits the message and approves (FounderDecision: approvalType -> EDITED).
select tests.login(tests.founder());
select public.founder_approve(p_case_id => :'c1', p_analysis_id => :'a1', p_expected_evidence_version => 1,
  p_classification => 'YELLOW', p_deal_situation => 'Synthetic: price question left open.', p_next_action => 'Send the message below today.',
  p_approved_message => 'Founder-edited synthetic message.', p_approval_type => 'EDITED') as ap1 \gset
select tests.ok((select approval_type::text = 'EDITED' and approved_message = 'Founder-edited synthetic message.'
                   and ai_proposed_message = 'AI proposed: synthetic internal wording' from public.approvals where id = :'ap1'),
  'founder: the edited final message is stored next to the AI proposal (audit)');
select tests.throws(format($q$select public.founder_approve(p_case_id => %L, p_analysis_id => %L, p_expected_evidence_version => 1,
  p_classification => 'GREEN', p_deal_situation => 's', p_next_action => 'n', p_approved_message => 'again', p_approval_type => 'EDITED')$q$, :'c1', :'a1'),
  '^INVALID_STATE', 'founder: a released decision cannot be approved a second time');

-- The business sees only the approved, business-facing information.
select tests.login(tests.client_a());
select public.client_get_case(p_case_id => :'c1') as released \gset
select tests.ok((:'released'::jsonb ->> 'status') = 'ACTION_REQUIRED' and (:'released'::jsonb ->> 'classification') = 'YELLOW'
                and (:'released'::jsonb ->> 'approved_message') = 'Founder-edited synthetic message.'
                and (:'released'::jsonb ->> 'deal_situation') = 'Synthetic: price question left open.'
                and (:'released'::jsonb ->> 'next_action') = 'Send the message below today.',
  'business: receives exactly the approved classification, situation, next step and message');
select tests.ok(:'released' not like '%AI proposed%' and :'released' not like '%Synthetic: the prospect is interested%'
                and :'released' not like '%Synthetic rationale%' and :'released' not like '%Synthetic strategy%',
  'business: no AI proposal, hypothesis, strategy or rationale text anywhere in its case');
select tests.ok(not (:'released'::jsonb ?| array['output', 'observations', 'hypotheses', 'adversarial_review', 'recommendation', 'ai_classification',
                                               'ai_proposed_message', 'model', 'prompt_version', 'evidence_manifest', 'contact_restrictions', 'analysis_id', 'error']),
  'business: the case carries no internal field');
select tests.ok(:'released'::text not like '%"observations"%' and :'released'::text not like '%"adversarial_review"%' and :'released'::text not like '%"hypotheses"%',
  'business: no internal field nested anywhere (history included)');

-- Direct table reads by the business return nothing (founder-only tables); the UI never needs them.
do $$
declare t text; n bigint;
begin
  foreach t in array array['public.analyses', 'public.approvals', 'public.client_recommendations', 'public.outcomes', 'public.case_messages',
                           'public.contact_restrictions', 'public.cases', 'private.ai_spend_ledger'] loop
    begin
      execute format('select count(*) from %s', t) into n;
    exception when insufficient_privilege then n := 0;
    end;
    if n <> 0 then raise exception 'FAIL: business can read % row(s) of %', n, t; end if;
  end loop;
  raise notice 'ok - business: analyses, approvals, recommendations, outcomes, messages, restrictions, cases and spending are unreadable directly';
end $$;

-- Another business cannot open, act on or see this case.
select tests.login(tests.client_b());
select tests.throws(format('select public.client_get_case(p_case_id => %L)', :'c1'), '^NOT_FOUND', 'other business: cannot open the case');
select tests.throws(format('select public.client_record_sent(p_case_id => %L, p_actual_text => null)', :'c1'), '^NOT_FOUND', 'other business: cannot record it as sent');
select tests.throws(format($q$select public.client_record_outcome(p_case_id => %L, p_state => 'LOST', p_deal_value => null, p_amount_paid => null, p_payment_date => null, p_note => null)$q$, :'c1'),
  '^NOT_FOUND', 'other business: cannot record an outcome');
select tests.is(tests.count(format('select 1 from public.client_list_cases() where id = %L', :'c1')), 0::bigint, 'other business: the case is not in its list');

-- Business copies the message, sends it unchanged ("I sent it", no changed text), records the reply.
select tests.login(tests.client_a());
select public.client_record_sent(p_case_id => :'c1', p_actual_text => null);
select tests.is(public.client_get_case(p_case_id => :'c1') ->> 'status', 'WAITING', 'business: recorded as sent, now waiting for the prospect');
select public.client_add_response(p_case_id => :'c1', p_text => '[SIMULATED] Can I pay half now and half in November?');
select tests.is(public.client_get_case(p_case_id => :'c1') ->> 'status', 'UNDER_REVIEW', 'business: the reply returns the case for review');

-- Founder timeline: exactly what the screen reads.
select tests.login(tests.founder());
select tests.ok((select bool_and(sent_exactly) and count(*) = 1 from public.case_messages where case_id = :'c1' and kind = 'RECOVERY_SENT' and body = 'Founder-edited synthetic message.'),
  'founder: sees the message as sent, recorded as sent exactly');
select tests.is((select count(*) from public.case_messages where case_id = :'c1' and kind = 'PROSPECT_RESPONSE' and body like '[SIMULATED] Can I pay half%'), 1::bigint,
  'founder: sees the prospect''s reply');
select tests.ok((select classification::text = 'YELLOW' and approved_message = 'Founder-edited synthetic message.' and published_at is not null
                   from public.client_recommendations where case_id = :'c1'), 'founder: sees what was released');

-- Second round: re-analysis, approval UNCHANGED, business sends a changed text, then WON.
select public.founder_start_analysis(:'c1') as a2 \gset
select tests.as_service();
select public.internal_complete_analysis(:'a2', 'COMPLETE', 'synthetic-model', 'test', tests.contract_output(:'a2', 'GREEN', 'Second AI message.'), 'GREEN', 'Second AI message.', '[]');
select tests.login(tests.founder());
select (select evidence_version from public.analyses where id = :'a2') as ev2 \gset
select public.founder_approve(p_case_id => :'c1', p_analysis_id => :'a2', p_expected_evidence_version => :'ev2',
  p_classification => 'GREEN', p_deal_situation => 'Synthetic: instalments asked.', p_next_action => 'Offer the two-part option.',
  p_approved_message => 'Second AI message.', p_approval_type => 'UNCHANGED');
select tests.login(tests.client_a());
select tests.is(public.client_get_case(p_case_id => :'c1') ->> 'approved_message', 'Second AI message.', 'business: sees the new approved message');
select public.client_record_sent(p_case_id => :'c1', p_actual_text => 'Second message, as I actually sent it.');
select tests.throws(format($q$select public.client_record_outcome(p_case_id => %L, p_state => 'WON', p_deal_value => 250000, p_amount_paid => null, p_payment_date => null, p_note => null)$q$, :'c1'),
  '^VALIDATION', 'business: WON needs the amount paid and the payment date');
select public.client_record_outcome(p_case_id => :'c1', p_state => 'WON', p_deal_value => 250000, p_amount_paid => 125000, p_payment_date => '2026-10-15', p_note => 'SIMULATED DEMO — not a real sale');
select tests.ok((select status = 'WON' and won_amount_paid = 125000 from public.client_list_cases() where id = :'c1'), 'business: sees its recorded outcome');

-- Founder sees the outcome and the changed send.
select tests.login(tests.founder());
select tests.ok((select state::text = 'WON' and amount_paid = 125000 and payment_date = '2026-10-15' and note = 'SIMULATED DEMO — not a real sale' and recorded_by_role::text = 'CLIENT'
                   from public.outcomes where case_id = :'c1'), 'founder: sees the outcome, amounts, date, note and who recorded it');
select tests.ok((select not sent_exactly from public.case_messages where case_id = :'c1' and kind = 'RECOVERY_SENT' and attempt = 2), 'founder: sees that the second send was changed');
select tests.is((select workflow_state::text from public.cases where id = :'c1'), 'WON', 'founder: the case is closed as WON');

-- RED: released with no message; nothing to copy or send.
select tests.case_in_review(tests.client_a(), 'GREEN', 'AI proposed: synthetic internal wording') as c2 \gset
select (tests.latest_analysis(:'c2')).id as a3 \gset
select tests.login(tests.founder());
select public.founder_approve(p_case_id => :'c2', p_analysis_id => :'a3', p_expected_evidence_version => 1,
  p_classification => 'RED', p_deal_situation => 'Synthetic: do not pursue.', p_next_action => 'Do not contact the prospect.',
  p_approved_message => null, p_approval_type => 'MARKED_RED');
select tests.login(tests.client_a());
select tests.ok((public.client_get_case(p_case_id => :'c2') ->> 'classification') = 'RED' and (public.client_get_case(p_case_id => :'c2') ->> 'approved_message') is null
                and public.client_get_case(p_case_id => :'c2')::text not like '%AI proposed%', 'business: a RED decision carries no message and no AI wording');

-- Founder re-analysis request and opt-out on a fresh case.
select tests.case_in_review(tests.client_a()) as c3 \gset
select tests.login(tests.founder());
select public.founder_request_reanalysis(p_case_id => :'c3');
select tests.is((select workflow_state::text from public.cases where id = :'c3'), 'REANALYZING', 'founder: re-analysis request sends the case back for analysis');
select tests.login(tests.client_a());
select public.client_report_opt_out(p_case_id => :'c3', p_note => 'Synthetic: prospect asked to stop.');
select tests.login(tests.founder());
select tests.is((select count(*) from public.contact_restrictions where case_id = :'c3' and status = 'ACTIVE'), 1::bigint, 'founder: the business''s opt-out report is an active restriction');
rollback;

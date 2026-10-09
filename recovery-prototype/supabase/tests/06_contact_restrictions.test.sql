-- Explicit opt-outs / prohibited contact cannot be overridden for sales purposes.
begin;
select tests.as_owner();
select tests.seed();

-- AI-detected opt-out: proposal message is removed, GREEN is impossible
select tests.case_in_review(tests.client_a(), 'GREEN', 'Sales pitch that must never be stored',
  '[{"kind":"EXPLICIT_OPT_OUT","note":"Screenshot 2: please do not contact me again","evidence":{"screenshot":2}}]') as c \gset
select id as a1 from public.analyses where case_id = :'c' \gset
select tests.ok((select ai_proposed_message is null from public.analyses where id = :'a1'), 'detected opt-out removes the AI proposed message');
select id as r1 from public.contact_restrictions where case_id = :'c' \gset

select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, 1, %L, %L, %L, %L, %L)', :'c', :'a1', 'GREEN', 's', 'n', 'Try anyway', 'EDITED'), '^CONTACT_RESTRICTED', 'GREEN blocked by an active opt-out');
select tests.throws(format('select public.founder_approve(%L, %L, 1, %L, %L, %L, %L, %L)', :'c', :'a1', 'YELLOW', 's', 'n', 'Just checking in', 'EDITED'), '^CONTACT_RESTRICTED', 'YELLOW blocked by an active opt-out');
select tests.throws(format('select public.founder_dismiss_ai_restriction(%L, %L)', :'r1', 'too short'), '^VALIDATION', 'dismissal needs a real reason');
select tests.lives(format('select public.founder_approve(%L, %L, 1, %L, %L, %L, null, %L)', :'c', :'a1', 'RED', 'Not recommended.', 'No further contact is recommended.', 'MARKED_RED'), 'RED approval is allowed');
select tests.login(tests.client_a());
select tests.ok((select classification = 'RED' and approved_message is null from public.client_list_cases() where id = :'c'), 'client sees RED with no message');
select tests.throws(format('select public.client_record_sent(%L)', :'c'), '^INVALID_STATE', 'RED cannot be marked as sent');

-- Misread AI detection can be dismissed only with an audited reason
select tests.case_in_review(tests.client_a(), 'GREEN', 'ignored', '[{"kind":"EXPLICIT_OPT_OUT","note":"misread sarcasm"}]') as c2 \gset
select id as r2 from public.contact_restrictions where case_id = :'c2' \gset
select id as a2 from public.analyses where case_id = :'c2' \gset
select tests.login(tests.founder());
select public.founder_dismiss_ai_restriction(:'r2', 'Prospect was joking; next line asks for the price.');
select tests.as_owner();
select tests.ok((select status = 'DISMISSED_AS_MISREAD' and dismissed_by = tests.founder() from public.contact_restrictions where id = :'r2'), 'dismissal is recorded with the founder identity');
select tests.ok(exists (select 1 from public.audit_log where action = 'RESTRICTION_DISMISSED_AS_MISREAD' and case_id = :'c2'), 'dismissal is audited');

-- Founder- and client-recorded restrictions are permanent
select tests.case_in_review(tests.client_b()) as c3 \gset
select tests.login(tests.client_b());
select public.client_report_opt_out(:'c3', 'Prospect said stop messaging');
select tests.is((select status from public.client_list_cases() where id = :'c3'), 'UNDER_REVIEW', 'client opt-out sends the case back to review');
select tests.as_owner();
select id as r3 from public.contact_restrictions where case_id = :'c3' \gset
select tests.login(tests.founder());
select tests.throws(format('select public.founder_dismiss_ai_restriction(%L, %L)', :'r3', 'I would like to keep selling to this person anyway'), '^FORBIDDEN', 'client-recorded opt-out cannot be dismissed');
select tests.throws(format('update public.contact_restrictions set status = %L where id = %L', 'DISMISSED_AS_MISREAD', :'r3'), 'permission denied', 'restriction cannot be edited directly');
select tests.as_owner();
select tests.throws(format('update public.contact_restrictions set status = %L where id = %L', 'DISMISSED_AS_MISREAD', :'r3'), 'check constraint', 'even the owner cannot dismiss a client restriction (constraint)');

-- The earlier analysis is stale after the opt-out; a stop-contact decision needs none
select tests.login(tests.founder());
select tests.lives(format('select public.founder_stop_contact(%L)', :'c3'), 'founder can stop contact without a new analysis');
select tests.login(tests.client_b());
select tests.ok((select classification = 'RED' and approved_message is null from public.client_list_cases() where id = :'c3'), 'client sees Do Not Follow Up');

-- Restriction added after a GREEN approval pulls the message back from the client
select tests.case_in_review(tests.client_b(), 'GREEN', 'Go ahead') as c4 \gset
select tests.login(tests.founder());
select public.founder_approve(:'c4', (select id from public.analyses where case_id = :'c4'), 1, 'GREEN', 's', 'n', 'Go ahead', 'UNCHANGED');
select public.founder_add_restriction(:'c4', 'PROHIBITED_CONTACT', 'Business confirmed prospect is a minor');
select tests.throws(format('select public.founder_dismiss_ai_restriction(id, %L) from public.contact_restrictions where case_id = %L', 'founder changed their mind for sales reasons', :'c4'), '^FORBIDDEN', 'founder-recorded restriction cannot be dismissed');
select tests.login(tests.client_b());
select tests.ok((select status = 'UNDER_REVIEW' and approved_message is null from public.client_list_cases() where id = :'c4'), 'approved message is withdrawn from the client');
select tests.throws(format('select public.client_record_sent(%L)', :'c4'), '^INVALID_STATE', 'client can no longer mark it sent');
rollback;

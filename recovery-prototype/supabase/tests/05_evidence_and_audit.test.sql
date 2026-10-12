-- Evidence-version locking, stale approval prevention, immutability.
begin;
select tests.as_owner();
select tests.seed();

select tests.case_in_review(tests.client_a(), 'GREEN', 'First proposal') as c \gset
select id as a1 from public.analyses where case_id = :'c' \gset

-- Wrong expected version
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, 99, %L, %L, %L, %L, %L)', :'c', :'a1', 'GREEN', 's', 'n', 'First proposal', 'UNCHANGED'), '^STALE_ANALYSIS', 'approval with a stale expected evidence version is rejected');

-- Reanalysis supersedes the earlier analysis
select public.founder_request_reanalysis(:'c');
select public.founder_start_analysis(:'c') as a2 \gset
select tests.as_service();
select public.internal_complete_analysis(:'a2', 'COMPLETE', 'synthetic-model', 'test', tests.contract_output(:'a2', 'YELLOW', 'Second proposal'), 'YELLOW', 'Second proposal', '[]');
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, 1, %L, %L, %L, %L, %L)', :'c', :'a1', 'GREEN', 's', 'n', 'First proposal', 'UNCHANGED'), '^STALE_ANALYSIS', 'an older analysis cannot be approved once superseded');
select public.founder_approve(:'c', :'a2', 1, 'YELLOW', 'Unclear.', 'Clarify.', 'Second proposal', 'UNCHANGED');

-- New evidence (prospect response) makes the last analysis stale
select tests.login(tests.client_a());
select public.client_record_sent(:'c');
select public.client_add_response(:'c', 'Synthetic reply');
select tests.as_owner();
select tests.is((select evidence_version from public.cases where id = :'c'), 3, 'sending and responding each bump the evidence version');
-- Force the case back into review without a fresh analysis to prove the check is in the database.
update public.cases set workflow_state = 'AWAITING_ADMIN_REVIEW' where id = :'c';
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, 3, %L, %L, %L, %L, %L)', :'c', :'a2', 'YELLOW', 's', 'n', 'Second proposal', 'UNCHANGED'), '^STALE_ANALYSIS', 'analysis based on older evidence cannot be approved');
select tests.as_owner();
update public.cases set workflow_state = 'PROSPECT_REPLIED' where id = :'c';

-- Evidence changing while an analysis runs invalidates it
select tests.login(tests.founder());
select public.founder_start_analysis(:'c') as a3 \gset
select tests.as_owner();
update public.cases set evidence_version = evidence_version + 1 where id = :'c';
select tests.as_service();
select public.internal_complete_analysis(:'a3', 'COMPLETE', 'synthetic-model', 'test', tests.contract_output(:'a3', 'GREEN', 'Late proposal'), 'GREEN', 'Late proposal', '[]');
select tests.as_owner();
select tests.ok((select status = 'ERROR' and error like 'STALE%' from public.analyses where id = :'a3'), 'analysis finished on changed evidence is stored as ERROR');
select tests.is((select workflow_state::text from public.cases where id = :'c'), 'PROSPECT_REPLIED', 'case returns to its prior state');

-- Immutability: approvals and audit log
select tests.login(tests.founder());
select tests.throws(format('update public.approvals set approved_message = %L where case_id = %L', 'tampered', :'c'), 'permission denied', 'founder cannot edit approvals via the API');
select tests.throws('delete from public.audit_log', 'permission denied', 'founder cannot delete audit entries via the API');
select tests.as_owner();
select tests.throws(format('update public.approvals set approved_message = %L where case_id = %L', 'tampered', :'c'), '^IMMUTABLE', 'approvals cannot be changed even by the table owner');
select tests.throws(format('delete from public.approvals where case_id = %L', :'c'), '^IMMUTABLE', 'approvals cannot be deleted even by the table owner');
select tests.throws('update public.audit_log set action = ''X''', '^IMMUTABLE', 'audit log cannot be changed even by the table owner');
select tests.throws('truncate public.audit_log', '^IMMUTABLE', 'audit log cannot be truncated');
select tests.ok((select count(*) >= 8 from public.audit_log where case_id = :'c'), 'every step of the case is in the audit log');
select tests.ok((select count(*) = 1 and bool_and(approved_message = 'Second proposal') from public.approvals where case_id = :'c'), 'the single approval is intact after tampering attempts (stale attempt created nothing)');
rollback;

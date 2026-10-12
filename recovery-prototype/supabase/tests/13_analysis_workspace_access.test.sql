-- Stage 2A-5c: the founder analysis workspace reads public.analyses,
-- public.contact_restrictions and public.case_messages directly (no new API
-- function). These are the exact reads it makes, run as each kind of caller,
-- the way PostgREST runs them (role + JWT claims). Synthetic data only.
begin;
select tests.as_owner();
select tests.seed();

-- A case of business A with an accepted analysis and an active restriction.
select tests.case_in_review(tests.client_a(), 'GREEN', 'Synthetic draft message.') as c \gset
select tests.as_owner();
insert into public.contact_restrictions (case_id, business_id, kind, source, note)
values (:'c', tests.biz_a(), 'EXPLICIT_OPT_OUT', 'AI_DETECTED', 'Synthetic opt-out note');

-- The workspace's three reads, verbatim (PostgREST builds the same SELECTs with these filters).
create function pg_temp.read_analyses(p_case uuid) returns bigint language sql as $$
  select count(*) from (select id, version, status, evidence_version, evidence_manifest, output, ai_classification, ai_proposed_message,
                               error, model, prompt_version, created_at, completed_at
                        from public.analyses where case_id = p_case order by version desc) q $$;
create function pg_temp.read_restrictions(p_case uuid) returns bigint language sql as $$
  select count(*) from (select id, kind, source, status, note, created_at from public.contact_restrictions where case_id = p_case order by created_at) q $$;
create function pg_temp.read_messages(p_case uuid) returns bigint language sql as $$
  select count(*) from (select id, kind from public.case_messages where case_id = p_case) q $$;

-- ---------------------------------------------------------------- the founder reads everything
select tests.login(tests.founder());
select tests.is(pg_temp.read_analyses(:'c'), 1::bigint, 'founder: the analysis (with output and manifest)');
select tests.is(pg_temp.read_restrictions(:'c'), 1::bigint, 'founder: the restriction');
select tests.is(pg_temp.read_messages(:'c'), 1::bigint, 'founder: the message kinds (for evidence labels)');
select tests.ok((select output ? 'hypotheses' and ai_proposed_message = 'Synthetic draft message.' from public.analyses where case_id = :'c'),
  'founder: the full output and draft message');

-- ---------------------------------------------------------------- business users: nothing, even for their own case
select tests.login(tests.client_a());
select tests.is(pg_temp.read_analyses(:'c'), 0::bigint, 'client of the same business: no analysis of its own case');
select tests.is(pg_temp.read_restrictions(:'c'), 0::bigint, 'client of the same business: no restriction');
select tests.is(pg_temp.read_messages(:'c'), 0::bigint, 'client of the same business: no messages');
select tests.is(tests.count('select 1 from public.analyses'), 0::bigint, 'client: no analysis of any case (unfiltered read)');
select tests.is(tests.count('select 1 from public.analyses where output is not null or ai_proposed_message is not null'), 0::bigint, 'client: no outputs or draft messages');
select tests.is(tests.count('select 1 from public.approvals'), 0::bigint, 'client: no approvals');
select tests.ok(public.client_get_case(:'c')::text !~* '(Synthetic draft message|hypothes|Synthetic opt-out note|rre-analysis)',
  'client: its own case detail carries nothing from the analysis');
select tests.login(tests.client_a2());
select tests.is(pg_temp.read_analyses(:'c'), 0::bigint, 'another member of the same business: nothing');
select tests.login(tests.client_b());
select tests.is(pg_temp.read_analyses(:'c') + pg_temp.read_restrictions(:'c'), 0::bigint, 'client of another business: nothing');
select tests.login(tests.unassigned());
select tests.is(pg_temp.read_analyses(:'c') + pg_temp.read_restrictions(:'c'), 0::bigint, 'signed-in user with no business: nothing');
select tests.as_anon();
select tests.throws(format('select pg_temp.read_analyses(%L)', :'c'), 'permission denied', 'anonymous: permission denied (analyses)');
select tests.throws(format('select pg_temp.read_restrictions(%L)', :'c'), 'permission denied', 'anonymous: permission denied (restrictions)');

-- ---------------------------------------------------------------- nobody writes through the API (the workspace is read-only)
select tests.login(tests.founder());
select tests.throws(format($q$update public.analyses set ai_proposed_message = 'changed' where case_id = %L$q$, :'c'), 'permission denied', 'founder cannot edit an analysis');
select tests.throws(format($q$delete from public.contact_restrictions where case_id = %L$q$, :'c'), 'permission denied', 'founder cannot delete a restriction');
select tests.throws(format($q$insert into public.analyses (case_id, business_id, version, evidence_version, evidence_manifest, prior_state) values (%L, %L, 9, 1, '{}', 'SUBMITTED')$q$, :'c', tests.biz_a()),
  'permission denied', 'founder cannot insert an analysis directly');
select tests.login(tests.client_a());
select tests.throws(format($q$update public.analyses set status = 'COMPLETE' where case_id = %L$q$, :'c'), 'permission denied', 'client cannot write analyses');
select tests.throws(format($q$update public.contact_restrictions set status = 'DISMISSED_AS_MISREAD' where case_id = %L$q$, :'c'), 'permission denied', 'client cannot lift a restriction');

-- ---------------------------------------------------------------- the boundary is RLS, not the UI
select tests.as_owner();
select tests.ok((select count(*) = 1 and bool_and(cmd = 'SELECT' and qual like '%is_founder%' and qual not like '%is_member%')
                 from pg_policies where schemaname = 'public' and tablename = 'analyses'), 'analyses: one SELECT policy, founder only');
select tests.ok((select count(*) = 1 and bool_and(cmd = 'SELECT' and qual like '%is_founder%' and qual not like '%is_member%')
                 from pg_policies where schemaname = 'public' and tablename = 'contact_restrictions'), 'contact_restrictions: one SELECT policy, founder only');
select tests.ok((select relrowsecurity from pg_class where oid = 'public.analyses'::regclass)
            and (select relrowsecurity from pg_class where oid = 'public.contact_restrictions'::regclass), 'RLS is enabled on both');
select tests.ok(not has_table_privilege('anon', 'public.analyses', 'SELECT') and not has_table_privilege('authenticated', 'public.analyses', 'INSERT, UPDATE, DELETE')
            and not has_table_privilege('authenticated', 'public.contact_restrictions', 'INSERT, UPDATE, DELETE'), 'no anon read, no write privilege for signed-in users');
rollback;

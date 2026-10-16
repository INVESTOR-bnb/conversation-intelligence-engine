-- A business onboarded after Synthetic Autos A already has cases in every stage sees none of them
-- and cannot act on any of them, through every function the business screens use and through
-- direct table reads. Synthetic data only.
begin;
select tests.as_owner();
select tests.seed();

-- Synthetic Autos A: a draft, a case under review, a released case and a closed one.
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'A-DRAFT', 'Synthetic Camry', 'Referral', 'TEXT', 'Prospect: Is the synthetic Camry available?') as a_draft \gset
select tests.case_in_review(tests.client_a()) as a_review \gset
select tests.case_in_review(tests.client_a(), 'GREEN', 'Synthetic AI wording for A') as a_released \gset
select (tests.latest_analysis(:'a_released')).id as an_rel \gset
select tests.case_in_review(tests.client_a()) as a_closed \gset
select (tests.latest_analysis(:'a_closed')).id as an_closed \gset
select tests.login(tests.founder());
select public.founder_approve(:'a_released', :'an_rel', 1, 'GREEN', 'Synthetic situation for A.', 'Synthetic next step for A.', 'Approved message for Synthetic Autos A', 'EDITED');
select public.founder_approve(:'a_closed', :'an_closed', 1, 'GREEN', 's', 'n', 'Closed case message for A', 'EDITED');
select tests.login(tests.client_a());
select public.client_record_sent(:'a_closed');
select public.client_record_outcome(:'a_closed', 'WON', 1000, 900, '2026-10-15');
select tests.is(tests.count('select 1 from public.client_list_cases()'), 4::bigint, 'Synthetic Autos A sees its own four cases');

-- The founder onboards a new business and links an invited account to it.
select tests.login(tests.founder());
create temporary table t_new (id uuid) on commit drop;
grant all on t_new to authenticated;
insert into t_new select public.founder_create_business('Synthetic Bakery New', 'Food', 'NGN');
select public.founder_add_member((select id from t_new), tests.unassigned());

-- The new business: an empty workspace.
select tests.login(tests.unassigned());
select tests.is((public.whoami()) ->> 'business_name', 'Synthetic Bakery New', 'new business: signed in to its own business');
select tests.is(tests.count('select 1 from public.client_list_cases()'), 0::bigint, 'new business: its case list is empty');

create temporary table t_a (id uuid) on commit drop;
insert into t_a values (:'a_draft'), (:'a_review'), (:'a_released'), (:'a_closed');
do $$
declare c uuid; f text; hit int := 0;
begin
  for c in select id from t_a loop
    foreach f in array array[
      format('select public.client_get_case(%L)', c),
      format('select public.client_submit_case(%L)', c),
      format('select public.client_record_sent(%L, null)', c),
      format('select public.client_add_response(%L, %L)', c, 'Synthetic reply'),
      format('select public.client_record_outcome(%L, %L)', c, 'LOST'),
      format('select public.client_report_opt_out(%L, null)', c),
      format('select public.client_screenshot_status(%L)', c),
      format('select public.client_finalize_screenshots(%L)', c)] loop
      begin
        execute f;
        raise exception 'FAIL: new business succeeded: %', f;
      exception when others then
        if sqlerrm like 'FAIL:%' then raise; end if;
        if sqlerrm !~ '^(NOT_FOUND|FORBIDDEN)' then raise exception 'FAIL: % failed for another reason: %', f, sqlerrm; end if;
        hit := hit + 1;
      end;
    end loop;
  end loop;
  raise notice 'ok - new business: all % calls on Synthetic Autos A cases are refused as not found', hit;
end $$;

do $$
declare t text; n bigint;
begin
  foreach t in array array['public.cases', 'public.case_messages', 'public.case_screenshots', 'public.analyses', 'public.approvals',
                           'public.client_recommendations', 'public.outcomes', 'public.contact_restrictions', 'public.audit_log'] loop
    begin
      execute format('select count(*) from %s', t) into n;
    exception when insufficient_privilege then n := 0;
    end;
    if n <> 0 then raise exception 'FAIL: new business can read % row(s) of %', n, t; end if;
  end loop;
  raise notice 'ok - new business: no case, message, screenshot, analysis, approval, recommendation, outcome, restriction or audit row is readable';
end $$;
select tests.is(tests.count(format('select 1 from public.businesses where id = %L', tests.biz_a())), 0::bigint, 'new business: Synthetic Autos A itself is invisible');

-- The new business's own case is visible to it only; Synthetic Autos A cannot see it.
select public.client_create_case(gen_random_uuid(), 'NEW-1', 'Synthetic bread order', 'Referral', 'TEXT', 'Prospect: Do you deliver synthetic bread?') as n1 \gset
select tests.is(tests.count('select 1 from public.client_list_cases()'), 1::bigint, 'new business: sees exactly its own new case');
select tests.login(tests.client_a());
select tests.is(tests.count(format('select 1 from public.client_list_cases() where id = %L', :'n1')), 0::bigint, 'Synthetic Autos A: cannot see the new business''s case');
select tests.throws(format('select public.client_get_case(%L)', :'n1'), '^NOT_FOUND', 'Synthetic Autos A: cannot open the new business''s case');
rollback;

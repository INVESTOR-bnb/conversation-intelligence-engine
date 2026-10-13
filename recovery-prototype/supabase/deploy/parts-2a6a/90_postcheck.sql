-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem rolls
-- everything back. The behavioural check runs in a sub-transaction on a
-- synthetic ledger row and is undone; nothing it writes is kept.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_fn regprocedure := to_regprocedure('public.internal_ai_reservation_terms(uuid)');
  v_id uuid := gen_random_uuid();
  v_terms jsonb;
  v_forbidden text;
  v_missing text;
  v_fingerprint text;
begin
  if v_fn is null or not coalesce((select prosecdef and provolatile = 's' and proconfig @> array['search_path=""'] from pg_proc where oid = v_fn), false) then
    v_problems := array_append(v_problems, 'internal_ai_reservation_terms is missing, not SECURITY DEFINER, not STABLE, or does not pin search_path'::text);
  elsif has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE')
        or not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    v_problems := array_append(v_problems, 'internal_ai_reservation_terms privileges are not service-role only'::text);
  end if;
  -- Behaviour, on a synthetic ledger row, undone.
  begin
    insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model, analyst_input_bound, analyst_max_output,
      reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price, reviewer_out_price, reserved_usd)
    values (v_id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 't-a', 't-r', 8664, 1000, 10664, 2000, 1, 5, 10, 50, 0.2204);
    perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
    v_terms := public.internal_ai_reservation_terms(v_id);
    begin
      perform public.internal_ai_reservation_terms(gen_random_uuid());
    exception when others then v_missing := sqlerrm;
    end;
    perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
    begin
      perform public.internal_ai_reservation_terms(v_id);
    exception when others then v_forbidden := sqlerrm;
    end;
    raise exception 'SELFTEST_UNDO';
  exception when others then
    if sqlerrm <> 'SELFTEST_UNDO' then
      v_problems := array_append(v_problems, format('the reservation-terms self-test failed to run (%s)', sqlerrm));
    end if;
  end;
  if v_terms is distinct from jsonb_build_object('analysis_id', v_id, 'status', 'RESERVED', 'reserved_usd', 0.2204,
       'analyst', '{"model": "t-a", "max_output_tokens": 1000, "input_bound": 8664, "input_usd_per_mtok": 1.000000, "output_usd_per_mtok": 5.000000}'::jsonb,
       'reviewer', '{"model": "t-r", "max_output_tokens": 2000, "input_bound": 10664, "input_usd_per_mtok": 10.000000, "output_usd_per_mtok": 50.000000}'::jsonb)
     or coalesce(v_missing, '') not like 'NOT_RESERVED:%' or coalesce(v_forbidden, '') not like 'FORBIDDEN:%' then
    v_problems := array_append(v_problems, 'internal_ai_reservation_terms does not behave as reviewed'::text);
  end if;
  if exists (select 1 from private.ai_spend_ledger where analysis_id = v_id) then
    v_problems := array_append(v_problems, 'the self-test left something behind'::text);
  end if;
  -- Nothing else changed: every existing spending, contract and settlement function, and all data.
  select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
    into v_fingerprint
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname in ('internal_reserve_ai_spend', 'internal_ai_dispatch', 'internal_ai_report_usage', 'founder_ai_spend_summary',
                                                'internal_complete_analysis', 'founder_abandon_analysis', 'founder_start_analysis'))
     or (n.nspname = 'private' and p.proname in ('ai_estimate_usd', 'ai_committed_usd', 'ai_settle', 'ai_reconcile', 'analysis_output_problems'));
  if v_fingerprint is distinct from current_setting('rre.fingerprint_before', true) then
    v_problems := array_append(v_problems, 'an existing spending, contract or settlement function changed'::text);
  end if;
  if (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.cases),
       (select count(*) from public.audit_log), (select count(*) from private.ai_spend_ledger),
       (select md5(coalesce(string_agg(c::text, ''), '')) from private.ai_spend_config c),
       (select md5(coalesce(string_agg(m::text, '' order by model), '')) from private.ai_model_prices m))) is distinct from current_setting('rre.counts_before', true) then
    v_problems := array_append(v_problems, 'data, the spending configuration or the price list would change'::text);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'private' and tablename like 'ai\_%')
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
                and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%')) then
    v_problems := array_append(v_problems, 'spending tables gained a policy, or analyses/restrictions are no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: reservation terms readable by the service role only; nothing else changed.';
end
$postcheck$;

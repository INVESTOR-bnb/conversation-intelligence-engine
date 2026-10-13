-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem rolls
-- everything back. The behavioural checks run in a sub-transaction on synthetic
-- ledger rows and are undone; nothing they write is kept.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_f text;
  v_ica text := (select prosrc from pg_proc where oid = 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure);
  v_abandon text := (select prosrc from pg_proc where oid = 'public.founder_abandon_analysis(uuid)'::regprocedure);
  v_cfg private.ai_spend_config;
  v_est numeric;
  v_ids uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_states text;
  v_disabled boolean;
begin
  -- Tables: private, RLS on, no policies, no privilege for any API role.
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relname in ('ai_spend_config', 'ai_model_prices', 'ai_spend_ledger') and c.relrowsecurity) <> 3
     or exists (select 1 from pg_policies where schemaname = 'private' and tablename in ('ai_spend_config', 'ai_model_prices', 'ai_spend_ledger'))
     or exists (select 1 from unnest(array['private.ai_spend_config', 'private.ai_model_prices', 'private.ai_spend_ledger']) t, unnest(array['anon', 'authenticated', 'service_role']) r
                where has_table_privilege(r, t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) then
    v_problems := array_append(v_problems, 'a spending table is not private (RLS, policies or API privileges)'::text);
  end if;
  -- Configuration: one sane row, spending OFF at deployment.
  select * into v_cfg from private.ai_spend_config where id;
  if not found or v_cfg.enabled or v_cfg.stop_at_usd > v_cfg.budget_usd or v_cfg.max_reservation_usd <= 0 then
    v_problems := array_append(v_problems, 'spending configuration missing, inconsistent, or enabled at deployment'::text);
  end if;
  if not exists (select 1 from private.ai_model_prices where model = 'FAKE-PROVIDER-NOT-AI' and active and input_usd_per_mtok = 0 and output_usd_per_mtok = 0) then
    v_problems := array_append(v_problems, 'the fake provider price row is missing or not zero'::text);
  end if;
  -- Functions: definer, pinned search_path, exact privileges.
  foreach v_f in array array['private.ai_estimate_usd(bigint, integer, integer, private.ai_model_prices, private.ai_model_prices, private.ai_spend_config)',
                             'private.ai_committed_usd()', 'private.ai_settle(uuid)', 'private.ai_reconcile(uuid, numeric, text)',
                             'public.internal_reserve_ai_spend(uuid, text, text)', 'public.internal_ai_dispatch(uuid, text)',
                             'public.internal_ai_report_usage(uuid, text, integer, integer)', 'public.founder_ai_spend_summary()'] loop
    if to_regprocedure(v_f) is null or not coalesce((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = to_regprocedure(v_f)), false)
       or has_function_privilege('anon', to_regprocedure(v_f), 'EXECUTE')
       or (v_f like 'private.%' and (has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') or has_function_privilege('service_role', to_regprocedure(v_f), 'EXECUTE')))
       or (v_f like 'public.internal_%' and (has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') or not has_function_privilege('service_role', to_regprocedure(v_f), 'EXECUTE')))
       or (v_f = 'public.founder_ai_spend_summary()' and (not has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') or has_function_privilege('service_role', to_regprocedure(v_f), 'EXECUTE'))) then
      v_problems := array_append(v_problems, v_f || ' is missing, has the wrong privileges, or does not pin search_path');
    end if;
  end loop;
  -- The two existing functions keep everything and add settlement.
  if v_ica not like '%private.analysis_output_problems(%' or v_ica not like '%REJECTED by analysis contract rre-analysis/1%'
     or v_ica not like '%private.preserve_detected_restrictions(%' or (length(v_ica) - length(replace(v_ica, 'private.ai_settle(', ''))) / length('private.ai_settle(') <> 2
     or v_abandon not like '%private.ai_settle(%' or v_abandon not like '%private.require_founder()%'
     or not has_function_privilege('service_role', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.founder_abandon_analysis(uuid)', 'EXECUTE') then
    v_problems := array_append(v_problems, 'internal_complete_analysis or founder_abandon_analysis lost a check, settlement or its privileges'::text);
  end if;
  -- Behaviour: estimator (pure) ...
  v_est := (private.ai_estimate_usd(100, 1, 0, row('t-a', 1, 5, 1000, true, null)::private.ai_model_prices,
            row('t-r', 10, 50, 2000, true, null)::private.ai_model_prices,
            row(true, 20, 18, 1, 10, 3, 10, false, 8000, 6, 64, 5000, 2, now())::private.ai_spend_config) ->> 'usd')::numeric;
  if v_est is distinct from 0.2204 then
    v_problems := array_append(v_problems, format('the reservation estimate does not behave as reviewed (%s)', v_est));
  end if;
  -- ... and settlement, on synthetic ledger rows inside a sub-transaction that is undone.
  begin
    -- Enabled inside the undone sub-transaction, so the overrun check can prove it disables spending.
    update private.ai_spend_config set enabled = true where id;
    insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model, analyst_input_bound, analyst_max_output,
      reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price, reviewer_out_price, reserved_usd,
      analyst_dispatched_at, analyst_input_tokens, analyst_output_tokens)
    select id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 't-a', 't-r', 1, 1, 1, 1, 1, 5, 10, 50, 0.5,
           case when i > 1 then now() end, case when i in (3, 4) then (case i when 3 then 1000 else 2000000 end) end,
           case when i in (3, 4) then 100 end
    from unnest(v_ids) with ordinality t(id, i);
    perform private.ai_settle(id) from unnest(v_ids) id;
    select string_agg(status || ':' || settled_by || ':' || actual_usd || ':' || overrun, ',' order by array_position(v_ids, analysis_id))
      into v_states from private.ai_spend_ledger where analysis_id = any (v_ids);
    select not enabled into v_disabled from private.ai_spend_config where id;
    raise exception 'SELFTEST_UNDO';
  exception when others then
    if sqlerrm <> 'SELFTEST_UNDO' then
      v_problems := array_append(v_problems, 'the settlement self-test failed to run'::text);
    end if;
  end;
  if v_states is distinct from 'SETTLED:NO_DISPATCH:0.0000:false,HELD:UNKNOWN_USAGE:0.0000:false,SETTLED:REPORTED_USAGE:0.0015:false,SETTLED:REPORTED_USAGE:2.0005:true'
     or not coalesce(v_disabled, false) then
    v_problems := array_append(v_problems, format('settlement does not behave as reviewed (%s)', coalesce(v_states, 'none')));
  end if;
  if exists (select 1 from private.ai_spend_ledger where analysis_id = any (v_ids)) or (select enabled from private.ai_spend_config where id) then
    v_problems := array_append(v_problems, 'the self-test left something behind'::text);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
             and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%')) then
    v_problems := array_append(v_problems, 'analyses or contact_restrictions are no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: spending controls installed and DISABLED; contract, restrictions and founder-only access unchanged.';
end
$postcheck$;

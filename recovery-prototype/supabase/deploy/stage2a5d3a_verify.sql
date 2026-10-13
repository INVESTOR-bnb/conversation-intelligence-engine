-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5d-3a VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run after stage2a5d3a_deploy.sql; then re-run stage2a5d2_verify.sql and the
-- earlier verification files.
-- ===================================================================
with
tbl(name) as (values ('ai_spend_config'), ('ai_model_prices'), ('ai_spend_ledger')),
fns(sig, kind) as (values
  ('private.ai_estimate_usd(bigint, integer, integer, private.ai_model_prices, private.ai_model_prices, private.ai_spend_config)', 'private'),
  ('private.ai_committed_usd()', 'private'), ('private.ai_settle(uuid)', 'private'), ('private.ai_reconcile(uuid, numeric, text)', 'private'),
  ('public.internal_reserve_ai_spend(uuid, text, text)', 'service'), ('public.internal_ai_dispatch(uuid, text)', 'service'),
  ('public.internal_ai_report_usage(uuid, text, integer, integer)', 'service'), ('public.founder_ai_spend_summary()', 'founder')),
ica as (select prosrc from pg_proc where oid = to_regprocedure('public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)')),
abn as (select prosrc from pg_proc where oid = to_regprocedure('public.founder_abandon_analysis(uuid)')),
checks(ord, check_name, status, detail) as (
  select 1, 'The three spending tables are private: RLS on, no policies, no API privileges',
    case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace join tbl on tbl.name = c.relname
               where n.nspname = 'private' and c.relrowsecurity) = 3
          and not exists (select 1 from pg_policies p join tbl on tbl.name = p.tablename where p.schemaname = 'private')
          and not exists (select 1 from tbl, unnest(array['anon', 'authenticated', 'service_role']) r
                          where to_regclass('private.' || tbl.name) is not null
                            and has_table_privilege(r, ('private.' || tbl.name)::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'))
         then 'PASS' else 'FAIL' end, 'private.ai_spend_config, ai_model_prices, ai_spend_ledger'
  union all
  select 2, 'Spending configuration is present and consistent',
    case when (select count(*) from private.ai_spend_config where stop_at_usd <= budget_usd and max_reservation_usd > 0) = 1 then 'PASS' else 'FAIL' end,
    coalesce((select format('budget %s, stop at %s, max %s per analysis, %s/founder/24h, %s/case/24h, %s/case total',
                            budget_usd, stop_at_usd, max_reservation_usd, founder_attempts_24h, case_attempts_24h, case_attempts_total)
              from private.ai_spend_config), 'missing')
  union all
  select 3, 'Only priced models can be reserved (fake provider at 0)',
    case when exists (select 1 from private.ai_model_prices where model = 'FAKE-PROVIDER-NOT-AI' and active and input_usd_per_mtok = 0 and output_usd_per_mtok = 0)
         then 'PASS' else 'FAIL' end,
    coalesce((select 'active: ' || string_agg(format('%s (%s/%s per M, cap %s)', model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens), '; ' order by model)
              from private.ai_model_prices where active), 'none')
  union all
  select 4, 'The 8 spending functions are SECURITY DEFINER with an empty search_path',
    case when (select count(*) from fns f join pg_proc p on p.oid = to_regprocedure(f.sig) where p.prosecdef and p.proconfig @> array['search_path=""']) = 8
         then 'PASS' else 'FAIL' end,
    coalesce((select 'missing: ' || string_agg(sig, ', ') from fns where to_regprocedure(sig) is null), 'all present')
  union all
  select 5, 'Privileges: service role reserves/dispatches/reports; founders read the summary; nothing else',
    case when (select count(*) from fns where to_regprocedure(sig) is not null) = 8
          and not exists (select 1 from fns f where has_function_privilege('anon', to_regprocedure(f.sig), 'EXECUTE')
             or (f.kind = 'private' and (has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE') or has_function_privilege('service_role', to_regprocedure(f.sig), 'EXECUTE')))
             or (f.kind = 'service' and (has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE') or not has_function_privilege('service_role', to_regprocedure(f.sig), 'EXECUTE')))
             or (f.kind = 'founder' and (not has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE') or has_function_privilege('service_role', to_regprocedure(f.sig), 'EXECUTE'))))
         then 'PASS' else 'FAIL' end, 'anon none; private functions: no API role'
  union all
  select 6, 'Completion and abandonment settle; the contract and restriction preservation are kept',
    case when (select prosrc from ica) like '%private.analysis_output_problems(%' and (select prosrc from ica) like '%REJECTED by analysis contract rre-analysis/1%'
          and (select prosrc from ica) like '%private.preserve_detected_restrictions(%' and (select prosrc from ica) like '%private.ai_settle(%'
          and (select prosrc from abn) like '%private.ai_settle(%' and (select prosrc from abn) like '%private.require_founder()%'
         then 'PASS' else 'FAIL' end, 'internal_complete_analysis, founder_abandon_analysis'
  union all
  select 7, 'Self-test: reservation estimate (synthetic models, 100-byte conversation) = 0.2204',
    case when (private.ai_estimate_usd(100, 1, 0, row('t-a', 1, 5, 1000, true, null)::private.ai_model_prices,
               row('t-r', 10, 50, 2000, true, null)::private.ai_model_prices,
               row(true, 20, 18, 1, 10, 3, 10, false, 8000, 6, 64, 5000, 2, now())::private.ai_spend_config) ->> 'usd')::numeric = 0.2204
         then 'PASS' else 'FAIL' end, 'pure function; nothing stored'
  union all
  select 8, 'Stage 2A-5d-3a deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-5d-3a'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-5d-3a'
  union all
  select 9, 'Spending state (enable only after review: see the deployment guide)', 'INFO',
    coalesce((select format('%s; committed %s of %s (stop at %s)', case when enabled then 'ENABLED' else 'disabled' end,
                            private.ai_committed_usd(), budget_usd, stop_at_usd) from private.ai_spend_config), 'no configuration')
  union all
  select 10, 'Ledger (held or stuck reservations need reconciliation)', 'INFO',
    (select format('%s reserved, %s held, %s settled, %s reconciled, %s overruns, %s reserved for analyses no longer running',
       count(*) filter (where status = 'RESERVED'), count(*) filter (where status = 'HELD'), count(*) filter (where status = 'SETTLED'),
       count(*) filter (where status = 'RECONCILED'), count(*) filter (where overrun),
       count(*) filter (where status = 'RESERVED' and not exists (select 1 from public.analyses a where a.id = l.analysis_id and a.status = 'PENDING')))
     from private.ai_spend_ledger l)
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

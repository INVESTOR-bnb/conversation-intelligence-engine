-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6e VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run after stage2a6e_deploy.sql; then re-run stage2a6a_verify.sql,
-- stage2a5d3a_verify.sql and the earlier verification files.
-- Expected: PASS (4 pass, 0 fail, 1 info).
-- ===================================================================
with
kimi as (select * from private.ai_model_prices where model = 'kimi-k3'),
cfg as (select * from private.ai_spend_config where id),
checks(ord, check_name, status, detail) as (
  select 1, 'kimi-k3 priced at USD 3 / 15 per million tokens, output cap 8000',
    case when exists (select 1 from kimi where input_usd_per_mtok = 3 and output_usd_per_mtok = 15 and max_output_tokens = 8000) then 'PASS' else 'FAIL' end,
    coalesce((select format('%s / %s per M, cap %s', input_usd_per_mtok, output_usd_per_mtok, max_output_tokens) from kimi), 'missing')
  union all
  select 2, 'kimi-k3 INACTIVE (cannot be reserved); the fake provider is the only active model, at 0',
    case when exists (select 1 from kimi where not active)
          and exists (select 1 from private.ai_model_prices where model = 'FAKE-PROVIDER-NOT-AI' and active and input_usd_per_mtok = 0 and output_usd_per_mtok = 0)
          and not exists (select 1 from private.ai_model_prices where active and model <> 'FAKE-PROVIDER-NOT-AI')
         then 'PASS' else 'FAIL' end,
    coalesce((select 'active: ' || string_agg(model, ', ' order by model) from private.ai_model_prices where active), 'none active')
  union all
  select 3, 'Spending DISABLED; budget 20, stop at 18, at most 1 per analysis (unchanged)',
    case when exists (select 1 from cfg where not enabled and budget_usd = 20 and stop_at_usd = 18 and max_reservation_usd = 1) then 'PASS' else 'FAIL' end,
    coalesce((select format('%s; budget %s, stop at %s, max %s per analysis', case when enabled then 'ENABLED' else 'disabled' end,
                            budget_usd, stop_at_usd, max_reservation_usd) from cfg), 'missing')
  union all
  select 4, 'Stage 2A-6e deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-6e'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-6e'
  union all
  select 5, 'What one kimi-k3 analysis would reserve for a 1,000-byte conversation (if it were active)', 'INFO',
    coalesce((select format('kimi-k3 + kimi-k3 %s USD', (private.ai_estimate_usd(1000, 1, 0, k, k, c) ->> 'usd')::numeric(10,4))
              from private.ai_model_prices k, private.ai_spend_config c where k.model = 'kimi-k3' and c.id), 'n/a')
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

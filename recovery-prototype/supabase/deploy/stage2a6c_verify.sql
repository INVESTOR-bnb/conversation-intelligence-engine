-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6c VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run after stage2a6c_deploy.sql; then re-run stage2a6a_verify.sql,
-- stage2a5d3a_verify.sql and the earlier verification files.
-- Expected: PASS (5 pass, 0 fail, 1 info).
-- ===================================================================
with
opus as (select * from private.ai_model_prices where model = 'claude-opus-5-5'),
sonnet as (select * from private.ai_model_prices where model = 'claude-sonnet-5-5'),
cfg as (select * from private.ai_spend_config where id),
checks(ord, check_name, status, detail) as (
  select 1, 'claude-opus-5-5 priced at USD 4 / 20 per million tokens, output cap 8000',
    case when exists (select 1 from opus where input_usd_per_mtok = 4 and output_usd_per_mtok = 20 and max_output_tokens = 8000) then 'PASS' else 'FAIL' end,
    coalesce((select format('%s / %s per M, cap %s', input_usd_per_mtok, output_usd_per_mtok, max_output_tokens) from opus), 'missing')
  union all
  select 2, 'claude-sonnet-5-5 priced at USD 2 / 10 per million tokens, output cap 8000',
    case when exists (select 1 from sonnet where input_usd_per_mtok = 2 and output_usd_per_mtok = 10 and max_output_tokens = 8000) then 'PASS' else 'FAIL' end,
    coalesce((select format('%s / %s per M, cap %s', input_usd_per_mtok, output_usd_per_mtok, max_output_tokens) from sonnet), 'missing')
  union all
  select 3, 'Both paid models INACTIVE (cannot be reserved); the fake provider is the only active model, at 0',
    case when exists (select 1 from opus where not active) and exists (select 1 from sonnet where not active)
          and exists (select 1 from private.ai_model_prices where model = 'FAKE-PROVIDER-NOT-AI' and active and input_usd_per_mtok = 0 and output_usd_per_mtok = 0)
          and not exists (select 1 from private.ai_model_prices where active and model <> 'FAKE-PROVIDER-NOT-AI')
         then 'PASS' else 'FAIL' end,
    coalesce((select 'active: ' || string_agg(model, ', ' order by model) from private.ai_model_prices where active), 'none active')
  union all
  select 4, 'Spending DISABLED; budget 20, stop at 18, at most 1 per analysis (unchanged)',
    case when exists (select 1 from cfg where not enabled and budget_usd = 20 and stop_at_usd = 18 and max_reservation_usd = 1) then 'PASS' else 'FAIL' end,
    coalesce((select format('%s; budget %s, stop at %s, max %s per analysis', case when enabled then 'ENABLED' else 'disabled' end,
                            budget_usd, stop_at_usd, max_reservation_usd) from cfg), 'missing')
  union all
  select 5, 'Stage 2A-6c deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-6c'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-6c'
  union all
  select 6, 'What one analysis would reserve for a 1,000-byte conversation (if the models were active)', 'INFO',
    coalesce((select format('Opus+Opus %s, Opus+Sonnet %s, Sonnet+Sonnet %s USD',
               (private.ai_estimate_usd(1000, 1, 0, o, o, c) ->> 'usd')::numeric(10,4), (private.ai_estimate_usd(1000, 1, 0, o, s, c) ->> 'usd')::numeric(10,4),
               (private.ai_estimate_usd(1000, 1, 0, s, s, c) ->> 'usd')::numeric(10,4))
              from private.ai_model_prices o, private.ai_model_prices s, private.ai_spend_config c
              where o.model = 'claude-opus-5-5' and s.model = 'claude-sonnet-5-5' and c.id), 'n/a')
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

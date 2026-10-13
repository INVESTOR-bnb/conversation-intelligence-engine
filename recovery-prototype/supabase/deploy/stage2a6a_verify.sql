-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6a VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run after stage2a6a_deploy.sql; then re-run stage2a5d3a_verify.sql and the
-- earlier verification files. Expected: PASS (4 pass, 0 fail, 1 info).
-- ===================================================================
with
fn as (select p.* from pg_proc p where p.oid = to_regprocedure('public.internal_ai_reservation_terms(uuid)')),
checks(ord, check_name, status, detail) as (
  select 1, 'internal_ai_reservation_terms exists: SECURITY DEFINER, STABLE (cannot write), empty search_path',
    case when exists (select 1 from fn where prosecdef and provolatile = 's' and proconfig @> array['search_path=""']) then 'PASS' else 'FAIL' end,
    'public.internal_ai_reservation_terms(uuid)'
  union all
  select 2, 'Privileges: the service role only (no anonymous or signed-in caller)',
    case when exists (select 1 from fn) and not has_function_privilege('anon', (select oid from fn), 'EXECUTE')
          and not has_function_privilege('authenticated', (select oid from fn), 'EXECUTE')
          and has_function_privilege('service_role', (select oid from fn), 'EXECUTE')
         then 'PASS' else 'FAIL' end, 'service_role'
  union all
  select 3, 'Refuses non-service callers and unknown reservations; reads the ledger only',
    case when (select prosrc from fn) like '%<> ''service_role''%' and (select prosrc from fn) like '%NOT_RESERVED%'
          and (select prosrc from fn) like '%from private.ai_spend_ledger where analysis_id = p_analysis_id%'
          and (select prosrc from fn) !~* '\m(insert|update|delete|truncate)\M'
         then 'PASS' else 'FAIL' end, 'FORBIDDEN / NOT_RESERVED'
  union all
  select 4, 'Stage 2A-6a deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-6a'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-6a'
  union all
  select 5, 'Spending state (unchanged by this stage)', 'INFO',
    coalesce((xpath('/row/s/text()', query_to_xml($q$select case when enabled then 'ENABLED' else 'disabled' end as s from private.ai_spend_config where id$q$, false, true, '')))[1]::text, 'no configuration')
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

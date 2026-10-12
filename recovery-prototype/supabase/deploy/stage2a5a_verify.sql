-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5a VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run after stage2a5a_deploy.sql; then re-run stage2a4c_verify.sql,
-- stage2a4b_verify.sql and stage2a1_verify.sql.
-- ===================================================================
with
fns(sig) as (values ('private.ac_text(jsonb, integer)'), ('private.ac_extra_keys(jsonb, text[])'), ('private.ac_norm(text)'), ('private.ac_arr(jsonb)'),
  ('private.ac_ref_problems(public.analyses, jsonb, text)'), ('private.ac_refs_problems(public.analyses, jsonb, text, integer)'),
  ('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)')),
ica as (select to_regprocedure('public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)') as oid),
checks(ord, check_name, status, detail) as (
  select 1, 'The 7 contract functions exist',
    case when (select count(*) from fns where to_regprocedure(sig) is not null) = 7 then 'PASS' else 'FAIL' end,
    coalesce((select 'missing: ' || string_agg(sig, ', ') from fns where to_regprocedure(sig) is null), 'all present')
  union all
  select 2, 'Contract functions are SECURITY DEFINER with an empty search_path',
    case when not exists (select 1 from fns f join pg_proc p on p.oid = to_regprocedure(f.sig) where not (p.prosecdef and p.proconfig @> array['search_path=""']))
          and (select count(*) from fns where to_regprocedure(sig) is not null) = 7 then 'PASS' else 'FAIL' end, 'private schema'
  union all
  select 3, 'No API role can call the contract functions directly',
    case when not exists (select 1 from fns f where to_regprocedure(f.sig) is not null
                          and (has_function_privilege('anon', to_regprocedure(f.sig), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE')
                               or has_function_privilege('service_role', to_regprocedure(f.sig), 'EXECUTE')))
          and (select count(*) from fns where to_regprocedure(sig) is not null) = 7 then 'PASS' else 'FAIL' end, 'anon, authenticated, service_role'
  union all
  select 4, 'internal_complete_analysis enforces the contract',
    case when (select prosrc from pg_proc where oid = (select oid from ica)) like '%private.analysis_output_problems(%'
          and (select prosrc from pg_proc where oid = (select oid from ica)) like '%REJECTED by analysis contract rre-analysis/1%' then 'PASS' else 'FAIL' end,
    'stores an analysis only if it meets rre-analysis/1'
  union all
  select 5, 'internal_complete_analysis is server-side only',
    case when has_function_privilege('service_role', (select oid from ica), 'EXECUTE')
          and not has_function_privilege('authenticated', (select oid from ica), 'EXECUTE')
          and not has_function_privilege('anon', (select oid from ica), 'EXECUTE') then 'PASS' else 'FAIL' end, 'service_role only'
  union all
  select 6, 'Analyses are founder-only (one SELECT policy, founder check only)',
    case when (select count(*) from pg_policies where schemaname = 'public' and tablename = 'analyses') = 1
          and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'analyses' and cmd = 'SELECT'
                      and qual like '%is_founder%' and qual not like '%is_member%') then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(policyname || ': ' || qual, ' | ') from pg_policies where schemaname = 'public' and tablename = 'analyses'), 'no policy')
  union all
  select 7, 'The contract rejects an empty analysis (live check, read-only)',
    case when to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)') is not null
          and (xpath('/row/n/text()', query_to_xml($q$select cardinality(private.analysis_output_problems(null::public.analyses, 'COMPLETE', '{}'::jsonb, null, null, '[]'::jsonb)) as n$q$, false, true, '')))[1]::text::int > 0
         then 'PASS' else 'FAIL' end, 'output {} with status COMPLETE'
  union all
  select 8, 'Stage 2A-5a deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-5a'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-5a'
  union all
  select 9, 'Analyses recorded before the contract (not re-validated)', 'INFO',
    (select count(*) from public.analyses a where a.status in ('COMPLETE', 'INSUFFICIENT_EVIDENCE')
       and a.completed_at < coalesce((select min(at) from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-5a'), now()))::text
    || ' completed analyses predate the contract'
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

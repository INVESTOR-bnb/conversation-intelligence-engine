-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4b VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run in the Supabase SQL Editor after stage2a4b_deploy.sql. Every row should
-- be PASS (INFO rows are for information). The first row is the overall result.
-- Also re-run stage2a1_verify.sql: it must still be OVERALL PASS.
-- ===================================================================
with
founder_only(name) as (values
  ('cases'), ('case_messages'), ('case_screenshots'), ('outcomes'),
  ('analyses'), ('approvals'), ('client_recommendations'), ('contact_restrictions'), ('founder_notes'), ('audit_log')),
fo as (
  select f.name,
    (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = f.name) as policies,
    (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = f.name and p.cmd = 'SELECT'
       and p.roles = '{authenticated}' and p.qual like '%is_founder%' and p.qual not like '%is_member%' and p.qual not like '%auth.uid%') as founder_only
  from founder_only f),
client_fns(sig) as (values ('public.client_list_cases()'), ('public.client_get_case(uuid)')),
fns as (
  select c.sig, to_regprocedure(c.sig) as oid from client_fns c),
checks(ord, check_name, status, detail) as (
  select 1, 'Case tables are founder-only (cases, case_messages, case_screenshots, outcomes)',
    case when (select count(*) from fo where name in ('cases', 'case_messages', 'case_screenshots', 'outcomes') and policies = 1 and founder_only = 1) = 4 then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(name, ', ') from fo where name in ('cases', 'case_messages', 'case_screenshots', 'outcomes') and not (policies = 1 and founder_only = 1)), 'all four founder-only') || ''
  union all
  select 2, 'Private intelligence tables are still founder-only',
    case when (select count(*) from fo where name not in ('cases', 'case_messages', 'case_screenshots', 'outcomes') and policies = 1 and founder_only = 1) = 6 then 'PASS' else 'FAIL' end,
    'analyses, approvals, client_recommendations, contact_restrictions, founder_notes, audit_log'
  union all
  select 3, 'Clients still read their own business and membership only',
    case when (select count(*) from pg_policies where schemaname = 'public' and tablename = 'businesses' and qual like '%is_member%') = 1
          and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'business_members' and qual like '%auth.uid%') = 1
         then 'PASS' else 'FAIL' end,
    'businesses: founder or member; business_members: founder or own row'
  union all
  select 4, 'RLS enabled on every public table',
    case when not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity) then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(tablename, ', ') from pg_tables where schemaname = 'public' and not rowsecurity), 'all tables')
  union all
  select 5, 'No direct writes: authenticated has SELECT only, anon nothing, only SELECT policies',
    case when not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT')
          and not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon')
          and not exists (select 1 from pg_policies where schemaname = 'public' and cmd <> 'SELECT')
         then 'PASS' else 'FAIL' end, 'grants and policies'
  union all
  select 6, 'Client read functions: SECURITY DEFINER, fixed search_path, authenticated only',
    case when (select count(*) from fns f join pg_proc p on p.oid = f.oid
               where p.prosecdef and p.proconfig @> array['search_path=""']
                 and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 and not has_function_privilege('anon', p.oid, 'EXECUTE')) = 2 then 'PASS' else 'FAIL' end,
    'client_list_cases(), client_get_case(uuid)'
  union all
  select 7, 'Stage 2A-4b deployment recorded in the audit log',
    case when to_regclass('public.audit_log') is null then 'FAIL'
         when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-4b'$q$, false, true, '')))[1]::text::int >= 1 then 'PASS'
         else 'FAIL' end,
    'action SCHEMA_DEPLOYED, stage 2A-4b'
  union all
  select 8, 'Rollback recorded after deployment', 'INFO',
    case when to_regclass('public.audit_log') is null then 'audit log missing'
         else (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_ROLLED_BACK' and details->>'stage' = '2A-4b'$q$, false, true, '')))[1]::text || ' rollback(s) recorded' end
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

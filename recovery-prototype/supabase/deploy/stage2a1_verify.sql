-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-1 VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times,
-- including before deployment (it then reports FAIL rows instead of erroring).
-- Run in the Supabase SQL Editor after the deployment. Every row should be
-- PASS (INFO rows are for information). The first row is the overall result.
-- ===================================================================
with
expected_tables(name) as (values
  ('businesses'), ('business_members'), ('founders'), ('cases'), ('case_messages'), ('case_screenshots'),
  ('analyses'), ('approvals'), ('client_recommendations'), ('contact_restrictions'), ('founder_notes'),
  ('outcomes'), ('audit_log')),
founder_only_tables(name) as (values
  ('analyses'), ('approvals'), ('client_recommendations'), ('contact_restrictions'), ('founder_notes'), ('audit_log')),
api_functions(name) as (values
  ('whoami'), ('founder_create_business'), ('founder_add_member'), ('client_create_case'), ('client_submit_case'),
  ('client_record_sent'), ('client_add_response'), ('client_report_opt_out'), ('client_record_outcome'),
  ('client_list_cases'), ('client_get_case'), ('founder_start_analysis'), ('founder_abandon_analysis'),
  ('founder_request_reanalysis'), ('founder_approve'), ('founder_stop_contact'), ('founder_add_restriction'),
  ('founder_dismiss_ai_restriction'), ('founder_add_note'), ('founder_pause_case')),
-- Functions added by later stages (allowed, not required, by this 2A-1 check).
later_api_functions(name) as (values ('client_screenshot_status'), ('client_finalize_screenshots')),
-- Supabase's pre-existing auto-RLS helper (event-trigger function; cannot be
-- called directly). Excluded from the API-privilege checks, checked in row 20.
helper as (
  select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0
    and p.prorettype = 'event_trigger'::regtype),
helper_now as (
  select md5(concat_ws('|', p.prosrc, coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), 'NULL'), pg_get_userbyid(p.proowner), p.prosecdef::text,
                       coalesce(p.proconfig::text, 'NULL'), et.evtname, et.evtevent, et.evtenabled::text,
                       coalesce(et.evttags::text, 'NULL'), pg_get_userbyid(et.evtowner))) as fingerprint,
         md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) as body_md5
  from pg_proc p join pg_event_trigger et on et.evtfoid = p.oid where p.oid in (select oid from helper)),
helper_recorded as (
  select
    case when to_regclass('public.audit_log') is null then null else
      (xpath('/row/f/text()', query_to_xml('select details->''preexisting_rls_auto_enable''->>''fingerprint'' as f from public.audit_log where action = ''SCHEMA_DEPLOYED'' and details->>''stage'' = ''2A-1'' order by id desc limit 1', false, true, '')))[1]::text end as fingerprint,
    case when to_regclass('public.audit_log') is null then null else
      (xpath('/row/b/text()', query_to_xml('select details->''preexisting_rls_auto_enable''->>''body_md5'' as b from public.audit_log where action = ''SCHEMA_DEPLOYED'' and details->>''stage'' = ''2A-1'' order by id desc limit 1', false, true, '')))[1]::text end as body_md5),
pub_fn as (
  select p.oid, p.proname, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    and p.oid not in (select oid from helper)),
all_fn as (
  select p.oid, p.proname, n.nspname, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')),
checks(ord, check_name, status, detail) as (
  select 1, 'Deployment recorded',
    case when to_regclass('public.audit_log') is not null
          and (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.audit_log where action = ''SCHEMA_DEPLOYED''', false, true, '')))[1]::text::bigint > 0 then 'PASS' else 'FAIL' end,
    'audit_log contains the SCHEMA_DEPLOYED entry'
  union all
  select 2, 'All 13 tables exist',
    case when (select count(*) from expected_tables e where to_regclass('public.' || e.name) is not null) = 13 then 'PASS' else 'FAIL' end,
    coalesce((select 'missing: ' || string_agg(e.name, ', ') from expected_tables e where to_regclass('public.' || e.name) is null), 'none missing')
  union all
  select 3, 'Row level security on every public table',
    case when not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity) then 'PASS' else 'FAIL' end,
    coalesce((select 'without RLS: ' || string_agg(tablename, ', ') from pg_tables where schemaname = 'public' and not rowsecurity), 'all enabled')
  union all
  select 4, 'anon has no table privileges',
    case when not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon') then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(distinct table_name || ':' || privilege_type, ', ') from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'), 'none')
  union all
  select 5, 'authenticated can only SELECT (no direct writes)',
    case when not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT') then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(distinct table_name || ':' || privilege_type, ', ') from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT'), 'SELECT only')
  union all
  select 6, 'Only SELECT row-level-security policies exist',
    case when not exists (select 1 from pg_policies where schemaname = 'public' and cmd <> 'SELECT') then 'PASS' else 'FAIL' end,
    (select count(*) || ' SELECT policies' from pg_policies where schemaname = 'public')
  union all
  select 7, 'Private intelligence tables are founder-only',
    case when (select count(*) from pg_policies p join founder_only_tables f on f.name = p.tablename
               where p.schemaname = 'public' and p.qual like '%is_founder%' and p.qual not like '%is_member%' and p.qual not like '%auth.uid%') = 6
          and (select count(*) from pg_policies p join founder_only_tables f on f.name = p.tablename where p.schemaname = 'public') = 6
         then 'PASS' else 'FAIL' end,
    'analyses, approvals, client_recommendations, contact_restrictions, founder_notes, audit_log'
  union all
  select 8, 'All 20 API functions + internal_complete_analysis exist',
    case when (select count(*) from api_functions a where exists (select 1 from pub_fn f where f.proname = a.name)) = 20
          and exists (select 1 from pub_fn where proname = 'internal_complete_analysis') then 'PASS' else 'FAIL' end,
    coalesce((select 'missing: ' || string_agg(a.name, ', ') from api_functions a where not exists (select 1 from pub_fn f where f.proname = a.name)), 'none missing')
  union all
  select 9, 'anon cannot execute any function',
    case when not exists (select 1 from all_fn where has_function_privilege('anon', oid, 'EXECUTE')
                          and oid not in (select oid from helper)) then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(nspname || '.' || proname, ', ') from all_fn where has_function_privilege('anon', oid, 'EXECUTE')
              and oid not in (select oid from helper)), 'none (Supabase event-trigger helper excluded: not callable)')
  union all
  select 10, 'authenticated executes exactly the API functions',
    case when not exists (select 1 from pub_fn f where has_function_privilege('authenticated', f.oid, 'EXECUTE')
                            and f.proname not in (select name from api_functions union all select name from later_api_functions))
          and (select count(*) from pub_fn f where has_function_privilege('authenticated', f.oid, 'EXECUTE')
                 and f.proname in (select name from api_functions)) = 20
         then 'PASS' else 'FAIL' end,
    coalesce((select 'unexpected: ' || string_agg(proname, ', ') from pub_fn f where has_function_privilege('authenticated', f.oid, 'EXECUTE')
              and f.proname not in (select name from api_functions union all select name from later_api_functions)), 'as expected')
  union all
  select 11, 'internal_complete_analysis is server-side only',
    case when exists (select 1 from pub_fn where proname = 'internal_complete_analysis'
                      and has_function_privilege('service_role', oid, 'EXECUTE')
                      and not has_function_privilege('authenticated', oid, 'EXECUTE')
                      and not has_function_privilege('anon', oid, 'EXECUTE')) then 'PASS' else 'FAIL' end,
    'service_role only'
  union all
  select 12, 'Private helpers: authenticated runs only role checks',
    case when coalesce((select string_agg(proname, ',' order by proname) from all_fn
                        where nspname = 'private' and has_function_privilege('authenticated', oid, 'EXECUTE')), '')
           in ('is_founder,is_member', 'is_founder,is_member,screenshot_upload_allowed') -- the latter once Stage 2A-4c is deployed
         then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(proname, ',' order by proname) from all_fn where nspname = 'private' and has_function_privilege('authenticated', oid, 'EXECUTE')), 'none')
  union all
  select 13, 'Every SECURITY DEFINER function pins search_path',
    case when not exists (select 1 from all_fn where prosecdef
                          and not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')) then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(nspname || '.' || proname, ', ') from all_fn where prosecdef
              and not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')), 'all pinned')
  union all
  select 14, 'Approvals and audit log are immutable (triggers enabled)',
    case when (select count(*) from pg_trigger where tgname in ('approvals_immutable', 'approvals_no_truncate', 'audit_log_immutable', 'audit_log_no_truncate')
               and tgenabled <> 'D') = 4 then 'PASS' else 'FAIL' end,
    '4 triggers expected'
  union all
  select 15, 'No default grants to anon/authenticated for new objects (postgres role)',
    case when not exists (
      select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
      where n.nspname = 'public' and pg_get_userbyid(d.defaclrole) = 'postgres'
        and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated'))) then 'PASS' else 'FAIL' end,
    'future public objects created by postgres start with no API access'
  union all
  select 16, 'Default grants held by other roles (review)',
    case when exists (
      select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
      where n.nspname = 'public' and pg_get_userbyid(d.defaclrole) <> 'postgres'
        and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated'))) then 'INFO' else 'PASS' end,
    coalesce((select string_agg(distinct pg_get_userbyid(d.defaclrole), ', ') from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
              cross join lateral aclexplode(d.defaclacl) a
              where n.nspname = 'public' and pg_get_userbyid(d.defaclrole) <> 'postgres'
                and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated'))), 'none')
              || ' (objects these roles create later in public would be API-visible; new tables are still protected by the RLS check above)'
  union all
  select 17, 'Founder accounts', 'INFO',
    case when to_regclass('public.founders') is null then 'table missing'
         else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.founders', false, true, '')))[1]::text::bigint || ' founder(s) — 0 until bootstrap_founder.sql is run' end
  union all
  select 18, 'Data present', 'INFO',
    case when to_regclass('public.cases') is null then 'tables missing'
         else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.businesses', false, true, '')))[1]::text::bigint || ' business(es), ' || (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.cases', false, true, '')))[1]::text::bigint || ' case(s) — expected 0 right after deployment' end
  union all
  select 20, 'Supabase auto-RLS helper rls_auto_enable unchanged since deployment',
    case when not exists (select 1 from helper) then 'INFO'
         when (select fingerprint from helper_recorded) is null then 'INFO'
         when (select fingerprint from helper_now) = (select fingerprint from helper_recorded)
          and (select body_md5 from helper_now) = (select body_md5 from helper_recorded) then 'PASS'
         else 'FAIL' end,
    case when not exists (select 1 from helper) then 'not present in this database'
         when (select fingerprint from helper_recorded) is null then 'present, but no fingerprint was recorded at deployment'
         when (select fingerprint from helper_now) = (select fingerprint from helper_recorded) then 'definition, owner, privileges and event trigger ensure_rls identical to deployment time'
         else 'CHANGED since deployment (definition, privileges, owner or event trigger ensure_rls) — investigate' end
  union all
  select 19, 'API exposure of schema private', 'INFO',
    'cannot be checked from SQL: in Settings → API, exposed schemas must NOT include "private"'
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

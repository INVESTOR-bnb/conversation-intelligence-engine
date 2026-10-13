-- Structural guarantees checked from the catalogue (default deny).
begin;
select tests.as_owner();

select tests.is(
  (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity), 0::bigint,
  'every public table has row level security enabled');

select tests.is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'), 0::bigint,
  'anon/authenticated hold no INSERT/UPDATE/DELETE/TRUNCATE privilege on any public table');

select tests.is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'), 0::bigint,
  'anon holds no privilege on any public table');

select tests.is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'EXECUTE')
     -- Supabase's pre-existing auto-RLS helper keeps its platform grants by design;
     -- it is an event-trigger function and cannot be called directly.
     and not (n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.prorettype = 'event_trigger'::regtype)), 0::bigint,
  'anon cannot execute any public or private function (except the uncallable Supabase event-trigger helper)');

select tests.is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')), 0::bigint,
  'every SECURITY DEFINER function pins search_path');

select tests.is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  'is_founder,is_member,screenshot_upload_allowed',
  'authenticated can execute only the read-only role checks and the screenshot upload rule in schema private');

select tests.is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not (p.proname = 'rls_auto_enable' and p.prorettype = 'event_trigger'::regtype)),
  'client_add_response,client_create_case,client_finalize_screenshots,client_get_case,client_list_cases,client_record_outcome,client_record_sent,client_report_opt_out,client_screenshot_status,client_submit_case,founder_abandon_analysis,founder_add_member,founder_add_note,founder_add_restriction,founder_ai_spend_summary,founder_approve,founder_create_business,founder_dismiss_ai_restriction,founder_pause_case,founder_request_reanalysis,founder_start_analysis,founder_stop_contact,whoami',
  'authenticated can execute exactly the 23 API functions in schema public (founder_ai_spend_summary since Stage 2A-5d-3a)');

select tests.ok(
  not has_function_privilege('authenticated', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE'),
  'authenticated cannot execute internal_complete_analysis');

select tests.ok(
  not exists (select 1 from pg_policies where schemaname = 'public' and cmd <> 'SELECT'),
  'no INSERT/UPDATE/DELETE policies exist');

rollback;

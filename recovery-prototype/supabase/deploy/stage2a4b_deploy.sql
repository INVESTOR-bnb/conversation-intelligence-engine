-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4b DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a4b.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-1. Changes four SELECT policies only (no tables, columns,
-- grants, functions or data). All-or-nothing. Contains no credentials.
-- Refuses to run if 2A-1 is missing, if 2A-4b is already applied, or if the
-- policies are not exactly as Stage 2A-1 left them.
-- Undo: deploy/stage2a4b_rollback.sql. Check: deploy/stage2a4b_verify.sql.
--
-- Source migration (sha256):
--   20261011120000_stage2a4b_client_reads.sql  1252be69e4a48955f13ab6c0452a7c47b7cb7b17b02dcb39368d6f21e104b454
-- ===================================================================

begin;

-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-1 is installed
-- and the four case-table SELECT policies are exactly the 2A-1 client+founder
-- policies. If 2A-4b is already applied, it stops with a clear message.
-- ===================================================================
do $preflight$
declare
  v_problems text[] := '{}';
  v_t text;
  v_n int;
  v_qual text;
  v_applied int := 0;
begin
  if to_regclass('public.cases') is null or to_regnamespace('private') is null
     or to_regprocedure('private.is_founder()') is null or to_regprocedure('private.is_member(uuid)') is null
     or to_regprocedure('public.client_list_cases()') is null or to_regprocedure('public.client_get_case(uuid)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-1 is not installed in this database.';
  end if;

  foreach v_t in array array['cases', 'case_messages', 'case_screenshots', 'outcomes'] loop
    select count(*) into v_n from pg_policies where schemaname = 'public' and tablename = v_t;
    if v_n <> 1 then
      v_problems := array_append(v_problems, format('%s has %s policies (expected exactly 1)', v_t, v_n));
      continue;
    end if;
    select qual into v_qual from pg_policies
    where schemaname = 'public' and tablename = v_t and policyname = v_t || '_select'
      and cmd = 'SELECT' and permissive = 'PERMISSIVE' and roles = '{authenticated}';
    if v_qual is null then
      v_problems := array_append(v_problems, format('%s: policy %s_select (SELECT, authenticated) not found', v_t, v_t));
    elsif v_qual like '%is_founder%' and v_qual like '%is_member%' then
      null; -- 2A-1 policy: founder or member of the business
    elsif v_qual like '%is_founder%' and v_qual not like '%is_member%' and v_qual not like '%auth.uid%' then
      v_applied := v_applied + 1;
    else
      v_problems := array_append(v_problems, format('%s: unexpected policy condition %s', v_t, v_qual));
    end if;
  end loop;

  if v_applied = 4 and cardinality(v_problems) = 0 then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-4b is already applied.';
  end if;
  if v_applied > 0 then
    v_problems := array_append(v_problems, format('%s of 4 policies already changed (partial state)', v_applied));
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Preflight passed: Stage 2A-1 policies found; applying Stage 2A-4b.';
end
$preflight$;

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261011120000_stage2a4b_client_reads.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-4b — clients no longer read case tables directly.
--
-- Before: RLS let a client SELECT its own rows of cases, outcomes,
-- case_messages and case_screenshots. That exposed internal fields the
-- client functions deliberately hide: cases.workflow_state / review_reason
-- (e.g. CONTACT_RESTRICTION), a founder's private pause note in outcomes.note,
-- and approval links in case_messages.
--
-- After: these four tables are readable by the founder only (same rule as the
-- private intelligence tables). Clients read case data exclusively through
-- public.client_list_cases() / public.client_get_case(), which are SECURITY
-- DEFINER, filter by the caller's own business and return client-safe fields.
--
-- Changes policies only: no tables, columns, grants, functions or data.
-- Rollback: supabase/deploy/stage2a4b_rollback.sql restores the 2A-1 policies.

drop policy cases_select on public.cases;
create policy cases_select on public.cases for select to authenticated
  using ((select private.is_founder()));

drop policy case_messages_select on public.case_messages;
create policy case_messages_select on public.case_messages for select to authenticated
  using ((select private.is_founder()));

drop policy case_screenshots_select on public.case_screenshots;
create policy case_screenshots_select on public.case_screenshots for select to authenticated
  using ((select private.is_founder()));

drop policy outcomes_select on public.outcomes;
create policy outcomes_select on public.outcomes for select to authenticated
  using ((select private.is_founder()));
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261011120000_stage2a4b_client_reads.sql <<<<<<<<<<<<<<<<<<<<

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem
-- rolls everything back.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_t text;
  v_n bigint;
begin
  foreach v_t in array array['cases', 'case_messages', 'case_screenshots', 'outcomes',
                             'analyses', 'approvals', 'client_recommendations', 'contact_restrictions', 'founder_notes', 'audit_log'] loop
    select count(*) into v_n from pg_policies
    where schemaname = 'public' and tablename = v_t and cmd = 'SELECT' and roles = '{authenticated}'
      and qual like '%is_founder%' and qual not like '%is_member%' and qual not like '%auth.uid%';
    if v_n <> 1 or (select count(*) from pg_policies where schemaname = 'public' and tablename = v_t) <> 1 then
      v_problems := array_append(v_problems, format('%s is not founder-only', v_t));
    end if;
  end loop;

  select count(*) into v_n from pg_tables where schemaname = 'public' and not rowsecurity;
  if v_n > 0 then v_problems := array_append(v_problems, format('%s public table(s) without RLS', v_n)); end if;

  select count(*) into v_n from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if v_n > 0 then v_problems := array_append(v_problems, format('authenticated holds %s non-SELECT table privilege(s)', v_n)); end if;

  select count(*) into v_n from pg_policies where schemaname = 'public' and cmd <> 'SELECT';
  if v_n > 0 then v_problems := array_append(v_problems, 'a non-SELECT policy exists'); end if;

  if not (select prosecdef from pg_proc where oid = 'public.client_list_cases()'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.client_get_case(uuid)'::regprocedure)
     or not has_function_privilege('authenticated', 'public.client_list_cases()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.client_get_case(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.client_list_cases()', 'EXECUTE')
     or has_function_privilege('anon', 'public.client_get_case(uuid)', 'EXECUTE') then
    v_problems := array_append(v_problems, 'client read functions are not SECURITY DEFINER / executable by authenticated only'::text);
  end if;

  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: case tables are founder-only; client functions intact.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-4b', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261011120000_stage2a4b_client_reads.sql', 'sha256', '1252be69e4a48955f13ab6c0452a7c47b7cb7b17b02dcb39368d6f21e104b454'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

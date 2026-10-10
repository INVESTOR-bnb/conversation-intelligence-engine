-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4b ROLLBACK (single transaction)
-- Restores the four Stage 2A-1 SELECT policies (founder OR member of the
-- business) on cases, case_messages, case_screenshots and outcomes, exactly
-- as written in migrations/20261009120100_stage2a1_security.sql.
--
-- WARNING: this re-opens the client exposure that 2A-4b closed (clients can
-- again read raw case state, review reasons and founder pause notes).
-- Use only if 2A-4b itself causes a problem.
--
-- Changes policies only; no data is touched. Safe to re-run: if 2A-4b is not
-- applied it refuses and changes nothing. Afterwards run stage2a1_verify.sql.
-- ===================================================================

begin;

do $preflight$
declare
  v_t text;
  v_n int;
begin
  if to_regclass('public.cases') is null then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-1 is not installed in this database.';
  end if;
  foreach v_t in array array['cases', 'case_messages', 'case_screenshots', 'outcomes'] loop
    select count(*) into v_n from pg_policies
    where schemaname = 'public' and tablename = v_t and policyname = v_t || '_select' and cmd = 'SELECT'
      and qual like '%is_founder%' and qual not like '%is_member%' and qual not like '%auth.uid%';
    if v_n <> 1 or (select count(*) from pg_policies where schemaname = 'public' and tablename = v_t) <> 1 then
      raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-4b is not applied (policy on % is not the 2A-4b founder-only policy).', v_t;
    end if;
  end loop;
  raise notice 'Rollback preflight passed: Stage 2A-4b policies found; restoring Stage 2A-1 policies.';
end
$preflight$;

drop policy cases_select on public.cases;
create policy cases_select on public.cases for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(business_id)));

drop policy case_messages_select on public.case_messages;
create policy case_messages_select on public.case_messages for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(business_id)));

drop policy case_screenshots_select on public.case_screenshots;
create policy case_screenshots_select on public.case_screenshots for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(business_id)));

drop policy outcomes_select on public.outcomes;
create policy outcomes_select on public.outcomes for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(business_id)));

do $postcheck$
declare
  v_t text;
begin
  foreach v_t in array array['cases', 'case_messages', 'case_screenshots', 'outcomes'] loop
    if (select count(*) from pg_policies where schemaname = 'public' and tablename = v_t
        and qual like '%is_founder%' and qual like '%is_member%') <> 1 then
      raise exception 'ROLLBACK ABORTED (rolled back): % policy not restored', v_t;
    end if;
  end loop;
  raise notice 'Rollback self-check passed: Stage 2A-1 policies restored.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_ROLLED_BACK', jsonb_build_object('stage', '2A-4b',
  'restored', 'Stage 2A-1 SELECT policies on cases, case_messages, case_screenshots, outcomes'));

commit;
-- END OF ROLLBACK FILE — if this line is missing, the copy is incomplete: do not run.

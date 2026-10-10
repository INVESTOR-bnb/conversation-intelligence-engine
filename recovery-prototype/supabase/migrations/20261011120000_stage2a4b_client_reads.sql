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

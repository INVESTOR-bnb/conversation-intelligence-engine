-- Stage 2A-1 — access control.
--
-- Default deny:
--   * anon: nothing.
--   * authenticated: SELECT only, and only where a row-level-security policy
--     allows it. No direct INSERT/UPDATE/DELETE on any table for anyone using
--     the public API; every change goes through a guarded function.
--   * Private intelligence (analyses, approvals, recommendations, restrictions,
--     founder notes, audit log) is readable by founders only. Clients receive
--     approved content exclusively through client_* functions.
--
-- RLS is enabled but not FORCED: the guarded SECURITY DEFINER functions run as
-- the table owner and perform their own authorisation checks.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------- helpers

create function private.is_founder() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.founders f where f.user_id = (select auth.uid()));
$$;

create function private.is_member(p_business_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.user_id = (select auth.uid())
  );
$$;

-- The caller's business (clients belong to exactly one), or null.
create function private.my_business_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.business_id from public.business_members m where m.user_id = (select auth.uid());
$$;

create function private.audit(
  p_action text, p_case_id uuid, p_business_id uuid, p_actor_role text,
  p_client_label text default null, p_details jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor, actor_role, action, case_id, business_id, client_label, details)
  values ((select auth.uid()), p_actor_role, p_action, p_case_id, p_business_id, p_client_label, coalesce(p_details, '{}'::jsonb));
$$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;
-- Only the read-only role checks are callable by signed-in users (needed by RLS policies).
grant execute on function private.is_founder() to authenticated;
grant execute on function private.is_member(uuid) to authenticated;

-- ---------------------------------------------------------------- default deny

-- Supabase grants ALL on public tables/functions to anon and authenticated by
-- default. Remove that for existing and future objects.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- Revoke on every function in public EXCEPT Supabase's pre-existing auto-RLS
-- helper public.rls_auto_enable() (an event-trigger function: it cannot be
-- called directly, and the deployment guard requires it to stay unmodified).
do $revoke$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not (p.proname = 'rls_auto_enable' and p.prorettype = 'event_trigger'::regtype)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
  end loop;
end
$revoke$;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- Trigger functions are never called directly.
revoke all on function public.tg_forbid_change() from public, anon, authenticated, service_role;
revoke all on function public.tg_touch_updated_at() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- row level security

alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.founders enable row level security;
alter table public.cases enable row level security;
alter table public.case_messages enable row level security;
alter table public.case_screenshots enable row level security;
alter table public.analyses enable row level security;
alter table public.approvals enable row level security;
alter table public.client_recommendations enable row level security;
alter table public.contact_restrictions enable row level security;
alter table public.founder_notes enable row level security;
alter table public.outcomes enable row level security;
alter table public.audit_log enable row level security;

grant select on
  public.businesses, public.business_members, public.founders, public.cases, public.case_messages,
  public.case_screenshots, public.analyses, public.approvals, public.client_recommendations,
  public.contact_restrictions, public.founder_notes, public.outcomes, public.audit_log
to authenticated;

-- Client-visible own data (plus founder).
create policy businesses_select on public.businesses for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(id)));

create policy business_members_select on public.business_members for select to authenticated
  using ((select private.is_founder()) or user_id = (select auth.uid()));

create policy founders_select on public.founders for select to authenticated
  using ((select private.is_founder()));

create policy cases_select on public.cases for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(business_id)));

create policy case_messages_select on public.case_messages for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(business_id)));

create policy case_screenshots_select on public.case_screenshots for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(business_id)));

create policy outcomes_select on public.outcomes for select to authenticated
  using ((select private.is_founder()) or (select private.is_member(business_id)));

-- Founder-only private intelligence.
create policy analyses_select on public.analyses for select to authenticated
  using ((select private.is_founder()));
create policy approvals_select on public.approvals for select to authenticated
  using ((select private.is_founder()));
create policy client_recommendations_select on public.client_recommendations for select to authenticated
  using ((select private.is_founder()));
create policy contact_restrictions_select on public.contact_restrictions for select to authenticated
  using ((select private.is_founder()));
create policy founder_notes_select on public.founder_notes for select to authenticated
  using ((select private.is_founder()));
create policy audit_log_select on public.audit_log for select to authenticated
  using ((select private.is_founder()));

-- No INSERT/UPDATE/DELETE policies exist and no such privileges are granted:
-- with RLS enabled, every direct write from anon/authenticated is denied.

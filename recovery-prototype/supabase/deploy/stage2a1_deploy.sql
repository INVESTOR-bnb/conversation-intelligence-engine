-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-1 DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query.
-- All-or-nothing: if anything fails, nothing is changed.
-- Creates no users, no founder, no data; contains no credentials.
-- Refuses to run if Stage 2A-1 is already installed or schema public is not empty.
--
-- Source migrations (sha256):
--   20261009120000_stage2a1_schema.sql  7637b2bc224a7295cb5565e3719becd8da3af332099d8341c0d5b9d4210801dc
--   20261009120100_stage2a1_security.sql  519719283de701e50ecf435afcd223085e6cc8b4730eeedc3931b39106211dc9
--   20261009120200_stage2a1_functions.sql  59636379ba9ff7ae99e3f433ee953ab4432cfe9691e481ca70cc8e96fcd35c49
-- Verified pre-existing object (left unchanged):
--   deploy/known/rls_auto_enable.verified.sql  b21d88816c445d14cef5032c3cd4abaebc1db2001fcb3435022ab6b496182ca4
-- ===================================================================

begin;

-- ===================================================================
-- PREFLIGHT GUARD — refuses to deploy unless this is a clean Supabase
-- database ready for Stage 2A-1. Raising here aborts the transaction.
--
-- The only pre-existing object tolerated in schema public is Supabase's
-- verified auto-RLS helper public.rls_auto_enable() (see
-- supabase/deploy/known/README.md), and only if every property below matches.
-- It is never modified: its fingerprint is re-checked before COMMIT.
-- ===================================================================
do $preflight$
declare
  v_problems text[] := '{}';
  v_role text;
  v_existing text;
  -- Verified body, copied by scripts/build-deploy.sh from
  -- deploy/known/rls_auto_enable.verified.sql (reference data, never executed).
  v_expected_body constant text := $verified_rls_auto_enable$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$verified_rls_auto_enable$;
  v_overloads integer;
  v_fn record;
  v_issues text[] := '{}';
  v_allowed oid;
  v_fingerprint text := '';
  v_body_md5 text := '';
begin
  if current_setting('server_version_num')::int < 150000 then
    v_problems := array_append(v_problems, 'PostgreSQL 15 or newer is required'::text);
  end if;

  -- Supabase prerequisites the migrations rely on.
  if to_regclass('auth.users') is null then
    v_problems := array_append(v_problems, 'auth.users is missing (is this a Supabase database?)'::text);
  end if;
  if to_regprocedure('auth.uid()') is null then
    v_problems := array_append(v_problems, 'auth.uid() is missing'::text);
  end if;
  if to_regprocedure('auth.jwt()') is null then
    v_problems := array_append(v_problems, 'auth.jwt() is missing'::text);
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = v_role) then
      v_problems := v_problems || format('database role %s is missing', v_role);
    end if;
  end loop;

  -- Already installed (any Stage 2A-1 object present).
  if to_regclass('public.cases') is not null or to_regclass('public.founders') is not null
     or to_regtype('public.workflow_state') is not null or to_regnamespace('private') is not null then
    raise exception 'DEPLOYMENT REFUSED: Stage 2A-1 appears to be already installed (found public.cases, public.founders, public.workflow_state or schema private). Nothing was changed.';
  end if;

  -- Verified pre-existing Supabase helper: public.rls_auto_enable().
  select count(*) into v_overloads
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rls_auto_enable';

  if v_overloads > 0 then
    if v_overloads <> 1 then
      v_issues := v_issues || format('%s overloads exist (expected exactly one)', v_overloads);
    end if;
    select p.oid, p.prokind, p.pronargs, p.prorettype, l.lanname, pg_get_userbyid(p.proowner) as owner,
           p.prosecdef, p.proconfig, p.prosrc, p.proacl
      into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
    order by p.pronargs, p.oid
    limit 1;

    if v_fn.prokind <> 'f' then v_issues := array_append(v_issues, 'not a plain function'::text); end if;
    if v_fn.pronargs <> 0 then v_issues := array_append(v_issues, 'takes arguments'::text); end if;
    if v_fn.prorettype <> 'event_trigger'::regtype then
      v_issues := v_issues || format('returns %s, not event_trigger', v_fn.prorettype::regtype);
    end if;
    if v_fn.lanname <> 'plpgsql' then v_issues := v_issues || format('language %s, not plpgsql', v_fn.lanname); end if;
    if v_fn.owner <> 'postgres' then v_issues := v_issues || format('owned by %s, not postgres', v_fn.owner); end if;
    if not v_fn.prosecdef then v_issues := array_append(v_issues, 'not SECURITY DEFINER'::text); end if;
    if v_fn.proconfig is distinct from array['search_path=pg_catalog'] then
      v_issues := v_issues || format('settings %s, expected exactly {search_path=pg_catalog}', coalesce(v_fn.proconfig::text, '(none)'));
    end if;
    if btrim(regexp_replace(v_fn.prosrc, '\s+', ' ', 'g')) <> btrim(regexp_replace(v_expected_body, '\s+', ' ', 'g')) then
      v_issues := array_append(v_issues, 'function body differs from the verified definition'::text);
    end if;
    if (select count(*) from pg_event_trigger et where et.evtfoid = v_fn.oid) <> 1
       or not exists (select 1 from pg_event_trigger et
                      where et.evtfoid = v_fn.oid and et.evtname = 'ensure_rls' and et.evtevent = 'ddl_command_end') then
      v_issues := array_append(v_issues, 'not called by exactly one event trigger named ensure_rls on ddl_command_end'::text);
    end if;
    if exists (select 1 from pg_trigger t where t.tgfoid = v_fn.oid) then
      v_issues := array_append(v_issues, 'called by a table trigger'::text);
    end if;
    if exists (select 1 from pg_depend d where d.refclassid = 'pg_proc'::regclass and d.refobjid = v_fn.oid
               and d.classid <> 'pg_event_trigger'::regclass) then
      v_issues := array_append(v_issues, 'other objects depend on it'::text);
    end if;

    if array_length(v_issues, 1) > 0 then
      v_problems := v_problems || format('public.rls_auto_enable() does not match the verified Supabase definition (%s)',
                                         array_to_string(v_issues, '; '));
    else
      v_allowed := v_fn.oid;
      -- Fingerprint of everything the deployment must leave untouched.
      select md5(concat_ws('|', p.prosrc, coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), 'NULL'), pg_get_userbyid(p.proowner), p.prosecdef::text,
                           coalesce(p.proconfig::text, 'NULL'), et.evtname, et.evtevent, et.evtenabled::text,
                           coalesce(et.evttags::text, 'NULL'), pg_get_userbyid(et.evtowner)))
        into v_fingerprint
      from pg_proc p join pg_event_trigger et on et.evtfoid = p.oid
      where p.oid = v_fn.oid;
      v_body_md5 := md5(btrim(regexp_replace(v_fn.prosrc, '\s+', ' ', 'g')));
      raise notice 'Verified pre-existing Supabase function public.rls_auto_enable() (event trigger ensure_rls): left unchanged';
    end if;
  end if;
  -- Transaction-local: read by the post-install self-check and the audit entry.
  perform set_config('rre.rls_auto_enable_fingerprint', coalesce(v_fingerprint, ''), true);
  perform set_config('rre.rls_auto_enable_body_md5', coalesce(v_body_md5, ''), true);

  -- The migrations tighten privileges on everything in schema public, so they
  -- must not run over unrelated objects. Extension-owned objects and the
  -- verified helper above are ignored; everything else is refused.
  select string_agg(format('%s %s', kind, name), ', ' order by name) into v_existing
  from (
    select case c.relkind when 'r' then 'table' when 'v' then 'view' when 'm' then 'materialized view'
                          when 'p' then 'table' when 'f' then 'foreign table' else 'sequence' end as kind,
           c.relname::text as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
    union all
    select 'function', p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid is distinct from v_allowed
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    union all
    select 'type', t.typname::text
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype in ('e', 'd', 'r', 'm')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
  ) o;
  if v_existing is not null then
    v_problems := v_problems || format('schema public is not empty: %s', v_existing);
  end if;

  if array_length(v_problems, 1) > 0 then
    raise exception 'DEPLOYMENT REFUSED: %. Nothing was changed.', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Preflight passed: clean Supabase database, deploying Stage 2A-1';
end
$preflight$;

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261009120000_stage2a1_schema.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-1 — core schema.
-- Tables, types and integrity constraints only. Access control lives in the
-- next migration; state changes happen only through guarded functions.
--
-- Conventions
--   * Every business-owned row carries business_id. Child tables reference
--     cases(id, business_id) with a composite foreign key so a row can never
--     point at a case belonging to a different business.
--   * Workflow state names are kept from Stage 1 (src/domain/types.ts);
--     "ADMIN" in a state name means the founder.

-- ---------------------------------------------------------------- types

create type public.workflow_state as enum (
  'DRAFT', 'SUBMITTED', 'ANALYZING', 'AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED',
  'WAITING_FOR_PROSPECT', 'PROSPECT_REPLIED', 'REANALYZING', 'PAUSED', 'WON', 'LOST', 'DISQUALIFIED'
);
create type public.classification as enum ('GREEN', 'YELLOW', 'RED');
create type public.conversation_source as enum ('SCREENSHOTS', 'TEXT');
create type public.message_kind as enum ('PASTED_CONVERSATION', 'RECOVERY_SENT', 'PROSPECT_RESPONSE');
create type public.analysis_status as enum ('PENDING', 'COMPLETE', 'INSUFFICIENT_EVIDENCE', 'ERROR');
create type public.approval_type as enum ('UNCHANGED', 'EDITED', 'MARKED_RED');
create type public.review_reason as enum ('NEW_SUBMISSION', 'PROSPECT_RESPONSE', 'REANALYSIS', 'CONTACT_RESTRICTION');
create type public.restriction_kind as enum ('EXPLICIT_OPT_OUT', 'PROHIBITED_CONTACT', 'OTHER');
create type public.restriction_source as enum ('AI_DETECTED', 'FOUNDER', 'CLIENT');
create type public.restriction_status as enum ('ACTIVE', 'DISMISSED_AS_MISREAD');

-- ---------------------------------------------------------------- identity

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  industry text not null default '' check (char_length(industry) <= 120),
  currency text not null default 'NGN' check (currency ~ '^[A-Z]{3}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- A client user belongs to exactly one business.
create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

-- Founder role. No API write path exists (see security migration); rows are
-- added only by a database administrator.
create table public.founders (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- cases

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  reference text not null check (char_length(btrim(reference)) between 1 and 40),
  product_service text not null check (char_length(btrim(product_service)) between 1 and 200),
  lead_source text not null check (lead_source in (
    'Facebook / Instagram Ads', 'Google', 'Referral', 'Website', 'Organic Social', 'Walk-in', 'Unknown', 'Other')),
  estimated_value numeric(14, 2) check (estimated_value is null or estimated_value >= 0),
  last_interaction_date date,
  client_context text check (client_context is null or char_length(client_context) <= 2000),
  conversation_source public.conversation_source not null,
  workflow_state public.workflow_state not null default 'DRAFT',
  -- Incremented whenever case evidence changes; analyses record the version they used.
  evidence_version integer not null default 0 check (evidence_version >= 0),
  review_reason public.review_reason,
  queued_at timestamptz,
  idempotency_key uuid not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (business_id, idempotency_key),
  unique (id, business_id)
);
create index cases_business_idx on public.cases (business_id, created_at desc);
create index cases_queue_idx on public.cases (queued_at) where queued_at is not null;

create table public.case_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  kind public.message_kind not null,
  body text not null check (char_length(btrim(body)) between 1 and 20000),
  attempt integer check (attempt is null or attempt >= 1),
  approval_id uuid,
  sent_exactly boolean,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  check (kind <> 'RECOVERY_SENT' or (attempt is not null and approval_id is not null and sent_exactly is not null)),
  check (kind = 'PASTED_CONVERSATION' or char_length(body) <= 5000)
);
create index case_messages_case_idx on public.case_messages (case_id, created_at);

-- Screenshot metadata. Storage wiring (bucket, uploads, content checks) is Stage 2A-2.
create table public.case_screenshots (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  position integer not null check (position between 1 and 10),
  storage_path text not null unique check (char_length(storage_path) <= 300),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  unique (case_id, position)
);

-- ---------------------------------------------------------------- private intelligence (founder only)

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  version integer not null check (version >= 1),
  status public.analysis_status not null default 'PENDING',
  evidence_version integer not null,
  evidence_manifest jsonb not null,
  prior_state public.workflow_state not null,
  model text check (model is null or char_length(model) <= 100),
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 50),
  output jsonb,
  ai_classification public.classification,
  ai_proposed_message text check (ai_proposed_message is null or char_length(ai_proposed_message) <= 2000),
  error text check (error is null or char_length(error) <= 2000),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  estimated_cost_usd numeric(10, 4) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  unique (case_id, version),
  -- A message is never proposed alongside a RED classification.
  check (ai_classification is distinct from 'RED' or ai_proposed_message is null)
);
-- At most one analysis in flight per case (the analysis lock).
create unique index analyses_one_pending_per_case on public.analyses (case_id) where status = 'PENDING';

-- Immutable approval history.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  analysis_id uuid references public.analyses (id),
  founder_id uuid references auth.users (id) on delete set null,
  evidence_version integer not null,
  approval_type public.approval_type not null,
  ai_classification public.classification,
  classification public.classification not null,
  ai_proposed_message text,
  approved_message text check (approved_message is null or char_length(btrim(approved_message)) between 1 and 2000),
  deal_situation text not null check (char_length(btrim(deal_situation)) between 1 and 500),
  next_action text not null check (char_length(btrim(next_action)) between 1 and 300),
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  -- RED never carries a message; GREEN/YELLOW always do.
  check ((classification = 'RED') = (approved_message is null)),
  check (approval_type <> 'MARKED_RED' or classification = 'RED'),
  -- Only a RED stop-contact decision may be made without an analysis.
  check (analysis_id is not null or classification = 'RED')
);
create index approvals_case_idx on public.approvals (case_id, created_at);

-- The latest approved, client-safe recommendation per case.
create table public.client_recommendations (
  case_id uuid primary key,
  business_id uuid not null,
  approval_id uuid not null unique references public.approvals (id),
  classification public.classification not null,
  deal_situation text not null,
  next_action text not null,
  approved_message text,
  published_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  check ((classification = 'RED') = (approved_message is null))
);

create table public.contact_restrictions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  kind public.restriction_kind not null,
  source public.restriction_source not null,
  status public.restriction_status not null default 'ACTIVE',
  note text check (note is null or char_length(note) <= 1000),
  evidence jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  dismissed_by uuid references auth.users (id) on delete set null,
  dismissed_reason text,
  dismissed_at timestamptz,
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  -- Only AI-detected restrictions can ever be dismissed, and only with a reason.
  check (status = 'ACTIVE' or (source = 'AI_DETECTED' and char_length(btrim(coalesce(dismissed_reason, ''))) >= 20
                               and dismissed_by is not null and dismissed_at is not null))
);
create index contact_restrictions_case_idx on public.contact_restrictions (case_id) where status = 'ACTIVE';

create table public.founder_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  author uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade
);

-- ---------------------------------------------------------------- outcomes and audit

create table public.outcomes (
  case_id uuid primary key,
  business_id uuid not null,
  state public.workflow_state not null check (state in ('WON', 'LOST', 'PAUSED', 'DISQUALIFIED')),
  deal_value numeric(14, 2) check (deal_value is null or deal_value > 0),
  amount_paid numeric(14, 2) check (amount_paid is null or amount_paid > 0),
  payment_date date,
  note text check (note is null or char_length(note) <= 1000),
  recorded_by uuid references auth.users (id) on delete set null,
  recorded_by_role text not null check (recorded_by_role in ('CLIENT', 'FOUNDER')),
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  check (state <> 'WON' or (amount_paid is not null and payment_date is not null))
);

-- Append-only. client_label marks entries a client may see in their case history.
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_role text not null check (actor_role in ('CLIENT', 'FOUNDER', 'SERVICE', 'SYSTEM')),
  action text not null,
  case_id uuid,
  business_id uuid,
  client_label text,
  details jsonb not null default '{}'::jsonb
);
create index audit_log_case_idx on public.audit_log (case_id, at);

-- ---------------------------------------------------------------- immutability and housekeeping

create function public.tg_forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'IMMUTABLE: % rows cannot be changed or deleted', tg_table_name using errcode = '42501';
end $$;

create trigger approvals_immutable before update or delete on public.approvals
  for each row execute function public.tg_forbid_change();
create trigger approvals_no_truncate before truncate on public.approvals
  for each statement execute function public.tg_forbid_change();
create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function public.tg_forbid_change();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.tg_forbid_change();

create function public.tg_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger cases_touch before update on public.cases
  for each row execute function public.tg_touch_updated_at();
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261009120000_stage2a1_schema.sql <<<<<<<<<<<<<<<<<<<<

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261009120100_stage2a1_security.sql >>>>>>>>>>>>>>>>>>>>
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
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261009120100_stage2a1_security.sql <<<<<<<<<<<<<<<<<<<<

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261009120200_stage2a1_functions.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-1 — guarded state-changing functions.
--
-- All are SECURITY DEFINER with an empty search_path. Each checks the caller
-- (client membership or founder role), the case's current state and its
-- inputs, takes a row lock on the case, and writes the audit log in the same
-- transaction. Error messages start with a stable code:
--   FORBIDDEN (42501), NOT_FOUND (P0002), INVALID_STATE, VALIDATION,
--   STALE_ANALYSIS, CONTACT_RESTRICTED, RATE_LIMITED (P0001).

-- ---------------------------------------------------------------- internal helpers

create function private.fail(p_code text, p_detail text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%: %', p_code, p_detail using errcode = case p_code
    when 'FORBIDDEN' then '42501' when 'NOT_FOUND' then 'P0002' else 'P0001' end;
end $$;

create function private.require_founder() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.is_founder() then
    perform private.fail('FORBIDDEN', 'founder access required');
  end if;
  return (select auth.uid());
end $$;

-- Locks and returns a case the calling client's business owns. Cases of other
-- businesses are reported as NOT_FOUND so their existence is not revealed.
create function private.client_case_for_update(p_case_id uuid) returns public.cases
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases;
begin
  if (select auth.uid()) is null then
    perform private.fail('FORBIDDEN', 'sign-in required');
  end if;
  select * into v_case from public.cases where id = p_case_id for update;
  if not found or not private.is_member(v_case.business_id) then
    perform private.fail('NOT_FOUND', 'case not found');
  end if;
  return v_case;
end $$;

create function private.founder_case_for_update(p_case_id uuid) returns public.cases
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases;
begin
  perform private.require_founder();
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'case not found');
  end if;
  return v_case;
end $$;

create function private.has_active_restriction(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.contact_restrictions r where r.case_id = p_case_id and r.status = 'ACTIVE');
$$;

create function private.is_terminal(p_state public.workflow_state) returns boolean
language sql immutable set search_path = '' as $$
  select p_state in ('PAUSED', 'WON', 'LOST', 'DISQUALIFIED');
$$;

-- Adds a contact restriction. A restriction is new evidence: the evidence
-- version increases (so earlier analyses become stale) and a case whose
-- recommendation is with the client returns to founder review, which hides
-- the message from the client.
create function private.add_restriction(
  p_case public.cases, p_kind public.restriction_kind, p_source public.restriction_source,
  p_note text, p_evidence jsonb, p_actor_role text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into public.contact_restrictions (case_id, business_id, kind, source, note, evidence, created_by)
  values (p_case.id, p_case.business_id, p_kind, p_source, nullif(btrim(coalesce(p_note, '')), ''), p_evidence, (select auth.uid()))
  returning id into v_id;

  update public.cases set
    evidence_version = evidence_version + 1,
    workflow_state = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT')
                          then 'REANALYZING'::public.workflow_state else workflow_state end,
    review_reason = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT')
                         then 'CONTACT_RESTRICTION'::public.review_reason else review_reason end,
    queued_at = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT')
                     then now() else queued_at end
  where id = p_case.id;

  perform private.audit('RESTRICTION_ADDED', p_case.id, p_case.business_id, p_actor_role,
    case when p_actor_role = 'CLIENT' then 'Opt-out recorded — under review' end,
    jsonb_build_object('restriction_id', v_id, 'kind', p_kind, 'source', p_source));
  return v_id;
end $$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;
grant execute on function private.is_founder() to authenticated;
grant execute on function private.is_member(uuid) to authenticated;

-- ---------------------------------------------------------------- identity

create function public.whoami() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_business public.businesses;
begin
  if v_uid is null then
    perform private.fail('FORBIDDEN', 'sign-in required');
  end if;
  if private.is_founder() then
    return jsonb_build_object('user_id', v_uid, 'role', 'FOUNDER');
  end if;
  select b.* into v_business from public.businesses b where b.id = private.my_business_id();
  if found then
    return jsonb_build_object('user_id', v_uid, 'role', 'CLIENT', 'business_id', v_business.id,
                              'business_name', v_business.name, 'currency', v_business.currency);
  end if;
  -- Invited but not yet assigned: no access to anything.
  return jsonb_build_object('user_id', v_uid, 'role', 'NONE');
end $$;

-- ---------------------------------------------------------------- founder: businesses and members

create function public.founder_create_business(p_name text, p_industry text default '', p_currency text default 'NGN')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_founder();
  insert into public.businesses (name, industry, currency, created_by)
  values (btrim(p_name), btrim(coalesce(p_industry, '')), upper(btrim(coalesce(p_currency, 'NGN'))), (select auth.uid()))
  returning id into v_id;
  perform private.audit('BUSINESS_CREATED', null, v_id, 'FOUNDER');
  return v_id;
end $$;

-- Links an invited user (created via the Supabase dashboard invite) to a business.
create function public.founder_add_member(p_business_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_founder();
  if not exists (select 1 from public.businesses where id = p_business_id) then
    perform private.fail('NOT_FOUND', 'business not found');
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    perform private.fail('NOT_FOUND', 'user not found');
  end if;
  if exists (select 1 from public.founders where user_id = p_user_id) then
    perform private.fail('VALIDATION', 'a founder cannot be a client member');
  end if;
  if exists (select 1 from public.business_members where user_id = p_user_id) then
    perform private.fail('VALIDATION', 'user already belongs to a business');
  end if;
  insert into public.business_members (business_id, user_id, created_by) values (p_business_id, p_user_id, (select auth.uid()));
  perform private.audit('MEMBER_ADDED', null, p_business_id, 'FOUNDER', null, jsonb_build_object('user_id', p_user_id));
end $$;

-- ---------------------------------------------------------------- client: cases

create function public.client_create_case(
  p_idempotency_key uuid,
  p_reference text,
  p_product_service text,
  p_lead_source text,
  p_conversation_source public.conversation_source,
  p_conversation_text text default null,
  p_estimated_value numeric default null,
  p_last_interaction_date date default null,
  p_client_context text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_business uuid;
  v_id uuid;
  v_text text := nullif(btrim(coalesce(p_conversation_text, '')), '');
begin
  if (select auth.uid()) is null then
    perform private.fail('FORBIDDEN', 'sign-in required');
  end if;
  v_business := private.my_business_id();
  if v_business is null then
    perform private.fail('FORBIDDEN', 'client access required');
  end if;
  if p_idempotency_key is null then
    perform private.fail('VALIDATION', 'idempotency key required');
  end if;

  select id into v_id from public.cases where business_id = v_business and idempotency_key = p_idempotency_key;
  if found then
    return v_id; -- retry of an earlier request: same case, no duplicate
  end if;

  if (select count(*) from public.cases where business_id = v_business and created_at > now() - interval '1 day') >= 20 then
    perform private.fail('RATE_LIMITED', 'daily case limit reached');
  end if;
  if p_conversation_source = 'TEXT' and char_length(coalesce(v_text, '')) < 20 then
    perform private.fail('VALIDATION', 'pasted conversation is too short');
  end if;

  begin
    insert into public.cases (business_id, reference, product_service, lead_source, estimated_value,
                              last_interaction_date, client_context, conversation_source, idempotency_key, created_by)
    values (v_business, btrim(p_reference), btrim(p_product_service), p_lead_source, p_estimated_value,
            p_last_interaction_date, nullif(btrim(coalesce(p_client_context, '')), ''), p_conversation_source,
            p_idempotency_key, (select auth.uid()))
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.cases where business_id = v_business and idempotency_key = p_idempotency_key;
    return v_id;
  end;

  if p_conversation_source = 'TEXT' then
    insert into public.case_messages (case_id, business_id, kind, body, created_by)
    values (v_id, v_business, 'PASTED_CONVERSATION', v_text, (select auth.uid()));
  end if;

  perform private.audit('CASE_CREATED', v_id, v_business, 'CLIENT');
  return v_id;
end $$;

create function public.client_submit_case(p_case_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
  v_shots integer;
begin
  if v_case.workflow_state <> 'DRAFT' then
    perform private.fail('INVALID_STATE', 'only draft cases can be submitted');
  end if;
  if v_case.conversation_source = 'TEXT' then
    if not exists (select 1 from public.case_messages where case_id = v_case.id and kind = 'PASTED_CONVERSATION') then
      perform private.fail('VALIDATION', 'conversation missing');
    end if;
  else
    select count(*) into v_shots from public.case_screenshots where case_id = v_case.id;
    if v_shots < 1 or v_shots > 10 then
      perform private.fail('VALIDATION', 'between 1 and 10 screenshots are required');
    end if;
  end if;

  update public.cases set workflow_state = 'SUBMITTED', evidence_version = evidence_version + 1,
    review_reason = 'NEW_SUBMISSION', queued_at = now()
  where id = v_case.id;
  perform private.audit('CASE_SUBMITTED', v_case.id, v_case.business_id, 'CLIENT', 'Case submitted');
end $$;

create function public.client_record_sent(p_case_id uuid, p_actual_text text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
  v_rec public.client_recommendations;
  v_actual text := nullif(btrim(coalesce(p_actual_text, '')), '');
  v_attempt integer;
begin
  if v_case.workflow_state <> 'CLIENT_ACTION_REQUIRED' then
    perform private.fail('INVALID_STATE', 'no recommendation is awaiting action');
  end if;
  select * into v_rec from public.client_recommendations where case_id = v_case.id;
  if not found or v_rec.classification = 'RED' or v_rec.approved_message is null then
    perform private.fail('INVALID_STATE', 'there is no approved message to send');
  end if;
  if private.has_active_restriction(v_case.id) then
    perform private.fail('CONTACT_RESTRICTED', 'contact with this prospect is restricted');
  end if;
  if p_actual_text is not null and v_actual is null then
    perform private.fail('VALIDATION', 'paste the exact message you sent');
  end if;

  select count(*) + 1 into v_attempt from public.case_messages where case_id = v_case.id and kind = 'RECOVERY_SENT';
  insert into public.case_messages (case_id, business_id, kind, body, attempt, approval_id, sent_exactly, created_by)
  values (v_case.id, v_case.business_id, 'RECOVERY_SENT', coalesce(v_actual, v_rec.approved_message), v_attempt,
          v_rec.approval_id, v_actual is null or v_actual = v_rec.approved_message, (select auth.uid()));
  update public.cases set workflow_state = 'WAITING_FOR_PROSPECT', evidence_version = evidence_version + 1
  where id = v_case.id;
  perform private.audit('MESSAGE_SENT', v_case.id, v_case.business_id, 'CLIENT', format('Message sent (attempt %s)', v_attempt),
    jsonb_build_object('attempt', v_attempt, 'sent_exactly', v_actual is null or v_actual = v_rec.approved_message));
end $$;

create function public.client_add_response(p_case_id uuid, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
begin
  if v_case.workflow_state <> 'WAITING_FOR_PROSPECT' then
    perform private.fail('INVALID_STATE', 'responses can be added only while waiting for the prospect');
  end if;
  if v_text is null or char_length(v_text) > 5000 then
    perform private.fail('VALIDATION', 'response must be 1 to 5000 characters');
  end if;
  if (select count(*) from public.case_messages where case_id = v_case.id and kind = 'PROSPECT_RESPONSE'
        and created_at > now() - interval '1 day') >= 10 then
    perform private.fail('RATE_LIMITED', 'daily response limit reached for this case');
  end if;

  insert into public.case_messages (case_id, business_id, kind, body, created_by)
  values (v_case.id, v_case.business_id, 'PROSPECT_RESPONSE', v_text, (select auth.uid()));
  update public.cases set workflow_state = 'PROSPECT_REPLIED', evidence_version = evidence_version + 1,
    review_reason = 'PROSPECT_RESPONSE', queued_at = now()
  where id = v_case.id;
  perform private.audit('RESPONSE_ADDED', v_case.id, v_case.business_id, 'CLIENT', 'Prospect response added — under review');
end $$;

create function public.client_report_opt_out(p_case_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
begin
  if private.is_terminal(v_case.workflow_state) then
    perform private.fail('INVALID_STATE', 'case is closed');
  end if;
  perform private.add_restriction(v_case, 'EXPLICIT_OPT_OUT', 'CLIENT', p_note, null, 'CLIENT');
end $$;

create function public.client_record_outcome(
  p_case_id uuid, p_state public.workflow_state,
  p_deal_value numeric default null, p_amount_paid numeric default null,
  p_payment_date date default null, p_note text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
begin
  if v_case.workflow_state not in ('CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT') then
    perform private.fail('INVALID_STATE', 'an outcome can be recorded only after a recommendation');
  end if;
  if p_state not in ('WON', 'LOST', 'PAUSED', 'DISQUALIFIED') then
    perform private.fail('VALIDATION', 'invalid outcome');
  end if;
  if p_state = 'WON' and (coalesce(p_amount_paid, 0) <= 0 or p_payment_date is null) then
    perform private.fail('VALIDATION', 'a won deal requires the amount paid and payment date');
  end if;

  insert into public.outcomes (case_id, business_id, state, deal_value, amount_paid, payment_date, note, recorded_by, recorded_by_role)
  values (v_case.id, v_case.business_id, p_state,
          case when p_state = 'WON' then p_deal_value end, case when p_state = 'WON' then p_amount_paid end,
          case when p_state = 'WON' then p_payment_date end, nullif(btrim(coalesce(p_note, '')), ''),
          (select auth.uid()), 'CLIENT');
  update public.cases set workflow_state = p_state, closed_at = now(), queued_at = null, review_reason = null
  where id = v_case.id;
  perform private.audit('OUTCOME_RECORDED', v_case.id, v_case.business_id, 'CLIENT',
    case p_state when 'WON' then 'Deal won — recovered' when 'LOST' then 'Closed — lost'
                 when 'PAUSED' then 'Case paused' else 'Disqualified' end,
    jsonb_build_object('state', p_state));
end $$;

-- ---------------------------------------------------------------- client: approved-only reads

-- The client-safe projection (server-side equivalent of src/domain/clientView.ts).
-- Recommendation fields appear only while the case awaits client action; RED
-- never carries a message. No analysis, notes, restrictions or AI proposals.
create function public.client_list_cases()
returns table (
  id uuid, reference text, product_service text, status text,
  classification public.classification, deal_situation text, next_action text, approved_message text,
  recovery_attempts integer, last_sent_message text, responses_added integer,
  won_deal_value numeric, won_amount_paid numeric, won_payment_date date,
  closed_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select
    c.id, c.reference, c.product_service,
    case
      when c.workflow_state = 'DRAFT' then 'DRAFT'
      when c.workflow_state in ('SUBMITTED', 'ANALYZING', 'AWAITING_ADMIN_REVIEW', 'PROSPECT_REPLIED', 'REANALYZING') then 'UNDER_REVIEW'
      when c.workflow_state = 'CLIENT_ACTION_REQUIRED' then 'ACTION_REQUIRED'
      when c.workflow_state = 'WAITING_FOR_PROSPECT' then 'WAITING'
      else c.workflow_state::text
    end,
    case when c.workflow_state = 'CLIENT_ACTION_REQUIRED' then r.classification end,
    case when c.workflow_state = 'CLIENT_ACTION_REQUIRED' then r.deal_situation end,
    case when c.workflow_state = 'CLIENT_ACTION_REQUIRED' then r.next_action end,
    case when c.workflow_state = 'CLIENT_ACTION_REQUIRED' and r.classification <> 'RED' then r.approved_message end,
    (select count(*)::integer from public.case_messages m where m.case_id = c.id and m.kind = 'RECOVERY_SENT'),
    (select m.body from public.case_messages m where m.case_id = c.id and m.kind = 'RECOVERY_SENT'
      order by m.attempt desc limit 1),
    (select count(*)::integer from public.case_messages m where m.case_id = c.id and m.kind = 'PROSPECT_RESPONSE'),
    case when o.state = 'WON' then o.deal_value end,
    case when o.state = 'WON' then o.amount_paid end,
    case when o.state = 'WON' then o.payment_date end,
    o.created_at,
    c.updated_at
  from public.cases c
  left join public.client_recommendations r on r.case_id = c.id
  left join public.outcomes o on o.case_id = c.id
  where c.business_id = (select private.my_business_id())
  order by c.created_at desc;
$$;

create function public.client_get_case(p_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  select to_jsonb(v) || jsonb_build_object('history', coalesce((
      select jsonb_agg(jsonb_build_object('at', a.at, 'label', a.client_label) order by a.at, a.id)
      from public.audit_log a where a.case_id = v.id and a.client_label is not null), '[]'::jsonb))
    into v_result
  from public.client_list_cases() v
  where v.id = p_case_id;
  if v_result is null then
    perform private.fail('NOT_FOUND', 'case not found');
  end if;
  return v_result;
end $$;

-- ---------------------------------------------------------------- founder: analysis lifecycle

-- Opens an analysis for the case's current evidence and locks the case into
-- ANALYZING. Called by the founder (via the 2A-3 Edge Function) — never automatic.
create function public.founder_start_analysis(p_case_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_version integer;
  v_manifest jsonb;
  v_id uuid;
begin
  if v_case.workflow_state not in ('SUBMITTED', 'PROSPECT_REPLIED', 'REANALYZING') then
    perform private.fail('INVALID_STATE', 'case is not waiting for analysis');
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.analyses where case_id = v_case.id;
  v_manifest := jsonb_build_object(
    'evidence_version', v_case.evidence_version,
    'screenshots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'sha256', s.sha256)
                                              order by s.position)
                             from public.case_screenshots s where s.case_id = v_case.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'created_at', m.created_at)
                                           order by m.created_at, m.id)
                          from public.case_messages m where m.case_id = v_case.id), '[]'::jsonb),
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'source', r.source, 'status', r.status)
                                               order by r.created_at)
                              from public.contact_restrictions r where r.case_id = v_case.id), '[]'::jsonb));

  insert into public.analyses (case_id, business_id, version, evidence_version, evidence_manifest, prior_state, requested_by)
  values (v_case.id, v_case.business_id, v_version, v_case.evidence_version, v_manifest, v_case.workflow_state, (select auth.uid()))
  returning id into v_id;
  update public.cases set workflow_state = 'ANALYZING' where id = v_case.id;
  perform private.audit('ANALYSIS_STARTED', v_case.id, v_case.business_id, 'FOUNDER', null,
    jsonb_build_object('analysis_id', v_id, 'version', v_version, 'evidence_version', v_case.evidence_version));
  return v_id;
end $$;

-- Records the result of an analysis. Server-side only (service role, Edge
-- Function). A failed or stale analysis returns the case to its prior state
-- and is never shown to anyone but the founder.
create function public.internal_complete_analysis(
  p_analysis_id uuid,
  p_status public.analysis_status,
  p_model text default null,
  p_prompt_version text default null,
  p_output jsonb default null,
  p_ai_classification public.classification default null,
  p_ai_proposed_message text default null,
  p_detected_restrictions jsonb default '[]'::jsonb,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_estimated_cost_usd numeric default null,
  p_error text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_analysis public.analyses;
  v_case public.cases;
  v_restrictions jsonb := coalesce(p_detected_restrictions, '[]'::jsonb);
  v_message text;
  v_item jsonb;
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
  select * into v_analysis from public.analyses where id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found');
  end if;
  if v_analysis.status <> 'PENDING' then
    perform private.fail('INVALID_STATE', 'analysis already completed');
  end if;
  if p_status = 'PENDING' then
    perform private.fail('VALIDATION', 'a completed analysis cannot be PENDING');
  end if;
  if jsonb_typeof(v_restrictions) <> 'array' then
    perform private.fail('VALIDATION', 'detected restrictions must be an array');
  end if;
  select * into v_case from public.cases where id = v_analysis.case_id for update;

  if p_status = 'ERROR' or v_case.evidence_version <> v_analysis.evidence_version or v_case.workflow_state <> 'ANALYZING' then
    update public.analyses set status = 'ERROR',
      error = left(coalesce(case when p_status = 'ERROR' then p_error end, 'STALE: evidence changed during analysis'), 2000),
      model = p_model, prompt_version = p_prompt_version, input_tokens = p_input_tokens,
      output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
    where id = v_analysis.id;
    update public.cases set workflow_state = v_analysis.prior_state
    where id = v_case.id and workflow_state = 'ANALYZING';
    perform private.audit('ANALYSIS_FAILED', v_case.id, v_case.business_id, 'SERVICE', null,
      jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version));
    return;
  end if;

  -- Invariant: no proposed message for RED or when any restriction is detected.
  v_message := case when p_ai_classification = 'RED' or jsonb_array_length(v_restrictions) > 0 then null
                    else nullif(btrim(coalesce(p_ai_proposed_message, '')), '') end;

  update public.analyses set status = p_status, model = p_model, prompt_version = p_prompt_version, output = p_output,
    ai_classification = p_ai_classification, ai_proposed_message = v_message, input_tokens = p_input_tokens,
    output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
  where id = v_analysis.id;

  for v_item in select * from jsonb_array_elements(v_restrictions) loop
    insert into public.contact_restrictions (case_id, business_id, kind, source, note, evidence)
    values (v_case.id, v_case.business_id, (v_item ->> 'kind')::public.restriction_kind, 'AI_DETECTED',
            left(v_item ->> 'note', 1000), v_item -> 'evidence');
  end loop;

  update public.cases set workflow_state = 'AWAITING_ADMIN_REVIEW' where id = v_case.id;
  perform private.audit('ANALYSIS_COMPLETED', v_case.id, v_case.business_id, 'SERVICE', null,
    jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version, 'status', p_status,
                       'detected_restrictions', jsonb_array_length(v_restrictions)));
end $$;

-- Releases a stuck analysis (e.g. the Edge Function crashed).
create function public.founder_abandon_analysis(p_analysis_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_analysis public.analyses;
begin
  perform private.require_founder();
  select * into v_analysis from public.analyses where id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found');
  end if;
  if v_analysis.status <> 'PENDING' then
    perform private.fail('INVALID_STATE', 'analysis is not in progress');
  end if;
  update public.analyses set status = 'ERROR', error = 'Abandoned by founder', completed_at = now() where id = v_analysis.id;
  update public.cases set workflow_state = v_analysis.prior_state where id = v_analysis.case_id and workflow_state = 'ANALYZING';
  perform private.audit('ANALYSIS_ABANDONED', v_analysis.case_id, v_analysis.business_id, 'FOUNDER', null,
    jsonb_build_object('analysis_id', v_analysis.id));
end $$;

create function public.founder_request_reanalysis(p_case_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
begin
  if v_case.workflow_state <> 'AWAITING_ADMIN_REVIEW' then
    perform private.fail('INVALID_STATE', 'reanalysis can be requested only during review');
  end if;
  update public.cases set workflow_state = 'REANALYZING', review_reason = coalesce(review_reason, 'REANALYSIS')
  where id = v_case.id;
  perform private.audit('REANALYSIS_REQUESTED', v_case.id, v_case.business_id, 'FOUNDER');
end $$;

-- ---------------------------------------------------------------- founder: approval

create function public.founder_approve(
  p_case_id uuid,
  p_analysis_id uuid,
  p_expected_evidence_version integer,
  p_classification public.classification,
  p_deal_situation text,
  p_next_action text,
  p_approved_message text,
  p_approval_type public.approval_type
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_analysis public.analyses;
  v_latest integer;
  v_message text := nullif(btrim(coalesce(p_approved_message, '')), '');
  v_id uuid;
begin
  if v_case.workflow_state <> 'AWAITING_ADMIN_REVIEW' then
    perform private.fail('INVALID_STATE', 'case is not awaiting review');
  end if;
  select * into v_analysis from public.analyses where id = p_analysis_id and case_id = v_case.id;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found for this case');
  end if;
  select max(version) into v_latest from public.analyses where case_id = v_case.id and status <> 'ERROR';
  if v_analysis.status not in ('COMPLETE', 'INSUFFICIENT_EVIDENCE') or v_analysis.version <> v_latest
     or v_analysis.evidence_version <> v_case.evidence_version
     or p_expected_evidence_version is distinct from v_case.evidence_version then
    perform private.fail('STALE_ANALYSIS', 'evidence or analysis changed; review the latest analysis');
  end if;
  if p_classification is null then
    perform private.fail('VALIDATION', 'classification required');
  end if;
  if p_classification = 'RED' and v_message is not null then
    perform private.fail('VALIDATION', 'a RED decision never carries a message');
  end if;
  if p_classification <> 'RED' and v_message is null then
    perform private.fail('VALIDATION', 'an approved message is required for GREEN and YELLOW');
  end if;
  if p_classification <> 'RED' and private.has_active_restriction(v_case.id) then
    perform private.fail('CONTACT_RESTRICTED', 'contact is restricted; only a RED decision is possible');
  end if;
  if p_approval_type = 'UNCHANGED' and (p_classification is distinct from v_analysis.ai_classification
                                         or v_message is distinct from v_analysis.ai_proposed_message) then
    perform private.fail('VALIDATION', 'UNCHANGED approval must match the analysis proposal');
  end if;
  if p_approval_type = 'MARKED_RED' and p_classification <> 'RED' then
    perform private.fail('VALIDATION', 'MARKED_RED requires RED');
  end if;

  insert into public.approvals (case_id, business_id, analysis_id, founder_id, evidence_version, approval_type,
                                ai_classification, classification, ai_proposed_message, approved_message,
                                deal_situation, next_action)
  values (v_case.id, v_case.business_id, v_analysis.id, (select auth.uid()), v_case.evidence_version, p_approval_type,
          v_analysis.ai_classification, p_classification, v_analysis.ai_proposed_message, v_message,
          btrim(p_deal_situation), btrim(p_next_action))
  returning id into v_id;

  insert into public.client_recommendations (case_id, business_id, approval_id, classification, deal_situation, next_action, approved_message)
  values (v_case.id, v_case.business_id, v_id, p_classification, btrim(p_deal_situation), btrim(p_next_action), v_message)
  on conflict (case_id) do update set approval_id = excluded.approval_id, classification = excluded.classification,
    deal_situation = excluded.deal_situation, next_action = excluded.next_action,
    approved_message = excluded.approved_message, published_at = now();

  update public.cases set workflow_state = 'CLIENT_ACTION_REQUIRED', queued_at = null, review_reason = null
  where id = v_case.id;
  perform private.audit('APPROVED', v_case.id, v_case.business_id, 'FOUNDER', 'Recommendation ready',
    jsonb_build_object('approval_id', v_id, 'analysis_version', v_analysis.version, 'classification', p_classification,
                       'ai_classification', v_analysis.ai_classification, 'approval_type', p_approval_type,
                       'evidence_version', v_case.evidence_version));
  return v_id;
end $$;

-- A RED "stop contact" decision that needs no analysis: stopping is always safe.
create function public.founder_stop_contact(
  p_case_id uuid,
  p_deal_situation text default 'This prospect is not currently recommended for further recovery attempts.',
  p_next_action text default 'No further contact is recommended.'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_id uuid;
begin
  if v_case.workflow_state in ('DRAFT', 'ANALYZING') or private.is_terminal(v_case.workflow_state) then
    perform private.fail('INVALID_STATE', 'case cannot be stopped in its current state');
  end if;
  insert into public.approvals (case_id, business_id, analysis_id, founder_id, evidence_version, approval_type,
                                classification, approved_message, deal_situation, next_action)
  values (v_case.id, v_case.business_id, null, (select auth.uid()), v_case.evidence_version, 'MARKED_RED',
          'RED', null, btrim(p_deal_situation), btrim(p_next_action))
  returning id into v_id;
  insert into public.client_recommendations (case_id, business_id, approval_id, classification, deal_situation, next_action, approved_message)
  values (v_case.id, v_case.business_id, v_id, 'RED', btrim(p_deal_situation), btrim(p_next_action), null)
  on conflict (case_id) do update set approval_id = excluded.approval_id, classification = 'RED',
    deal_situation = excluded.deal_situation, next_action = excluded.next_action, approved_message = null, published_at = now();
  update public.cases set workflow_state = 'CLIENT_ACTION_REQUIRED', queued_at = null, review_reason = null
  where id = v_case.id;
  perform private.audit('STOP_CONTACT', v_case.id, v_case.business_id, 'FOUNDER', 'Recommendation ready',
    jsonb_build_object('approval_id', v_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------- founder: restrictions, notes, pause

create function public.founder_add_restriction(p_case_id uuid, p_kind public.restriction_kind, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
begin
  return private.add_restriction(v_case, p_kind, 'FOUNDER', p_note, null, 'FOUNDER');
end $$;

-- Only an AI-detected restriction can be dismissed, and only as a misreading
-- of the evidence, with a written reason. Founder- and client-recorded
-- restrictions are permanent.
create function public.founder_dismiss_ai_restriction(p_restriction_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_r public.contact_restrictions;
begin
  perform private.require_founder();
  select * into v_r from public.contact_restrictions where id = p_restriction_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'restriction not found');
  end if;
  if v_r.source <> 'AI_DETECTED' then
    perform private.fail('FORBIDDEN', 'founder- and client-recorded restrictions are permanent');
  end if;
  if v_r.status <> 'ACTIVE' then
    perform private.fail('INVALID_STATE', 'restriction already dismissed');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 20 then
    perform private.fail('VALIDATION', 'explain in at least 20 characters why the evidence was misread');
  end if;
  update public.contact_restrictions set status = 'DISMISSED_AS_MISREAD', dismissed_by = (select auth.uid()),
    dismissed_reason = btrim(p_reason), dismissed_at = now()
  where id = v_r.id;
  perform private.audit('RESTRICTION_DISMISSED_AS_MISREAD', v_r.case_id, v_r.business_id, 'FOUNDER', null,
    jsonb_build_object('restriction_id', v_r.id, 'reason', btrim(p_reason)));
end $$;

create function public.founder_add_note(p_case_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_id uuid;
begin
  insert into public.founder_notes (case_id, business_id, body, author)
  values (v_case.id, v_case.business_id, btrim(p_body), (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

create function public.founder_pause_case(p_case_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
begin
  if private.is_terminal(v_case.workflow_state) then
    perform private.fail('INVALID_STATE', 'case is already closed');
  end if;
  update public.analyses set status = 'ERROR', error = 'Case paused', completed_at = now()
  where case_id = v_case.id and status = 'PENDING';
  insert into public.outcomes (case_id, business_id, state, note, recorded_by, recorded_by_role)
  values (v_case.id, v_case.business_id, 'PAUSED', nullif(btrim(coalesce(p_note, '')), ''), (select auth.uid()), 'FOUNDER');
  update public.cases set workflow_state = 'PAUSED', closed_at = now(), queued_at = null, review_reason = null
  where id = v_case.id;
  perform private.audit('CASE_PAUSED', v_case.id, v_case.business_id, 'FOUNDER', 'Case paused');
end $$;

-- ---------------------------------------------------------------- execute grants (default deny)

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
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_fn);
  end loop;
end
$revoke$;
revoke all on all functions in schema private from public, anon, authenticated, service_role;
grant execute on function private.is_founder() to authenticated;
grant execute on function private.is_member(uuid) to authenticated;

grant execute on function
  public.whoami(),
  public.client_create_case(uuid, text, text, text, public.conversation_source, text, numeric, date, text),
  public.client_submit_case(uuid),
  public.client_record_sent(uuid, text),
  public.client_add_response(uuid, text),
  public.client_report_opt_out(uuid, text),
  public.client_record_outcome(uuid, public.workflow_state, numeric, numeric, date, text),
  public.client_list_cases(),
  public.client_get_case(uuid),
  public.founder_create_business(text, text, text),
  public.founder_add_member(uuid, uuid),
  public.founder_start_analysis(uuid),
  public.founder_abandon_analysis(uuid),
  public.founder_request_reanalysis(uuid),
  public.founder_approve(uuid, uuid, integer, public.classification, text, text, text, public.approval_type),
  public.founder_stop_contact(uuid, text, text),
  public.founder_add_restriction(uuid, public.restriction_kind, text),
  public.founder_dismiss_ai_restriction(uuid, text),
  public.founder_add_note(uuid, text),
  public.founder_pause_case(uuid, text)
to authenticated;

grant execute on function
  public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)
to service_role;
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261009120200_stage2a1_functions.sql <<<<<<<<<<<<<<<<<<<<

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. If any
-- critical security property is not in place, everything is rolled back.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_n bigint;
  -- Set by the preflight guard only when the verified Supabase helper is present.
  v_expected_fp text := coalesce(current_setting('rre.rls_auto_enable_fingerprint', true), '');
  v_helper oid := case when coalesce(current_setting('rre.rls_auto_enable_fingerprint', true), '') <> ''
                       then to_regprocedure('public.rls_auto_enable()') end;
  v_now_fp text;
begin
  -- The verified pre-existing helper and its event trigger must be exactly as found.
  if v_expected_fp <> '' then
    select md5(concat_ws('|', p.prosrc, coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), 'NULL'), pg_get_userbyid(p.proowner), p.prosecdef::text,
                         coalesce(p.proconfig::text, 'NULL'), et.evtname, et.evtevent, et.evtenabled::text,
                         coalesce(et.evttags::text, 'NULL'), pg_get_userbyid(et.evtowner)))
      into v_now_fp
    from pg_proc p join pg_event_trigger et on et.evtfoid = p.oid
    where p.oid = v_helper;
    if v_now_fp is distinct from v_expected_fp then
      v_problems := array_append(v_problems, 'public.rls_auto_enable() or event trigger ensure_rls was changed during deployment'::text);
    end if;
  end if;

  select count(*) into v_n from pg_tables where schemaname = 'public' and not rowsecurity;
  if v_n > 0 then v_problems := v_problems || format('%s public table(s) without RLS', v_n); end if;

  select count(*) into v_n from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon';
  if v_n > 0 then v_problems := v_problems || format('anon still holds %s table privilege(s)', v_n); end if;

  select count(*) into v_n from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if v_n > 0 then v_problems := v_problems || format('authenticated holds %s non-SELECT table privilege(s)', v_n); end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.oid is distinct from v_helper; -- event-trigger function: cannot be called directly
  if v_n > 0 then v_problems := v_problems || format('anon can execute %s function(s)', v_n); end if;

  select count(*) into v_n from pg_policies where schemaname = 'public' and cmd <> 'SELECT';
  if v_n > 0 then v_problems := v_problems || format('%s non-SELECT policy(ies) exist', v_n); end if;

  if has_function_privilege('authenticated',
       'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)',
       'EXECUTE') then
    v_problems := array_append(v_problems, 'authenticated can execute internal_complete_analysis'::text);
  end if;

  select count(*) into v_n from pg_trigger
  where tgname in ('approvals_immutable', 'approvals_no_truncate', 'audit_log_immutable', 'audit_log_no_truncate') and tgenabled <> 'D';
  if v_n <> 4 then v_problems := array_append(v_problems, 'immutability triggers missing or disabled'::text); end if;

  if (select count(*) from public.founders) <> 0 then
    v_problems := array_append(v_problems, 'founders table is not empty'::text);
  end if;

  if array_length(v_problems, 1) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-1', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261009120000_stage2a1_schema.sql', 'sha256', '7637b2bc224a7295cb5565e3719becd8da3af332099d8341c0d5b9d4210801dc'),
  jsonb_build_object('file', '20261009120100_stage2a1_security.sql', 'sha256', '519719283de701e50ecf435afcd223085e6cc8b4730eeedc3931b39106211dc9'),
  jsonb_build_object('file', '20261009120200_stage2a1_functions.sql', 'sha256', '59636379ba9ff7ae99e3f433ee953ab4432cfe9691e481ca70cc8e96fcd35c49')
), 'preexisting_rls_auto_enable', case when current_setting('rre.rls_auto_enable_fingerprint', true) <> '' then
  jsonb_build_object('fingerprint', current_setting('rre.rls_auto_enable_fingerprint', true),
                     'body_md5', current_setting('rre.rls_auto_enable_body_md5', true)) end));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

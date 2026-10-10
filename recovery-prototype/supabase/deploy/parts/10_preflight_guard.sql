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
  v_expected_body constant text := $verified_rls_auto_enable$__VERIFIED_RLS_AUTO_ENABLE_BODY__$verified_rls_auto_enable$;
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

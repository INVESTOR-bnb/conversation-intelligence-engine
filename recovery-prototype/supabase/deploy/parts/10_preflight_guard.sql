-- ===================================================================
-- PREFLIGHT GUARD — refuses to deploy unless this is a clean Supabase
-- database ready for Stage 2A-1. Raising here aborts the transaction.
-- ===================================================================
do $preflight$
declare
  v_problems text[] := '{}';
  v_role text;
  v_existing text;
begin
  if current_setting('server_version_num')::int < 150000 then
    v_problems := v_problems || 'PostgreSQL 15 or newer is required';
  end if;

  -- Supabase prerequisites the migrations rely on.
  if to_regclass('auth.users') is null then
    v_problems := v_problems || 'auth.users is missing (is this a Supabase database?)';
  end if;
  if to_regprocedure('auth.uid()') is null then
    v_problems := v_problems || 'auth.uid() is missing';
  end if;
  if to_regprocedure('auth.jwt()') is null then
    v_problems := v_problems || 'auth.jwt() is missing';
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

  -- The migrations tighten privileges on everything in schema public, so they
  -- must not run over unrelated objects. Extension-owned objects are ignored.
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

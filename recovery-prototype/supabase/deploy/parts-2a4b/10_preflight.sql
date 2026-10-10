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

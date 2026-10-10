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

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. If any
-- critical security property is not in place, everything is rolled back.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_n bigint;
begin
  select count(*) into v_n from pg_tables where schemaname = 'public' and not rowsecurity;
  if v_n > 0 then v_problems := v_problems || format('%s public table(s) without RLS', v_n); end if;

  select count(*) into v_n from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon';
  if v_n > 0 then v_problems := v_problems || format('anon still holds %s table privilege(s)', v_n); end if;

  select count(*) into v_n from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if v_n > 0 then v_problems := v_problems || format('authenticated holds %s non-SELECT table privilege(s)', v_n); end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_n > 0 then v_problems := v_problems || format('anon can execute %s function(s)', v_n); end if;

  select count(*) into v_n from pg_policies where schemaname = 'public' and cmd <> 'SELECT';
  if v_n > 0 then v_problems := v_problems || format('%s non-SELECT policy(ies) exist', v_n); end if;

  if has_function_privilege('authenticated',
       'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)',
       'EXECUTE') then
    v_problems := v_problems || 'authenticated can execute internal_complete_analysis';
  end if;

  select count(*) into v_n from pg_trigger
  where tgname in ('approvals_immutable', 'approvals_no_truncate', 'audit_log_immutable', 'audit_log_no_truncate') and tgenabled <> 'D';
  if v_n <> 4 then v_problems := v_problems || 'immutability triggers missing or disabled'; end if;

  if (select count(*) from public.founders) <> 0 then
    v_problems := v_problems || 'founders table is not empty';
  end if;

  if array_length(v_problems, 1) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed';
end
$postcheck$;

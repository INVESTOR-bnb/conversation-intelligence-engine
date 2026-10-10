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

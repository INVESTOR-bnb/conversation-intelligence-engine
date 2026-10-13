-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-5d-3a is applied
-- (the spending ledger and its functions exist) and 2A-6a is not yet applied.
-- Records a fingerprint of every existing spending, contract and settlement
-- function so the post-install self-check can prove none of them changed.
-- ===================================================================
do $preflight$
begin
  if to_regprocedure('public.internal_ai_reservation_terms(uuid)') is not null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-6a is already applied.';
  end if;
  if to_regprocedure('public.internal_reserve_ai_spend(uuid, text, text)') is null or to_regclass('private.ai_spend_ledger') is null
     or (select count(*) from information_schema.columns where table_schema = 'private' and table_name = 'ai_spend_ledger'
         and column_name in ('analysis_id', 'status', 'reserved_usd', 'analyst_model', 'reviewer_model', 'analyst_max_output', 'reviewer_max_output',
                             'analyst_input_bound', 'reviewer_input_bound', 'analyst_in_price', 'analyst_out_price', 'reviewer_in_price', 'reviewer_out_price')) <> 13 then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5d-3a (AI spending controls) is not applied.';
  end if;
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): role % cannot bypass RLS', current_user;
  end if;
  perform set_config('rre.fingerprint_before', (
    select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname in ('internal_reserve_ai_spend', 'internal_ai_dispatch', 'internal_ai_report_usage', 'founder_ai_spend_summary',
                                                  'internal_complete_analysis', 'founder_abandon_analysis', 'founder_start_analysis'))
       or (n.nspname = 'private' and p.proname in ('ai_estimate_usd', 'ai_committed_usd', 'ai_settle', 'ai_reconcile', 'analysis_output_problems'))), true);
  perform set_config('rre.counts_before', (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.cases),
    (select count(*) from public.audit_log), (select count(*) from private.ai_spend_ledger),
    (select md5(coalesce(string_agg(c::text, ''), '')) from private.ai_spend_config c),
    (select md5(coalesce(string_agg(m::text, '' order by model), '')) from private.ai_model_prices m))), true);
  raise notice 'Preflight passed: installing Stage 2A-6a (read-only reservation terms for the service role).';
end
$preflight$;

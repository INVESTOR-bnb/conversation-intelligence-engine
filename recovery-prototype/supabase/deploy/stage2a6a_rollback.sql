-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6a ROLLBACK (single transaction)
-- Drops public.internal_ai_reservation_terms(uuid), and nothing else. Every
-- spending, contract and settlement function, every table, setting, price and
-- record is left exactly as it is (the self-check proves it).
-- WARNING: a pipeline that checks reservation terms before dispatch (Stage 2A-6b)
-- then refuses to dispatch a paid provider request; the fake provider still works.
-- Safe to re-run: if 2A-6a is not applied it refuses and changes nothing.
-- Refuses while Stage 2A-6c (the Anthropic price rows) is applied: roll that back first.
-- Afterwards run stage2a5d3a_verify.sql and the earlier verification files.
-- ===================================================================

begin;

do $preflight$
begin
  if to_regprocedure('public.internal_ai_reservation_terms(uuid)') is null then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-6a is not applied.';
  end if;
  if exists (select 1 from private.ai_model_prices where model in ('claude-opus-5-5', 'claude-sonnet-5-5')) then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-6c (Anthropic prices) is applied; run stage2a6c_rollback.sql first.';
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
end
$preflight$;

drop function public.internal_ai_reservation_terms(uuid);

do $postcheck$
begin
  if to_regprocedure('public.internal_ai_reservation_terms(uuid)') is not null then
    raise exception 'ROLLBACK ABORTED (rolled back): internal_ai_reservation_terms remains';
  end if;
  if (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'public' and p.proname in ('internal_reserve_ai_spend', 'internal_ai_dispatch', 'internal_ai_report_usage', 'founder_ai_spend_summary',
                                                    'internal_complete_analysis', 'founder_abandon_analysis', 'founder_start_analysis'))
         or (n.nspname = 'private' and p.proname in ('ai_estimate_usd', 'ai_committed_usd', 'ai_settle', 'ai_reconcile', 'analysis_output_problems')))
     is distinct from current_setting('rre.fingerprint_before', true) then
    raise exception 'ROLLBACK ABORTED (rolled back): another function would change';
  end if;
  if (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.cases),
       (select count(*) from public.audit_log), (select count(*) from private.ai_spend_ledger),
       (select md5(coalesce(string_agg(c::text, ''), '')) from private.ai_spend_config c),
       (select md5(coalesce(string_agg(m::text, '' order by model), '')) from private.ai_model_prices m))) is distinct from current_setting('rre.counts_before', true) then
    raise exception 'ROLLBACK ABORTED (rolled back): data, the spending configuration or the price list would change';
  end if;
  raise notice 'Rollback self-check passed: reservation terms function removed; nothing else changed.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_ROLLED_BACK', jsonb_build_object('stage', '2A-6a'));

commit;
-- END OF ROLLBACK FILE — if this line is missing, the copy is incomplete: do not run.

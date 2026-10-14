-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-6a (and so 2A-5d-3a) is
-- applied, neither Anthropic model has a price row yet, and spending is DISABLED.
-- Records a fingerprint of every function, the spending configuration, the existing
-- price rows and the data, so the post-install self-check can prove that the only
-- change is the two new, inactive price rows.
-- ===================================================================
do $preflight$
begin
  if exists (select 1 from private.ai_model_prices where model in ('claude-opus-5-5', 'claude-sonnet-5-5')) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): a price row for claude-opus-5-5 or claude-sonnet-5-5 already exists (Stage 2A-6c already applied?).';
  end if;
  if to_regprocedure('public.internal_ai_reservation_terms(uuid)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-6a (reservation terms) is not applied.';
  end if;
  if to_regclass('private.ai_model_prices') is null or to_regclass('private.ai_spend_config') is null
     or to_regprocedure('public.internal_reserve_ai_spend(uuid, text, text)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5d-3a (AI spending controls) is not applied.';
  end if;
  if coalesce((select enabled from private.ai_spend_config where id), true) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): AI spending is enabled (or not configured). It must be disabled to add prices.';
  end if;
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): role % cannot bypass RLS', current_user;
  end if;
  perform set_config('rre.fingerprint_before', (
    select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')), true);
  perform set_config('rre.counts_before', (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.cases),
    (select count(*) from public.audit_log), (select count(*) from private.ai_spend_ledger),
    (select md5(coalesce(string_agg(c::text, ''), '')) from private.ai_spend_config c),
    (select md5(coalesce(string_agg(m::text, '' order by model), '')) from private.ai_model_prices m))), true);
  raise notice 'Preflight passed: adding inactive prices for claude-opus-5-5 and claude-sonnet-5-5 (Stage 2A-6c); spending stays disabled.';
end
$preflight$;

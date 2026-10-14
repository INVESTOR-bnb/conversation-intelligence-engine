-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6c ROLLBACK (single transaction)
-- Removes the two Anthropic price rows (claude-opus-5-5, claude-sonnet-5-5), and
-- nothing else. Every function, table, setting, the fake provider's price and every
-- record is left exactly as it is (the self-check proves it).
-- Refuses, changing nothing, while either row is ACTIVE (deactivate deliberately
-- first) or while an unsettled reservation (RESERVED or HELD) uses either model.
-- Settled ledger rows keep their own snapshot of the prices: nothing is lost.
-- Safe to re-run: if 2A-6c is not applied it refuses and changes nothing.
-- Afterwards run stage2a6a_verify.sql, stage2a5d3a_verify.sql and the earlier files.
-- ===================================================================

begin;

do $preflight$
begin
  if (select count(*) from private.ai_model_prices where model in ('claude-opus-5-5', 'claude-sonnet-5-5')) = 0 then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-6c is not applied.';
  end if;
  if exists (select 1 from private.ai_model_prices where model in ('claude-opus-5-5', 'claude-sonnet-5-5') and active) then
    raise exception 'ROLLBACK REFUSED (nothing changed): a paid model is ACTIVE; deactivate it deliberately first.';
  end if;
  if exists (select 1 from private.ai_spend_ledger where status in ('RESERVED', 'HELD')
             and (analyst_model in ('claude-opus-5-5', 'claude-sonnet-5-5') or reviewer_model in ('claude-opus-5-5', 'claude-sonnet-5-5'))) then
    raise exception 'ROLLBACK REFUSED (nothing changed): an unsettled reservation uses a paid model; reconcile it first.';
  end if;
  perform set_config('rre.fingerprint_before', (
    select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')), true);
  perform set_config('rre.counts_before', (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.cases),
    (select count(*) from public.audit_log), (select md5(coalesce(string_agg(l::text, '' order by analysis_id), '')) from private.ai_spend_ledger l),
    (select md5(coalesce(string_agg(c::text, ''), '')) from private.ai_spend_config c),
    (select md5(coalesce(string_agg(m::text, '' order by model), '')) from private.ai_model_prices m
     where model not in ('claude-opus-5-5', 'claude-sonnet-5-5')))), true);
end
$preflight$;

delete from private.ai_model_prices where model in ('claude-opus-5-5', 'claude-sonnet-5-5') and not active;

do $postcheck$
begin
  if exists (select 1 from private.ai_model_prices where model in ('claude-opus-5-5', 'claude-sonnet-5-5')) then
    raise exception 'ROLLBACK ABORTED (rolled back): a paid model price row remains';
  end if;
  if (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private'))
     is distinct from current_setting('rre.fingerprint_before', true) then
    raise exception 'ROLLBACK ABORTED (rolled back): a function would change';
  end if;
  if (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.cases),
       (select count(*) from public.audit_log), (select md5(coalesce(string_agg(l::text, '' order by analysis_id), '')) from private.ai_spend_ledger l),
       (select md5(coalesce(string_agg(c::text, ''), '')) from private.ai_spend_config c),
       (select md5(coalesce(string_agg(m::text, '' order by model), '')) from private.ai_model_prices m))) is distinct from current_setting('rre.counts_before', true) then
    raise exception 'ROLLBACK ABORTED (rolled back): data, the ledger, the spending configuration or another price row would change';
  end if;
  raise notice 'Rollback self-check passed: the two Anthropic price rows removed; nothing else changed.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_ROLLED_BACK', jsonb_build_object('stage', '2A-6c'));

commit;
-- END OF ROLLBACK FILE — if this line is missing, the copy is incomplete: do not run.

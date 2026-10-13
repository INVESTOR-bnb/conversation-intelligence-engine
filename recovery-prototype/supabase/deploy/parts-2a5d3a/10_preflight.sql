-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-5d-2 is applied,
-- internal_complete_analysis and founder_abandon_analysis are exactly the
-- reviewed versions (2A-5b and 2A-1), and 2A-5d-3a is not yet applied.
-- ===================================================================
do $preflight$
declare
  v_ica text := (select prosrc from pg_proc where oid = to_regprocedure('public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'));
  v_abandon text := (select prosrc from pg_proc where oid = to_regprocedure('public.founder_abandon_analysis(uuid)'));
  v_contract text := (select prosrc from pg_proc where oid = to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'));
begin
  if to_regprocedure('public.internal_reserve_ai_spend(uuid, text, text)') is not null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5d-3a is already applied.';
  end if;
  if coalesce(v_contract, '') not like '%Stage 2A-5d-2%' then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5d-2 (adversarial review contract) is not applied.';
  end if;
  if v_ica is null or md5(v_ica) <> '1639e2cc87c25ac16ba4f2a1c248a778' then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): internal_complete_analysis is not the reviewed Stage 2A-5b version (md5 %)', md5(coalesce(v_ica, ''));
  end if;
  if v_abandon is null or md5(v_abandon) <> 'c3416ac9416237615b761d5fd921d513' then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): founder_abandon_analysis is not the reviewed Stage 2A-1 version (md5 %)', md5(coalesce(v_abandon, ''));
  end if;
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): role % cannot bypass RLS', current_user;
  end if;
  if to_regclass('private.ai_spend_ledger') is not null then
    raise notice 'Spending tables already exist (kept by an earlier rollback): their records are kept and re-used.';
  end if;
  raise notice 'Preflight passed: installing Stage 2A-5d-3a (AI spending controls, disabled).';
end
$preflight$;

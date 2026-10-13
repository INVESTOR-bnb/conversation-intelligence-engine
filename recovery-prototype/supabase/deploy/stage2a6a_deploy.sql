-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6a DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a6a.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-5d-3a. Adds ONE read-only, service-role-only function,
-- internal_ai_reservation_terms(analysis_id): the per-call model, output cap,
-- input bound and snapshotted prices of an existing spending reservation, so
-- the analysis pipeline can check a provider request against the reservation
-- before dispatching it. Changes no existing function, table, policy, privilege,
-- spending setting, price or data. Spending stays as it is (disabled).
-- No AI is connected. All-or-nothing. Contains no credentials.
-- Refuses to run unless 2A-5d-3a is applied, or if 2A-6a is already applied.
-- Undo: deploy/stage2a6a_rollback.sql. Check: deploy/stage2a6a_verify.sql.
--
-- Source migration (sha256):
--   20261019120000_stage2a6a_reservation_terms.sql  5aada4412c5c8a716bb69694353a95deb601cefcba87d204e0f819836c4538dc
-- ===================================================================

begin;

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

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261019120000_stage2a6a_reservation_terms.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-6a — the reservation's terms, for the pipeline's pre-dispatch checks.
-- No AI is connected; no provider credential exists. Synthetic data only.
--
-- One new, read-only, service-role-only function. Nothing else changes: no table,
-- column, policy, privilege of an existing object, or existing function is altered,
-- and no data is written.
--
-- Before a real provider request is dispatched, the pipeline must prove that the
-- request it is about to send is inside what the database reserved:
--   * its counted input tokens   <= the reserved input bound for that call;
--   * its output cap (max_tokens) =  the reserved output cap for that call;
--   * the model and its per-million-token prices that the provider code expects
--                                  =  the prices snapshotted in the reservation.
-- internal_reserve_ai_spend (Stage 2A-5d-3a) returns only the model and output cap
-- of each call. This function returns the full terms of an existing reservation,
-- exactly as the ledger recorded them (computed and snapshotted by the database,
-- never by the caller):
--
--   public.internal_ai_reservation_terms(analysis_id) -> jsonb
--   { "analysis_id", "status", "reserved_usd",
--     "analyst":  { "model", "max_output_tokens", "input_bound", "input_usd_per_mtok", "output_usd_per_mtok" },
--     "reviewer": { ... same ... } }
--
-- Refusals: FORBIDDEN (not the service role), NOT_RESERVED (no reservation).
-- It reveals nothing a business or the founder session can reach: like the other
-- internal_* functions, only the service role may execute it.
-- Rollback: supabase/deploy/stage2a6a_rollback.sql (drops this function only).

create or replace function public.internal_ai_reservation_terms(p_analysis_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_l private.ai_spend_ledger;
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
  select * into v_l from private.ai_spend_ledger where analysis_id = p_analysis_id;
  if not found then
    perform private.fail('NOT_RESERVED', 'no spending reservation for this analysis');
  end if;
  return jsonb_build_object(
    'analysis_id', v_l.analysis_id,
    'status', v_l.status,
    'reserved_usd', v_l.reserved_usd,
    'analyst', jsonb_build_object('model', v_l.analyst_model, 'max_output_tokens', v_l.analyst_max_output,
      'input_bound', v_l.analyst_input_bound, 'input_usd_per_mtok', v_l.analyst_in_price, 'output_usd_per_mtok', v_l.analyst_out_price),
    'reviewer', jsonb_build_object('model', v_l.reviewer_model, 'max_output_tokens', v_l.reviewer_max_output,
      'input_bound', v_l.reviewer_input_bound, 'input_usd_per_mtok', v_l.reviewer_in_price, 'output_usd_per_mtok', v_l.reviewer_out_price));
end $$;

revoke all on function public.internal_ai_reservation_terms(uuid) from public, anon, authenticated, service_role;
grant execute on function public.internal_ai_reservation_terms(uuid) to service_role;
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261019120000_stage2a6a_reservation_terms.sql <<<<<<<<<<<<<<<<<<<<

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem rolls
-- everything back. The behavioural check runs in a sub-transaction on a
-- synthetic ledger row and is undone; nothing it writes is kept.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_fn regprocedure := to_regprocedure('public.internal_ai_reservation_terms(uuid)');
  v_id uuid := gen_random_uuid();
  v_terms jsonb;
  v_forbidden text;
  v_missing text;
  v_fingerprint text;
begin
  if v_fn is null or not coalesce((select prosecdef and provolatile = 's' and proconfig @> array['search_path=""'] from pg_proc where oid = v_fn), false) then
    v_problems := array_append(v_problems, 'internal_ai_reservation_terms is missing, not SECURITY DEFINER, not STABLE, or does not pin search_path'::text);
  elsif has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE')
        or not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    v_problems := array_append(v_problems, 'internal_ai_reservation_terms privileges are not service-role only'::text);
  end if;
  -- Behaviour, on a synthetic ledger row, undone.
  begin
    insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model, analyst_input_bound, analyst_max_output,
      reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price, reviewer_out_price, reserved_usd)
    values (v_id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 't-a', 't-r', 8664, 1000, 10664, 2000, 1, 5, 10, 50, 0.2204);
    perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
    v_terms := public.internal_ai_reservation_terms(v_id);
    begin
      perform public.internal_ai_reservation_terms(gen_random_uuid());
    exception when others then v_missing := sqlerrm;
    end;
    perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
    begin
      perform public.internal_ai_reservation_terms(v_id);
    exception when others then v_forbidden := sqlerrm;
    end;
    raise exception 'SELFTEST_UNDO';
  exception when others then
    if sqlerrm <> 'SELFTEST_UNDO' then
      v_problems := array_append(v_problems, format('the reservation-terms self-test failed to run (%s)', sqlerrm));
    end if;
  end;
  if v_terms is distinct from jsonb_build_object('analysis_id', v_id, 'status', 'RESERVED', 'reserved_usd', 0.2204,
       'analyst', '{"model": "t-a", "max_output_tokens": 1000, "input_bound": 8664, "input_usd_per_mtok": 1.000000, "output_usd_per_mtok": 5.000000}'::jsonb,
       'reviewer', '{"model": "t-r", "max_output_tokens": 2000, "input_bound": 10664, "input_usd_per_mtok": 10.000000, "output_usd_per_mtok": 50.000000}'::jsonb)
     or coalesce(v_missing, '') not like 'NOT_RESERVED:%' or coalesce(v_forbidden, '') not like 'FORBIDDEN:%' then
    v_problems := array_append(v_problems, 'internal_ai_reservation_terms does not behave as reviewed'::text);
  end if;
  if exists (select 1 from private.ai_spend_ledger where analysis_id = v_id) then
    v_problems := array_append(v_problems, 'the self-test left something behind'::text);
  end if;
  -- Nothing else changed: every existing spending, contract and settlement function, and all data.
  select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
    into v_fingerprint
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname in ('internal_reserve_ai_spend', 'internal_ai_dispatch', 'internal_ai_report_usage', 'founder_ai_spend_summary',
                                                'internal_complete_analysis', 'founder_abandon_analysis', 'founder_start_analysis'))
     or (n.nspname = 'private' and p.proname in ('ai_estimate_usd', 'ai_committed_usd', 'ai_settle', 'ai_reconcile', 'analysis_output_problems'));
  if v_fingerprint is distinct from current_setting('rre.fingerprint_before', true) then
    v_problems := array_append(v_problems, 'an existing spending, contract or settlement function changed'::text);
  end if;
  if (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.cases),
       (select count(*) from public.audit_log), (select count(*) from private.ai_spend_ledger),
       (select md5(coalesce(string_agg(c::text, ''), '')) from private.ai_spend_config c),
       (select md5(coalesce(string_agg(m::text, '' order by model), '')) from private.ai_model_prices m))) is distinct from current_setting('rre.counts_before', true) then
    v_problems := array_append(v_problems, 'data, the spending configuration or the price list would change'::text);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'private' and tablename like 'ai\_%')
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
                and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%')) then
    v_problems := array_append(v_problems, 'spending tables gained a policy, or analyses/restrictions are no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: reservation terms readable by the service role only; nothing else changed.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-6a', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261019120000_stage2a6a_reservation_terms.sql', 'sha256', '5aada4412c5c8a716bb69694353a95deb601cefcba87d204e0f819836c4538dc'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

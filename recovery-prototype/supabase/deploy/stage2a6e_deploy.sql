-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6e DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a6e.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-6a. Adds ONE price row to private.ai_model_prices, INACTIVE:
-- kimi-k3 (USD 3 input / 15 output per million tokens; no cached-input
-- discount), output cap 8000. An inactive model cannot be reserved, so nothing
-- can be spent on it. Changes no function, table, policy, privilege, setting,
-- existing price or data; the budget (20), stop (18), per-analysis limit (1)
-- and the DISABLED state stay. No AI is connected. All-or-nothing. Contains no
-- credentials. Refuses to run unless 2A-6a is applied and spending is
-- disabled, or if the row already exists. Independent of Stage 2A-6c.
-- Undo: deploy/stage2a6e_rollback.sql. Check: deploy/stage2a6e_verify.sql.
--
-- Source migration (sha256):
--   20261021120000_stage2a6e_kimi_price.sql  32ef3e75a353fc12813ef8932ac180576af367f9c2a2b6fbf1b6577cbbc2c55d
-- ===================================================================

begin;

-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-6a (and so 2A-5d-3a) is
-- applied, kimi-k3 has no price row yet, and spending is DISABLED. Records a fingerprint
-- of every function, the spending configuration, the existing price rows and the data, so
-- the post-install self-check can prove that the only change is the one new, inactive row.
-- ===================================================================
do $preflight$
begin
  if exists (select 1 from private.ai_model_prices where model = 'kimi-k3') then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): a price row for kimi-k3 already exists (Stage 2A-6e already applied?).';
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
  raise notice 'Preflight passed: adding an inactive price for kimi-k3 (Stage 2A-6e); spending stays disabled.';
end
$preflight$;

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261021120000_stage2a6e_kimi_price.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-6e — the price for kimi-k3 (Moonshot AI), INACTIVE.
-- No provider credential exists; spending stays disabled.
--
-- One row is added to private.ai_model_prices and nothing else changes: no table, column,
-- function, policy, privilege, setting or existing row (the fake provider's and the
-- Anthropic rows are untouched).
--
-- Values (official Kimi K3 prices, as confirmed by the founder from the Moonshot
-- documentation): regular input USD 3, cache write (5-minute TTL) USD 3, cached input
-- USD 0.30, output USD 15, per million tokens. The ledger has one input price, applied to
-- ALL prompt_tokens (which include the cached and cache-written tokens), so it is set to
-- USD 3: no cached-input discount is taken and cache writes are never understated. Output,
-- including reasoning tokens, is USD 15. These must equal the code allowlist
-- (supabase/functions/_shared/edge/kimiProvider.ts, KIMI_MODELS) exactly: before every
-- dispatch the pipeline compares the prices and cap snapshotted in the reservation with the
-- allowlist and refuses any difference (SPEND_TERMS_MISMATCH). The tests compare them.
--
-- max_output_tokens = 8,000: the per-call cap the reservation prices and the request's
-- max_completion_tokens (analyst and reviewer each).
--
-- active = false: the reservation function refuses inactive models (MODEL_NOT_PRICED), so
-- kimi-k3 cannot be reserved, and so cannot be called, until a separately approved paid run
-- activates it for that run only. The budget (USD 20), stop threshold (USD 18), USD 1
-- per-analysis limit and the disabled state are not touched.
--
-- What one analysis may cost under the existing reservation formula (E = 6 x text bytes +
-- 64 per message; analyst input bound 8000 + E; reviewer input bound 8000 + E + 2 x 8000):
--   kimi-k3 analyst + kimi-k3 reviewer   0.336 + 6E/1e6  -> fits USD 1 up to E ~ 110,000
--   (about 18 KB of conversation text); larger cases are refused (RESERVATION_TOO_LARGE).
--
-- Rollback: supabase/deploy/stage2a6e_rollback.sql (removes the row while inactive and unused).

insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note) values
  ('kimi-k3', 3, 15, 8000, false, 'Stage 2A-6e: Kimi K3 list price; input at the regular/cache-write price, no cached discount. Inactive until separately approved.');
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261021120000_stage2a6e_kimi_price.sql <<<<<<<<<<<<<<<<<<<<

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem rolls
-- everything back. It checks that the ONLY change is the new kimi-k3 row, exactly as
-- reviewed and inactive, and that the existing reservation estimate, applied to it under
-- the live configuration, gives the reviewed amounts.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_cfg private.ai_spend_config;
  v_kimi private.ai_model_prices;
  v_fingerprint text;
begin
  select * into v_cfg from private.ai_spend_config where id;
  select * into v_kimi from private.ai_model_prices where model = 'kimi-k3';
  -- The row, exactly (prices, cap, inactive).
  if v_kimi.model is null or (v_kimi.input_usd_per_mtok, v_kimi.output_usd_per_mtok, v_kimi.max_output_tokens, v_kimi.active)
       is distinct from (3::numeric, 15::numeric, 8000, false) then
    v_problems := array_append(v_problems, 'kimi-k3 is not priced at 3/15 per million with cap 8000, inactive'::text);
  end if;
  -- No model other than the fake is active.
  if exists (select 1 from private.ai_model_prices where active and model <> 'FAKE-PROVIDER-NOT-AI') then
    v_problems := array_append(v_problems, 'a model other than the fake provider is active'::text);
  end if;
  -- Spending: disabled, budget 20, stop 18, max 1 per analysis (unchanged).
  if v_cfg.id is null or v_cfg.enabled or v_cfg.budget_usd <> 20 or v_cfg.stop_at_usd <> 18 or v_cfg.max_reservation_usd <> 1 then
    v_problems := array_append(v_problems, 'spending is not disabled with budget 20, stop 18 and max 1 per analysis'::text);
  end if;
  -- The existing estimate (pure function) on the new row, under the live configuration.
  if v_kimi.model is not null and v_cfg.id is not null then
    if (private.ai_estimate_usd(100, 1, 0, v_kimi, v_kimi, v_cfg) ->> 'usd')::numeric <> 0.3400
       or (private.ai_estimate_usd(18000, 1, 0, v_kimi, v_kimi, v_cfg) ->> 'usd')::numeric > v_cfg.max_reservation_usd
       or (private.ai_estimate_usd(18500, 1, 0, v_kimi, v_kimi, v_cfg) ->> 'usd')::numeric <= v_cfg.max_reservation_usd then
      v_problems := array_append(v_problems, 'the reservation estimate for kimi-k3 is not the reviewed amount'::text);
    end if;
  end if;
  -- Nothing else changed: every function, the configuration, every other price row, all data.
  select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc || coalesce(p.proacl::text, '') || p.prosecdef::text || coalesce(p.proconfig::text, '')), ';' order by p.oid::regprocedure::text)
    into v_fingerprint
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private');
  if v_fingerprint is distinct from current_setting('rre.fingerprint_before', true) then
    v_problems := array_append(v_problems, 'a function changed'::text);
  end if;
  if (select concat_ws('/', (select count(*) from public.analyses), (select count(*) from public.cases),
       (select count(*) from public.audit_log), (select count(*) from private.ai_spend_ledger),
       (select md5(coalesce(string_agg(c::text, ''), '')) from private.ai_spend_config c),
       (select md5(coalesce(string_agg(m::text, '' order by model), '')) from private.ai_model_prices m
        where model <> 'kimi-k3'))) is distinct from current_setting('rre.counts_before', true) then
    v_problems := array_append(v_problems, 'data, the spending configuration or an existing price row would change'::text);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'private' and tablename like 'ai\_%')
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
                and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%'))
     or has_table_privilege('authenticated', 'private.ai_model_prices', 'SELECT') or has_table_privilege('anon', 'private.ai_model_prices', 'SELECT') then
    v_problems := array_append(v_problems, 'spending tables are exposed, or analyses/restrictions are no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: one inactive kimi-k3 price row added; spending disabled; nothing else changed.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-6e', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261021120000_stage2a6e_kimi_price.sql', 'sha256', '32ef3e75a353fc12813ef8932ac180576af367f9c2a2b6fbf1b6577cbbc2c55d'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6c DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a6c.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-6a. Adds TWO price rows to private.ai_model_prices, both
-- INACTIVE: claude-opus-5-5 (USD 4 / 20 per million tokens) and
-- claude-sonnet-5-5 (USD 2 / 10), each with an output cap of 8000. Inactive
-- models cannot be reserved, so nothing can be spent on them. Changes no
-- function, table, policy, privilege, setting, existing price or data; the
-- budget (20), stop (18), per-analysis limit (1) and the DISABLED state stay.
-- No AI is connected. All-or-nothing. Contains no credentials.
-- Refuses to run unless 2A-6a is applied and spending is disabled, or if the
-- rows already exist.
-- Undo: deploy/stage2a6c_rollback.sql. Check: deploy/stage2a6c_verify.sql.
--
-- Source migration (sha256):
--   20261020120000_stage2a6c_model_prices.sql  7de13fe100c4a470e4727f8fd6f4950ec5c946532d76ad14331429c8b2674b88
-- ===================================================================

begin;

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

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261020120000_stage2a6c_model_prices.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-6c — prices for the two approved Anthropic models, INACTIVE.
-- No AI is connected; no provider credential exists; spending stays disabled.
--
-- Two rows are added to private.ai_model_prices and nothing else changes: no table,
-- column, function, policy, privilege, setting or existing row (the fake provider's
-- row is untouched).
--
-- Values (official models overview and pricing pages, checked 2026-10-14):
--   claude-opus-5-5    USD 4 input / 20 output per million tokens; model maximum output 128,000
--   claude-sonnet-5-5  USD 2 input / 10 output per million tokens; model maximum output 128,000
-- These are the standard, global-inference prices. They must equal the code allowlist
-- (supabase/functions/_shared/edge/anthropicProvider.ts, ANTHROPIC_MODELS) exactly: before
-- every dispatch the pipeline compares the prices and cap snapshotted in the reservation
-- with the allowlist and refuses any difference (SPEND_TERMS_MISMATCH). The tests compare
-- this file with the allowlist.
--
-- max_output_tokens = 8,000 for both: the per-call output cap the reservation prices and the
-- request's max_tokens. It is a provisional cap (the paid evaluation should calibrate it):
-- thinking tokens count as output, and each call has 55 seconds.
--
-- active = false: the reservation function refuses inactive models (MODEL_NOT_PRICED), so
-- neither model can be reserved, and so neither can be called, until a separately approved
-- step activates it. The budget (USD 20), stop threshold (USD 18), USD 1 per-analysis limit
-- and the disabled state are not touched.
--
-- What one analysis may cost under the existing reservation formula (E = 6 x text bytes +
-- 64 per message; the analyst input bound = 8000 + E; the reviewer's = 8000 + E + 2 x 8000):
--   Opus analyst + Opus reviewer      0.448 + 8E/1e6   -> fits USD 1 up to E ~ 69,000 (about 11 KB of text)
--   Opus analyst + Sonnet reviewer    0.320 + 6E/1e6   -> up to E ~ 113,000 (about 18 KB)
--   Sonnet analyst + Sonnet reviewer  0.224 + 4E/1e6   -> up to E ~ 194,000 (about 32 KB)
-- Larger cases are refused by the existing USD 1 limit (RESERVATION_TOO_LARGE).
--
-- Rollback: supabase/deploy/stage2a6c_rollback.sql (removes the two rows while inactive and unused).

insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note) values
  ('claude-opus-5-5', 4, 20, 8000, false, 'Stage 2A-6c: Anthropic list price, standard tier, global inference (checked 2026-10-14). Inactive until separately approved.'),
  ('claude-sonnet-5-5', 2, 10, 8000, false, 'Stage 2A-6c: Anthropic list price, standard tier, global inference (checked 2026-10-14). Inactive until separately approved.');
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261020120000_stage2a6c_model_prices.sql <<<<<<<<<<<<<<<<<<<<

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem rolls
-- everything back. It checks that the ONLY change is the two new price rows,
-- exactly as reviewed and inactive, and that the existing reservation estimate,
-- applied to them under the live configuration, gives the reviewed amounts.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_cfg private.ai_spend_config;
  v_opus private.ai_model_prices;
  v_sonnet private.ai_model_prices;
  v_fingerprint text;
begin
  select * into v_cfg from private.ai_spend_config where id;
  select * into v_opus from private.ai_model_prices where model = 'claude-opus-5-5';
  select * into v_sonnet from private.ai_model_prices where model = 'claude-sonnet-5-5';
  -- The two rows, exactly (prices, cap, inactive).
  if v_opus.model is null or (v_opus.input_usd_per_mtok, v_opus.output_usd_per_mtok, v_opus.max_output_tokens, v_opus.active)
       is distinct from (4::numeric, 20::numeric, 8000, false) then
    v_problems := array_append(v_problems, 'claude-opus-5-5 is not priced at 4/20 per million with cap 8000, inactive'::text);
  end if;
  if v_sonnet.model is null or (v_sonnet.input_usd_per_mtok, v_sonnet.output_usd_per_mtok, v_sonnet.max_output_tokens, v_sonnet.active)
       is distinct from (2::numeric, 10::numeric, 8000, false) then
    v_problems := array_append(v_problems, 'claude-sonnet-5-5 is not priced at 2/10 per million with cap 8000, inactive'::text);
  end if;
  -- No model other than the fake is active (the fake row itself is compared below).
  if exists (select 1 from private.ai_model_prices where active and model <> 'FAKE-PROVIDER-NOT-AI') then
    v_problems := array_append(v_problems, 'a model other than the fake provider is active'::text);
  end if;
  -- Spending: disabled, budget 20, stop 18, max 1 per analysis (unchanged).
  if v_cfg.id is null or v_cfg.enabled or v_cfg.budget_usd <> 20 or v_cfg.stop_at_usd <> 18 or v_cfg.max_reservation_usd <> 1 then
    v_problems := array_append(v_problems, 'spending is not disabled with budget 20, stop 18 and max 1 per analysis'::text);
  end if;
  -- The existing estimate (pure function) on the new rows, under the live configuration.
  if v_opus.model is not null and v_sonnet.model is not null and v_cfg.id is not null then
    if (private.ai_estimate_usd(100, 1, 0, v_opus, v_opus, v_cfg) ->> 'usd')::numeric <> 0.4534
       or (private.ai_estimate_usd(100, 1, 0, v_opus, v_sonnet, v_cfg) ->> 'usd')::numeric <> 0.3240
       or (private.ai_estimate_usd(100, 1, 0, v_sonnet, v_sonnet, v_cfg) ->> 'usd')::numeric <> 0.2267
       or (private.ai_estimate_usd(11000, 1, 0, v_opus, v_opus, v_cfg) ->> 'usd')::numeric > v_cfg.max_reservation_usd
       or (private.ai_estimate_usd(12000, 1, 0, v_opus, v_opus, v_cfg) ->> 'usd')::numeric <= v_cfg.max_reservation_usd then
      v_problems := array_append(v_problems, 'the reservation estimate for the new models is not the reviewed amount'::text);
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
        where model not in ('claude-opus-5-5', 'claude-sonnet-5-5')))) is distinct from current_setting('rre.counts_before', true) then
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
  raise notice 'Post-install self-check passed: two inactive Anthropic price rows added; spending disabled; nothing else changed.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-6c', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261020120000_stage2a6c_model_prices.sql', 'sha256', '7de13fe100c4a470e4727f8fd6f4950ec5c946532d76ad14331429c8b2674b88'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5d-3a DEPLOYMENT (single transaction)
-- GENERATED FILE — do not edit. Rebuild: supabase/scripts/build-deploy-2a5d3a.sh
--
-- Run ONCE in the Supabase SQL Editor of the STAGING project, as one query,
-- AFTER Stage 2A-5d-2. AI spending controls (database only): three private
-- tables (configuration, model prices, spending ledger), reservation before
-- any provider call, a dispatch record before each call, settlement from that
-- record, a founder-only summary. Spending is DISABLED after deployment (USD 20
-- budget, stop at USD 18, USD 1 per analysis, 10/founder/24h, 3/case/24h, 10/case).
-- internal_complete_analysis and founder_abandon_analysis gain settlement only.
-- No AI is connected; only the fake provider (price 0) is priced. No existing
-- data is changed. All-or-nothing. Contains no credentials.
-- Refuses to run unless 2A-5d-2 is applied and both functions are exactly the
-- reviewed versions, or if 2A-5d-3a is already applied.
-- Undo: deploy/stage2a5d3a_rollback.sql. Check: deploy/stage2a5d3a_verify.sql.
--
-- Source migration (sha256):
--   20261018120000_stage2a5d3a_ai_spending.sql  b988bb6c522eac7c82d03005f5cfc7742e93f2b80e4dd9c6bbb87b0e5b373535
-- ===================================================================

begin;

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

-- >>>>>>>>>>>>>>>>>>>> BEGIN MIGRATION 20261018120000_stage2a5d3a_ai_spending.sql >>>>>>>>>>>>>>>>>>>>
-- Stage 2A-5d-3a — server-enforced AI spending controls (database only). No AI is
-- connected; no provider credential exists. Synthetic data only.
--
-- Money is reserved BEFORE any provider call and settled AFTER, from a dispatch
-- record the database writes before each call. The database never trusts a
-- caller-supplied amount:
--
--  * private.ai_spend_config   one row: budget $20, new reservations stop at $18
--                              committed, at most $1 per analysis, 10 attempts per
--                              founder and 3 per case per rolling 24 h, 10 per case
--                              in total, spending DISABLED until an administrator
--                              enables it (SQL editor only; no API can change it).
--  * private.ai_model_prices   per-model input/output prices and output cap. Only
--                              the fake provider (price 0) is seeded; a real model
--                              needs a deliberate row with verified prices.
--  * private.ai_spend_ledger   one reservation per analysis attempt, with the prices
--                              snapshotted, per-role dispatch timestamps and usage,
--                              and its settlement. Kept forever (no API access).
--
-- Reservation (internal_reserve_ai_spend, service role): computed by the database
-- from the analysis's evidence snapshot, separately for each call, at each model's
-- own prices and output cap:
--   E     = text_token_factor × UTF-8 bytes of the snapshot's messages
--           + message_overhead_tokens × messages + image_tokens × screenshots
--   A_in  = prompt_overhead_tokens + E                       A_out = analyst cap
--   R_in  = prompt_overhead_tokens + E + analyst_output_factor × A_out
--                                                            R_out = reviewer cap
--   reserved = ⌈A_in·a_in + A_out·a_out + R_in·r_in + R_out·r_out⌉ / 1e6 (to $0.0001)
-- Refused (nothing written) if spending is disabled, a model is unknown or inactive,
-- the snapshot cannot be measured, a rate limit is reached, the reservation exceeds
-- $1, or committed + reservation would exceed $18. All reservations serialise on the
-- config row, so concurrent requests cannot overshoot.
--
-- Dispatch (internal_ai_dispatch, service role): MUST be called, and must succeed,
-- before each provider request. It commits the dispatch time first, so the record
-- exists before any request can leave. Each role (ANALYST, then REVIEWER) can be
-- dispatched once: no retries inside a reservation. If the dispatch call's outcome
-- is unknown the caller must not call the provider (the database then holds the
-- reservation — the safe direction).
-- Usage (internal_ai_report_usage, service role): per role, once, only if dispatched.
--
-- Settlement (private.ai_settle, from internal_complete_analysis and
-- founder_abandon_analysis — never from caller-reported zeros):
--   no role dispatched                      -> SETTLED at $0 (no request could have left)
--   every dispatched role reported usage    -> SETTLED at Σ tokens × that role's snapshotted prices
--   any dispatched role without usage        -> HELD at the full reservation (crash, timeout,
--                                             network failure, abandoned): only an
--                                             administrator's reconciliation releases it
--   actual above the reservation             -> recorded as actual, flagged, and spending is disabled
-- Committed spend = SETTLED/RECONCILED actual + everything else at max(reservation, known usage).
-- Reconciliation (private.ai_reconcile): database owner only (SQL editor), audited.
--
-- Founders read a summary (founder_ai_spend_summary); business users and anonymous
-- callers have no access to anything here. internal_complete_analysis keeps every
-- check it had (contract, staleness, restriction preservation) and only adds
-- settlement. Rollback: supabase/deploy/stage2a5d3a_rollback.sql (keeps the records).

-- ---------------------------------------------------------------- private tables (no API access)
create table if not exists private.ai_spend_config (
  id boolean primary key default true check (id),
  budget_usd numeric(10,4) not null default 20 check (budget_usd >= 0),
  stop_at_usd numeric(10,4) not null default 18 check (stop_at_usd >= 0),
  max_reservation_usd numeric(10,4) not null default 1 check (max_reservation_usd > 0),
  founder_attempts_24h integer not null default 10 check (founder_attempts_24h >= 0),
  case_attempts_24h integer not null default 3 check (case_attempts_24h >= 0),
  case_attempts_total integer not null default 10 check (case_attempts_total >= 0),
  enabled boolean not null default false,
  prompt_overhead_tokens integer not null default 8000 check (prompt_overhead_tokens > 0),
  text_token_factor numeric(6,2) not null default 6 check (text_token_factor >= 1),
  message_overhead_tokens integer not null default 64 check (message_overhead_tokens >= 0),
  image_tokens integer not null default 5000 check (image_tokens > 0),
  analyst_output_factor numeric(6,2) not null default 2 check (analyst_output_factor >= 1),
  updated_at timestamptz not null default now(),
  check (stop_at_usd <= budget_usd)
);
insert into private.ai_spend_config (id) values (true) on conflict (id) do nothing;

create table if not exists private.ai_model_prices (
  model text primary key check (char_length(model) between 1 and 100),
  input_usd_per_mtok numeric(12,6) not null check (input_usd_per_mtok >= 0),
  output_usd_per_mtok numeric(12,6) not null check (output_usd_per_mtok >= 0),
  max_output_tokens integer not null check (max_output_tokens between 1 and 128000),
  active boolean not null default false,
  note text check (note is null or char_length(note) <= 500)
);
insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note)
values ('FAKE-PROVIDER-NOT-AI', 0, 0, 1, true, 'Stage 2A-5d-4b fake provider: no AI, no cost')
on conflict (model) do nothing;

-- No foreign keys: spending records outlive any analysis or case deletion.
create table if not exists private.ai_spend_ledger (
  analysis_id uuid primary key,
  case_id uuid not null,
  business_id uuid not null,
  founder_id uuid not null,
  analyst_model text not null,
  reviewer_model text not null,
  analyst_input_bound integer not null check (analyst_input_bound > 0),
  analyst_max_output integer not null check (analyst_max_output > 0),
  reviewer_input_bound integer not null check (reviewer_input_bound > 0),
  reviewer_max_output integer not null check (reviewer_max_output > 0),
  analyst_in_price numeric(12,6) not null,
  analyst_out_price numeric(12,6) not null,
  reviewer_in_price numeric(12,6) not null,
  reviewer_out_price numeric(12,6) not null,
  reserved_usd numeric(10,4) not null check (reserved_usd >= 0),
  analyst_dispatched_at timestamptz,
  reviewer_dispatched_at timestamptz,
  analyst_input_tokens integer check (analyst_input_tokens >= 0),
  analyst_output_tokens integer check (analyst_output_tokens >= 0),
  reviewer_input_tokens integer check (reviewer_input_tokens >= 0),
  reviewer_output_tokens integer check (reviewer_output_tokens >= 0),
  status text not null default 'RESERVED' check (status in ('RESERVED', 'SETTLED', 'HELD', 'RECONCILED')),
  actual_usd numeric(10,4) check (actual_usd >= 0),
  overrun boolean not null default false,
  settled_by text check (settled_by in ('NO_DISPATCH', 'REPORTED_USAGE', 'UNKNOWN_USAGE', 'RECONCILIATION')),
  reconciliation_note text check (reconciliation_note is null or char_length(reconciliation_note) <= 1000),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (reviewer_dispatched_at is null or analyst_dispatched_at is not null),
  check ((analyst_input_tokens is null) = (analyst_output_tokens is null) and (analyst_input_tokens is null or analyst_dispatched_at is not null)),
  check ((reviewer_input_tokens is null) = (reviewer_output_tokens is null) and (reviewer_input_tokens is null or reviewer_dispatched_at is not null)),
  check (status not in ('SETTLED', 'RECONCILED') or actual_usd is not null)
);
create index if not exists ai_spend_ledger_founder_idx on private.ai_spend_ledger (founder_id, created_at);
create index if not exists ai_spend_ledger_case_idx on private.ai_spend_ledger (case_id, created_at);

alter table private.ai_spend_config enable row level security;
alter table private.ai_model_prices enable row level security;
alter table private.ai_spend_ledger enable row level security;
revoke all on table private.ai_spend_config, private.ai_model_prices, private.ai_spend_ledger
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- helpers (private, no API access)
-- The conservative cost of one analysis attempt (both calls), in USD rounded UP to $0.0001.
create or replace function private.ai_estimate_usd(
  p_text_bytes bigint, p_messages integer, p_screenshots integer,
  p_analyst private.ai_model_prices, p_reviewer private.ai_model_prices, p_cfg private.ai_spend_config
) returns jsonb
language plpgsql immutable security definer set search_path = '' as $$
declare
  v_e numeric := p_cfg.text_token_factor * greatest(p_text_bytes, 0) + p_cfg.message_overhead_tokens * greatest(p_messages, 0)
                 + p_cfg.image_tokens * greatest(p_screenshots, 0);
  v_a_in numeric := p_cfg.prompt_overhead_tokens + v_e;
  v_a_out numeric := p_analyst.max_output_tokens;
  v_r_in numeric := p_cfg.prompt_overhead_tokens + v_e + p_cfg.analyst_output_factor * p_analyst.max_output_tokens;
  v_r_out numeric := p_reviewer.max_output_tokens;
  v_usd numeric;
begin
  v_usd := (v_a_in * p_analyst.input_usd_per_mtok + v_a_out * p_analyst.output_usd_per_mtok
            + v_r_in * p_reviewer.input_usd_per_mtok + v_r_out * p_reviewer.output_usd_per_mtok) / 1000000;
  return jsonb_build_object('usd', ceil(v_usd * 10000) / 10000,
    'analyst_input_bound', ceil(v_a_in), 'analyst_max_output', v_a_out,
    'reviewer_input_bound', ceil(v_r_in), 'reviewer_max_output', v_r_out);
end $$;

-- Committed spend: settled/reconciled actuals + everything else at max(reservation, known usage).
create or replace function private.ai_committed_usd() returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case when l.status in ('SETTLED', 'RECONCILED') then l.actual_usd
                           else greatest(l.reserved_usd, coalesce(l.actual_usd, 0)) end), 0)
  from private.ai_spend_ledger l
$$;

-- Settles a reservation from the dispatch record. Never raises: it must not stop the
-- analysis from being recorded. Callers hold the analysis row lock.
create or replace function private.ai_settle(p_analysis_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_l private.ai_spend_ledger;
  v_known numeric := 0;
  v_complete boolean;
  v_actual numeric;
begin
  select * into v_l from private.ai_spend_ledger where analysis_id = p_analysis_id for update;
  if not found or v_l.status <> 'RESERVED' then
    return;
  end if;
  if v_l.analyst_dispatched_at is null and v_l.reviewer_dispatched_at is null then
    -- The database recorded no dispatch, and no request may be sent without one.
    update private.ai_spend_ledger set status = 'SETTLED', actual_usd = 0, settled_by = 'NO_DISPATCH', settled_at = now()
    where analysis_id = p_analysis_id;
    perform private.audit('AI_SPEND_SETTLED', v_l.case_id, v_l.business_id, 'SYSTEM', null,
      jsonb_build_object('analysis_id', p_analysis_id, 'status', 'SETTLED', 'settled_by', 'NO_DISPATCH', 'actual_usd', 0));
    return;
  end if;
  if v_l.analyst_input_tokens is not null then
    v_known := v_known + (v_l.analyst_input_tokens * v_l.analyst_in_price + v_l.analyst_output_tokens * v_l.analyst_out_price) / 1000000;
  end if;
  if v_l.reviewer_input_tokens is not null then
    v_known := v_known + (v_l.reviewer_input_tokens * v_l.reviewer_in_price + v_l.reviewer_output_tokens * v_l.reviewer_out_price) / 1000000;
  end if;
  v_actual := ceil(v_known * 10000) / 10000;
  v_complete := (v_l.analyst_dispatched_at is null or v_l.analyst_input_tokens is not null)
            and (v_l.reviewer_dispatched_at is null or v_l.reviewer_input_tokens is not null);
  update private.ai_spend_ledger set
    status = case when v_complete then 'SETTLED' else 'HELD' end,
    actual_usd = v_actual,
    settled_by = case when v_complete then 'REPORTED_USAGE' else 'UNKNOWN_USAGE' end,
    overrun = v_actual > v_l.reserved_usd,
    settled_at = now()
  where analysis_id = p_analysis_id;
  if v_actual > v_l.reserved_usd then
    -- A bound was wrong: stop all further spending until an administrator looks.
    update private.ai_spend_config set enabled = false, updated_at = now() where id;
    perform private.audit('AI_SPEND_OVERRUN', v_l.case_id, v_l.business_id, 'SYSTEM', null,
      jsonb_build_object('analysis_id', p_analysis_id, 'reserved_usd', v_l.reserved_usd, 'actual_usd', v_actual, 'spending_disabled', true));
  end if;
  perform private.audit('AI_SPEND_SETTLED', v_l.case_id, v_l.business_id, 'SYSTEM', null,
    jsonb_build_object('analysis_id', p_analysis_id, 'status', case when v_complete then 'SETTLED' else 'HELD' end,
                       'settled_by', case when v_complete then 'REPORTED_USAGE' else 'UNKNOWN_USAGE' end,
                       'reserved_usd', v_l.reserved_usd, 'known_usd', v_actual));
end $$;

-- Releases a HELD (or stuck) reservation at the amount the provider actually billed.
-- Database owner only (SQL editor): no API role can execute it.
create or replace function private.ai_reconcile(p_analysis_id uuid, p_actual_usd numeric, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_l private.ai_spend_ledger;
begin
  select * into v_l from private.ai_spend_ledger where analysis_id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'no reservation for this analysis');
  end if;
  if v_l.status not in ('HELD', 'RESERVED')
     or (v_l.status = 'RESERVED' and exists (select 1 from public.analyses a where a.id = p_analysis_id and a.status = 'PENDING')) then
    perform private.fail('INVALID_STATE', 'only a held reservation, or one whose analysis is no longer running, can be reconciled');
  end if;
  if p_actual_usd is null or p_actual_usd < 0 or p_actual_usd > 1000 then
    perform private.fail('VALIDATION', 'actual amount must be between 0 and 1000 USD');
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 20 then
    perform private.fail('VALIDATION', 'explain the source of the amount (at least 20 characters)');
  end if;
  update private.ai_spend_ledger set status = 'RECONCILED', actual_usd = round(p_actual_usd, 4), settled_by = 'RECONCILIATION',
    reconciliation_note = left(btrim(p_note), 1000), settled_at = now()
  where analysis_id = p_analysis_id;
  perform private.audit('AI_SPEND_RECONCILED', v_l.case_id, v_l.business_id, 'SYSTEM', null,
    jsonb_build_object('analysis_id', p_analysis_id, 'previous_status', v_l.status, 'reserved_usd', v_l.reserved_usd,
                       'actual_usd', round(p_actual_usd, 4), 'note', left(btrim(p_note), 1000)));
end $$;

-- ---------------------------------------------------------------- service-role API (the analysis pipeline)
create or replace function public.internal_reserve_ai_spend(p_analysis_id uuid, p_analyst_model text, p_reviewer_model text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_a public.analyses;
  v_cfg private.ai_spend_config;
  v_am private.ai_model_prices;
  v_rm private.ai_model_prices;
  v_m jsonb;
  v_ids text[];
  v_bytes bigint;
  v_found integer;
  v_shots integer;
  v_est jsonb;
  v_res numeric;
  v_committed numeric;
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
  select * into v_a from public.analyses where id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found');
  end if;
  if v_a.status <> 'PENDING' then
    perform private.fail('INVALID_STATE', 'analysis is not in progress');
  end if;
  if v_a.requested_by is null then
    perform private.fail('VALIDATION', 'analysis has no requesting founder');
  end if;
  if exists (select 1 from private.ai_spend_ledger where analysis_id = p_analysis_id) then
    perform private.fail('INVALID_STATE', 'spending already reserved for this analysis');
  end if;

  -- One reservation at a time, project-wide: the budget check and the insert are atomic.
  select * into v_cfg from private.ai_spend_config where id for update;
  if not found or not v_cfg.enabled then
    perform private.fail('SPENDING_DISABLED', 'AI spending is disabled');
  end if;
  select * into v_am from private.ai_model_prices where model = p_analyst_model and active;
  if not found then
    perform private.fail('MODEL_NOT_PRICED', 'analyst model has no active price');
  end if;
  select * into v_rm from private.ai_model_prices where model = p_reviewer_model and active;
  if not found then
    perform private.fail('MODEL_NOT_PRICED', 'reviewer model has no active price');
  end if;

  -- Measure the frozen evidence snapshot; anything unmeasurable refuses.
  v_m := v_a.evidence_manifest;
  if jsonb_typeof(v_m) is distinct from 'object' or v_m ->> 'manifest_version' is distinct from '2'
     or jsonb_typeof(v_m -> 'messages') is distinct from 'array' or jsonb_typeof(v_m -> 'screenshots') is distinct from 'array' then
    perform private.fail('VALIDATION', 'evidence snapshot cannot be measured');
  end if;
  select coalesce(array_agg(e ->> 'id'), '{}') into v_ids from jsonb_array_elements(v_m -> 'messages') e;
  select coalesce(sum(octet_length(m.body)), 0), count(*) into v_bytes, v_found
  from public.case_messages m where m.case_id = v_a.case_id and m.id::text = any (v_ids);
  if v_found <> cardinality(v_ids) then
    perform private.fail('VALIDATION', 'evidence snapshot cannot be measured');
  end if;
  v_shots := jsonb_array_length(v_m -> 'screenshots');

  -- Rate limits (attempts = reservations).
  if (select count(*) from private.ai_spend_ledger where founder_id = v_a.requested_by and created_at > now() - interval '24 hours')
     >= v_cfg.founder_attempts_24h then
    perform private.fail('RATE_LIMITED', format('founder analysis limit reached (%s per 24 hours)', v_cfg.founder_attempts_24h));
  end if;
  if (select count(*) from private.ai_spend_ledger where case_id = v_a.case_id and created_at > now() - interval '24 hours')
     >= v_cfg.case_attempts_24h then
    perform private.fail('RATE_LIMITED', format('case analysis limit reached (%s per 24 hours)', v_cfg.case_attempts_24h));
  end if;
  if (select count(*) from private.ai_spend_ledger where case_id = v_a.case_id) >= v_cfg.case_attempts_total then
    perform private.fail('RATE_LIMITED', format('case analysis limit reached (%s in total)', v_cfg.case_attempts_total));
  end if;

  v_est := private.ai_estimate_usd(v_bytes, cardinality(v_ids), v_shots, v_am, v_rm, v_cfg);
  v_res := (v_est ->> 'usd')::numeric;
  if v_res > v_cfg.max_reservation_usd then
    perform private.fail('RESERVATION_TOO_LARGE', format('this analysis could cost up to %s USD (limit %s)', v_res, v_cfg.max_reservation_usd));
  end if;
  v_committed := private.ai_committed_usd();
  if v_committed + v_res > v_cfg.stop_at_usd then
    perform private.fail('BUDGET_EXCEEDED', 'the spending budget does not allow another analysis');
  end if;

  insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model,
    analyst_input_bound, analyst_max_output, reviewer_input_bound, reviewer_max_output,
    analyst_in_price, analyst_out_price, reviewer_in_price, reviewer_out_price, reserved_usd)
  values (v_a.id, v_a.case_id, v_a.business_id, v_a.requested_by, v_am.model, v_rm.model,
    (v_est ->> 'analyst_input_bound')::integer, v_am.max_output_tokens, (v_est ->> 'reviewer_input_bound')::integer, v_rm.max_output_tokens,
    v_am.input_usd_per_mtok, v_am.output_usd_per_mtok, v_rm.input_usd_per_mtok, v_rm.output_usd_per_mtok, v_res);
  perform private.audit('AI_SPEND_RESERVED', v_a.case_id, v_a.business_id, 'SERVICE', null,
    jsonb_build_object('analysis_id', v_a.id, 'reserved_usd', v_res, 'analyst_model', v_am.model, 'reviewer_model', v_rm.model));
  return jsonb_build_object('reserved_usd', v_res,
    'analyst', jsonb_build_object('model', v_am.model, 'max_output_tokens', v_am.max_output_tokens),
    'reviewer', jsonb_build_object('model', v_rm.model, 'max_output_tokens', v_rm.max_output_tokens));
end $$;

-- Records that a provider request is about to be sent. Must succeed (and be committed)
-- before the request; once per role; analyst first.
create or replace function public.internal_ai_dispatch(p_analysis_id uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_l private.ai_spend_ledger;
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
  if p_role is null or p_role not in ('ANALYST', 'REVIEWER') then
    perform private.fail('VALIDATION', 'role must be ANALYST or REVIEWER');
  end if;
  select * into v_l from private.ai_spend_ledger where analysis_id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_RESERVED', 'no spending reservation for this analysis');
  end if;
  if v_l.status <> 'RESERVED' then
    perform private.fail('INVALID_STATE', 'the reservation is already settled');
  end if;
  if not exists (select 1 from public.analyses a where a.id = p_analysis_id and a.status = 'PENDING') then
    perform private.fail('INVALID_STATE', 'analysis is not in progress');
  end if;
  if p_role = 'ANALYST' then
    if v_l.analyst_dispatched_at is not null then
      perform private.fail('ALREADY_DISPATCHED', 'the analyst call was already dispatched (no retries)');
    end if;
    update private.ai_spend_ledger set analyst_dispatched_at = clock_timestamp() where analysis_id = p_analysis_id;
    return jsonb_build_object('model', v_l.analyst_model, 'max_output_tokens', v_l.analyst_max_output);
  end if;
  if v_l.analyst_dispatched_at is null or v_l.analyst_input_tokens is null then
    perform private.fail('INVALID_STATE', 'the reviewer runs only after the analyst call has reported its usage');
  end if;
  if v_l.reviewer_dispatched_at is not null then
    perform private.fail('ALREADY_DISPATCHED', 'the reviewer call was already dispatched (no retries)');
  end if;
  update private.ai_spend_ledger set reviewer_dispatched_at = clock_timestamp() where analysis_id = p_analysis_id;
  return jsonb_build_object('model', v_l.reviewer_model, 'max_output_tokens', v_l.reviewer_max_output);
end $$;

-- Records the usage the provider reported for one dispatched call (once).
create or replace function public.internal_ai_report_usage(p_analysis_id uuid, p_role text, p_input_tokens integer, p_output_tokens integer)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_l private.ai_spend_ledger;
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
  if p_role is null or p_role not in ('ANALYST', 'REVIEWER') then
    perform private.fail('VALIDATION', 'role must be ANALYST or REVIEWER');
  end if;
  if p_input_tokens is null or p_output_tokens is null or p_input_tokens < 0 or p_output_tokens < 0
     or p_input_tokens > 10000000 or p_output_tokens > 10000000 then
    perform private.fail('VALIDATION', 'token counts must be between 0 and 10,000,000');
  end if;
  select * into v_l from private.ai_spend_ledger where analysis_id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_RESERVED', 'no spending reservation for this analysis');
  end if;
  if v_l.status not in ('RESERVED', 'HELD') then
    perform private.fail('INVALID_STATE', 'the reservation is already settled');
  end if;
  if (p_role = 'ANALYST' and v_l.analyst_dispatched_at is null) or (p_role = 'REVIEWER' and v_l.reviewer_dispatched_at is null) then
    perform private.fail('NOT_DISPATCHED', 'usage can only be reported for a dispatched call');
  end if;
  if (p_role = 'ANALYST' and v_l.analyst_input_tokens is not null) or (p_role = 'REVIEWER' and v_l.reviewer_input_tokens is not null) then
    perform private.fail('ALREADY_REPORTED', 'usage for this call was already reported');
  end if;
  if p_role = 'ANALYST' then
    update private.ai_spend_ledger set analyst_input_tokens = p_input_tokens, analyst_output_tokens = p_output_tokens where analysis_id = p_analysis_id;
  else
    update private.ai_spend_ledger set reviewer_input_tokens = p_input_tokens, reviewer_output_tokens = p_output_tokens where analysis_id = p_analysis_id;
  end if;
end $$;

-- ---------------------------------------------------------------- founder: read-only summary
create or replace function public.founder_ai_spend_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg private.ai_spend_config;
  v_committed numeric;
begin
  perform private.require_founder();
  select * into v_cfg from private.ai_spend_config where id;
  v_committed := private.ai_committed_usd();
  return jsonb_build_object(
    'enabled', coalesce(v_cfg.enabled, false),
    'budget_usd', v_cfg.budget_usd, 'stop_at_usd', v_cfg.stop_at_usd, 'max_reservation_usd', v_cfg.max_reservation_usd,
    'committed_usd', v_committed,
    'remaining_before_stop_usd', greatest(coalesce(v_cfg.stop_at_usd, 0) - v_committed, 0),
    'limits', jsonb_build_object('founder_attempts_24h', v_cfg.founder_attempts_24h, 'case_attempts_24h', v_cfg.case_attempts_24h,
                                 'case_attempts_total', v_cfg.case_attempts_total),
    'attempts_last_24h', (select count(*) from private.ai_spend_ledger where founder_id = (select auth.uid()) and created_at > now() - interval '24 hours'),
    'open_reservations', (select count(*) from private.ai_spend_ledger where status = 'RESERVED'),
    'held_reservations', (select count(*) from private.ai_spend_ledger where status = 'HELD'),
    'overruns', (select count(*) from private.ai_spend_ledger where overrun));
end $$;

-- ---------------------------------------------------------------- settlement hooks in the two existing functions
-- internal_complete_analysis: the Stage 2A-5b version, plus settlement on every completion path.
create or replace function public.internal_complete_analysis(
  p_analysis_id uuid,
  p_status public.analysis_status,
  p_model text default null,
  p_prompt_version text default null,
  p_output jsonb default null,
  p_ai_classification public.classification default null,
  p_ai_proposed_message text default null,
  p_detected_restrictions jsonb default '[]'::jsonb,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_estimated_cost_usd numeric default null,
  p_error text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_analysis public.analyses;
  v_case public.cases;
  v_restrictions jsonb := coalesce(p_detected_restrictions, '[]'::jsonb);
  v_message text;
  v_item jsonb;
  v_problems text[];
  v_failure text;
  v_kept integer;
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
  select * into v_analysis from public.analyses where id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found');
  end if;
  if v_analysis.status <> 'PENDING' then
    perform private.fail('INVALID_STATE', 'analysis already completed');
  end if;
  if p_status = 'PENDING' then
    perform private.fail('VALIDATION', 'a completed analysis cannot be PENDING');
  end if;
  if jsonb_typeof(v_restrictions) is distinct from 'array' then
    perform private.fail('VALIDATION', 'detected restrictions must be an array');
  end if;
  select * into v_case from public.cases where id = v_analysis.case_id for update;

  if p_status = 'ERROR' then
    v_failure := coalesce(p_error, 'analysis failed');
  elsif v_case.evidence_version <> v_analysis.evidence_version or v_case.workflow_state <> 'ANALYZING' then
    v_failure := 'STALE: evidence changed during analysis';
  else
    v_problems := private.analysis_output_problems(v_analysis, p_status, p_output, p_ai_classification,
                                                   p_ai_proposed_message, v_restrictions);
    if cardinality(v_problems) > 0 then
      v_failure := 'REJECTED by analysis contract rre-analysis/1: ' || array_to_string(v_problems[1:10], '; ')
                   || case when cardinality(v_problems) > 10 then format(' (+%s more)', cardinality(v_problems) - 10) else '' end;
    end if;
  end if;

  if v_failure is not null then
    -- Nothing from a failed, stale or rejected analysis is kept as findings.
    update public.analyses set status = 'ERROR', error = left(v_failure, 2000),
      model = p_model, prompt_version = p_prompt_version, input_tokens = p_input_tokens,
      output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
    where id = v_analysis.id;
    update public.cases set workflow_state = v_analysis.prior_state
    where id = v_case.id and workflow_state = 'ANALYZING';
    -- Stage 2A-5b: a detected opt-out or contact restriction is a safety signal, not a
    -- finding. It is recorded even when the analysis itself is rejected, failed or stale.
    v_kept := private.preserve_detected_restrictions(v_case.id, v_restrictions, v_analysis.version);
    perform private.audit(case when v_problems is not null and cardinality(v_problems) > 0 then 'ANALYSIS_REJECTED' else 'ANALYSIS_FAILED' end,
      v_case.id, v_case.business_id, 'SERVICE', null,
      jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version, 'restrictions_preserved', v_kept)
      || case when cardinality(v_problems) > 0 then jsonb_build_object('problems', cardinality(v_problems)) else '{}'::jsonb end);
    -- Stage 2A-5d-3a: settle the spending reservation (if any) from the dispatch record.
    perform private.ai_settle(v_analysis.id);
    return;
  end if;

  -- Invariant: no proposed message for RED or when any restriction is detected.
  v_message := case when p_ai_classification = 'RED' or jsonb_array_length(v_restrictions) > 0 then null
                    else nullif(btrim(coalesce(p_ai_proposed_message, '')), '') end;

  update public.analyses set status = p_status, model = p_model, prompt_version = p_prompt_version, output = p_output,
    ai_classification = p_ai_classification, ai_proposed_message = v_message, input_tokens = p_input_tokens,
    output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
  where id = v_analysis.id;

  for v_item in select * from jsonb_array_elements(v_restrictions) loop
    insert into public.contact_restrictions (case_id, business_id, kind, source, note, evidence)
    values (v_case.id, v_case.business_id, (v_item ->> 'kind')::public.restriction_kind, 'AI_DETECTED',
            left(v_item ->> 'note', 1000), v_item -> 'evidence');
  end loop;

  update public.cases set workflow_state = 'AWAITING_ADMIN_REVIEW' where id = v_case.id;
  perform private.audit('ANALYSIS_COMPLETED', v_case.id, v_case.business_id, 'SERVICE', null,
    jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version, 'status', p_status,
                       'detected_restrictions', jsonb_array_length(v_restrictions)));
  -- Stage 2A-5d-3a: settle the spending reservation (if any) from the dispatch record.
  perform private.ai_settle(v_analysis.id);
end $$;

-- founder_abandon_analysis: the Stage 2A-1 version, plus settlement.
create or replace function public.founder_abandon_analysis(p_analysis_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_analysis public.analyses;
begin
  perform private.require_founder();
  select * into v_analysis from public.analyses where id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found');
  end if;
  if v_analysis.status <> 'PENDING' then
    perform private.fail('INVALID_STATE', 'analysis is not in progress');
  end if;
  update public.analyses set status = 'ERROR', error = 'Abandoned by founder', completed_at = now() where id = v_analysis.id;
  update public.cases set workflow_state = v_analysis.prior_state where id = v_analysis.case_id and workflow_state = 'ANALYZING';
  perform private.audit('ANALYSIS_ABANDONED', v_analysis.case_id, v_analysis.business_id, 'FOUNDER', null,
    jsonb_build_object('analysis_id', v_analysis.id));
  -- Stage 2A-5d-3a: settle the spending reservation (if any). Abandoning never releases
  -- money for a call that may have been dispatched: that stays HELD for reconciliation.
  perform private.ai_settle(v_analysis.id);
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on function private.ai_estimate_usd(bigint, integer, integer, private.ai_model_prices, private.ai_model_prices, private.ai_spend_config),
  private.ai_committed_usd(), private.ai_settle(uuid), private.ai_reconcile(uuid, numeric, text)
  from public, anon, authenticated, service_role;
revoke all on function public.internal_reserve_ai_spend(uuid, text, text), public.internal_ai_dispatch(uuid, text),
  public.internal_ai_report_usage(uuid, text, integer, integer), public.founder_ai_spend_summary()
  from public, anon, authenticated, service_role;
grant execute on function public.internal_reserve_ai_spend(uuid, text, text), public.internal_ai_dispatch(uuid, text),
  public.internal_ai_report_usage(uuid, text, integer, integer)
  to service_role;
grant execute on function public.founder_ai_spend_summary() to authenticated;
-- <<<<<<<<<<<<<<<<<<<< END MIGRATION 20261018120000_stage2a5d3a_ai_spending.sql <<<<<<<<<<<<<<<<<<<<

-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem rolls
-- everything back. The behavioural checks run in a sub-transaction on synthetic
-- ledger rows and are undone; nothing they write is kept.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_f text;
  v_ica text := (select prosrc from pg_proc where oid = 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure);
  v_abandon text := (select prosrc from pg_proc where oid = 'public.founder_abandon_analysis(uuid)'::regprocedure);
  v_cfg private.ai_spend_config;
  v_est numeric;
  v_ids uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_states text;
  v_disabled boolean;
begin
  -- Tables: private, RLS on, no policies, no privilege for any API role.
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relname in ('ai_spend_config', 'ai_model_prices', 'ai_spend_ledger') and c.relrowsecurity) <> 3
     or exists (select 1 from pg_policies where schemaname = 'private' and tablename in ('ai_spend_config', 'ai_model_prices', 'ai_spend_ledger'))
     or exists (select 1 from unnest(array['private.ai_spend_config', 'private.ai_model_prices', 'private.ai_spend_ledger']) t, unnest(array['anon', 'authenticated', 'service_role']) r
                where has_table_privilege(r, t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) then
    v_problems := array_append(v_problems, 'a spending table is not private (RLS, policies or API privileges)'::text);
  end if;
  -- Configuration: one sane row, spending OFF at deployment.
  select * into v_cfg from private.ai_spend_config where id;
  if not found or v_cfg.enabled or v_cfg.stop_at_usd > v_cfg.budget_usd or v_cfg.max_reservation_usd <= 0 then
    v_problems := array_append(v_problems, 'spending configuration missing, inconsistent, or enabled at deployment'::text);
  end if;
  if not exists (select 1 from private.ai_model_prices where model = 'FAKE-PROVIDER-NOT-AI' and active and input_usd_per_mtok = 0 and output_usd_per_mtok = 0) then
    v_problems := array_append(v_problems, 'the fake provider price row is missing or not zero'::text);
  end if;
  -- Functions: definer, pinned search_path, exact privileges.
  foreach v_f in array array['private.ai_estimate_usd(bigint, integer, integer, private.ai_model_prices, private.ai_model_prices, private.ai_spend_config)',
                             'private.ai_committed_usd()', 'private.ai_settle(uuid)', 'private.ai_reconcile(uuid, numeric, text)',
                             'public.internal_reserve_ai_spend(uuid, text, text)', 'public.internal_ai_dispatch(uuid, text)',
                             'public.internal_ai_report_usage(uuid, text, integer, integer)', 'public.founder_ai_spend_summary()'] loop
    if to_regprocedure(v_f) is null or not coalesce((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = to_regprocedure(v_f)), false)
       or has_function_privilege('anon', to_regprocedure(v_f), 'EXECUTE')
       or (v_f like 'private.%' and (has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') or has_function_privilege('service_role', to_regprocedure(v_f), 'EXECUTE')))
       or (v_f like 'public.internal_%' and (has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') or not has_function_privilege('service_role', to_regprocedure(v_f), 'EXECUTE')))
       or (v_f = 'public.founder_ai_spend_summary()' and (not has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') or has_function_privilege('service_role', to_regprocedure(v_f), 'EXECUTE'))) then
      v_problems := array_append(v_problems, v_f || ' is missing, has the wrong privileges, or does not pin search_path');
    end if;
  end loop;
  -- The two existing functions keep everything and add settlement.
  if v_ica not like '%private.analysis_output_problems(%' or v_ica not like '%REJECTED by analysis contract rre-analysis/1%'
     or v_ica not like '%private.preserve_detected_restrictions(%' or (length(v_ica) - length(replace(v_ica, 'private.ai_settle(', ''))) / length('private.ai_settle(') <> 2
     or v_abandon not like '%private.ai_settle(%' or v_abandon not like '%private.require_founder()%'
     or not has_function_privilege('service_role', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.founder_abandon_analysis(uuid)', 'EXECUTE') then
    v_problems := array_append(v_problems, 'internal_complete_analysis or founder_abandon_analysis lost a check, settlement or its privileges'::text);
  end if;
  -- Behaviour: estimator (pure) ...
  v_est := (private.ai_estimate_usd(100, 1, 0, row('t-a', 1, 5, 1000, true, null)::private.ai_model_prices,
            row('t-r', 10, 50, 2000, true, null)::private.ai_model_prices,
            row(true, 20, 18, 1, 10, 3, 10, false, 8000, 6, 64, 5000, 2, now())::private.ai_spend_config) ->> 'usd')::numeric;
  if v_est is distinct from 0.2204 then
    v_problems := array_append(v_problems, format('the reservation estimate does not behave as reviewed (%s)', v_est));
  end if;
  -- ... and settlement, on synthetic ledger rows inside a sub-transaction that is undone.
  begin
    -- Enabled inside the undone sub-transaction, so the overrun check can prove it disables spending.
    update private.ai_spend_config set enabled = true where id;
    insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model, analyst_input_bound, analyst_max_output,
      reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price, reviewer_out_price, reserved_usd,
      analyst_dispatched_at, analyst_input_tokens, analyst_output_tokens)
    select id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 't-a', 't-r', 1, 1, 1, 1, 1, 5, 10, 50, 0.5,
           case when i > 1 then now() end, case when i in (3, 4) then (case i when 3 then 1000 else 2000000 end) end,
           case when i in (3, 4) then 100 end
    from unnest(v_ids) with ordinality t(id, i);
    perform private.ai_settle(id) from unnest(v_ids) id;
    select string_agg(status || ':' || settled_by || ':' || actual_usd || ':' || overrun, ',' order by array_position(v_ids, analysis_id))
      into v_states from private.ai_spend_ledger where analysis_id = any (v_ids);
    select not enabled into v_disabled from private.ai_spend_config where id;
    raise exception 'SELFTEST_UNDO';
  exception when others then
    if sqlerrm <> 'SELFTEST_UNDO' then
      v_problems := array_append(v_problems, 'the settlement self-test failed to run'::text);
    end if;
  end;
  if v_states is distinct from 'SETTLED:NO_DISPATCH:0.0000:false,HELD:UNKNOWN_USAGE:0.0000:false,SETTLED:REPORTED_USAGE:0.0015:false,SETTLED:REPORTED_USAGE:2.0005:true'
     or not coalesce(v_disabled, false) then
    v_problems := array_append(v_problems, format('settlement does not behave as reviewed (%s)', coalesce(v_states, 'none')));
  end if;
  if exists (select 1 from private.ai_spend_ledger where analysis_id = any (v_ids)) or (select enabled from private.ai_spend_config where id) then
    v_problems := array_append(v_problems, 'the self-test left something behind'::text);
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
             and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%')) then
    v_problems := array_append(v_problems, 'analyses or contact_restrictions are no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: spending controls installed and DISABLED; contract, restrictions and founder-only access unchanged.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_DEPLOYED', jsonb_build_object('stage', '2A-5d-3a', 'migrations', jsonb_build_array(
  jsonb_build_object('file', '20261018120000_stage2a5d3a_ai_spending.sql', 'sha256', 'b988bb6c522eac7c82d03005f5cfc7742e93f2b80e4dd9c6bbb87b0e5b373535'))));

commit;
-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.

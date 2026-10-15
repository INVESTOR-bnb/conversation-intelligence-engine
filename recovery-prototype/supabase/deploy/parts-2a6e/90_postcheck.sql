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

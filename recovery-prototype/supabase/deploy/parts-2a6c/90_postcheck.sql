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

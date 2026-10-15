-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-6d: PAID PROVIDER OFF (database part)
-- Emergency / recovery only. Safe to run any number of times. Changes exactly two
-- things: spending is DISABLED, and every paid model (the two Anthropic models and
-- kimi-k3) is made INACTIVE (so nothing can be reserved for them). Prices, the fake
-- provider, the ledger and all data are untouched.
-- The provider key is NOT in the database: also delete the function secrets
-- ANTHROPIC_API_KEY, KIMI_API_KEY, ALLOW_PAID_PROVIDER, ANALYST_MODEL, REVIEWER_MODEL,
-- ANTHROPIC_EFFORT (Supabase dashboard → Edge Functions → Secrets), set
-- ANALYSIS_PROVIDER=fake, and revoke the key in the Anthropic or Kimi console. Or run: bash supabase/scripts/paid-pipeline-e2e.sh --paid-off
-- ===================================================================
update private.ai_spend_config set enabled = false, updated_at = now() where id;
update private.ai_model_prices set active = false where model in ('claude-opus-5-5', 'claude-sonnet-5-5', 'kimi-k3');
select (select enabled from private.ai_spend_config where id) as spending_enabled,
       (select coalesce(string_agg(model, ', ' order by model), 'none') from private.ai_model_prices where active) as active_models;
-- Expected: spending_enabled = false, active_models = FAKE-PROVIDER-NOT-AI

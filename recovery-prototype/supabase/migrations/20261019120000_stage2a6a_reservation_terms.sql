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

-- Removes the WhatsApp integration bundle (functions and data) from the ISOLATED environment.
-- Nothing else depends on it. Imported cases stay as ordinary RRE cases (delete them separately if wanted).
begin;
drop function if exists public.founder_wa_resolve_unknown(uuid, boolean, text), public.founder_wa_overview(), public.founder_wa_set_sending(boolean),
  public.client_wa_takeover(uuid), public.client_wa_set_permission(uuid, boolean, text), public.client_wa_contacts(), public.client_wa_disconnect(),
  public.client_wa_pause(boolean), public.client_wa_authorize(text, integer, text, integer, integer, numeric, text, text, text), public.client_wa_status(),
  public.internal_wa_finish_send(uuid, text, text, text), public.internal_wa_claim_sends(integer), public.internal_wa_plan_sends(),
  public.internal_wa_import_cases(uuid, integer), public.internal_wa_ingest(jsonb), public.internal_wa_connection(uuid),
  public.internal_wa_set_connection_status(uuid, text, text), public.internal_wa_record_connection(uuid, uuid, text, text, text, text, text, text),
  public.internal_wa_business_for_number(text), public.internal_wa_active_businesses(), public.internal_wa_mark_history_requested(uuid),
  public.internal_wa_has_authorization(uuid), public.internal_wa_apply_late_history(uuid), private.wa_finish(uuid, text, text, text), private.wa_block_reason(private.wa_sends),
  private.wa_cancel_pending(uuid, text), private.wa_active_auth(uuid), private.wa_my_business(), private.wa_require_service();
drop table if exists private.wa_sends, private.wa_history_chunks, private.wa_messages, private.wa_contacts, private.wa_authorizations,
  private.wa_connections, private.wa_price_estimates, private.wa_settings;
commit;

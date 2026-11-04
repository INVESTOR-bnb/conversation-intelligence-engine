-- Removes the WhatsApp feasibility test from the database (all its functions and data).
-- Nothing else in RRE depends on it. Run as the database owner (SQL editor), in one transaction.
begin;
drop function if exists public.founder_wa_test_summary();
drop function if exists public.internal_wa_register_number(text, text, uuid, uuid);
drop function if exists public.internal_wa_last_inbound_at(text, text);
drop function if exists public.internal_wa_finish_send(uuid, text, text, text);
drop function if exists public.internal_wa_reserve_send(uuid, text, text, uuid);
drop function if exists public.internal_wa_record_events(jsonb);
drop function if exists public.internal_wa_business_for_number(text);
drop function if exists private.wa_require_service();
drop table if exists private.wa_test_outbound;
drop table if exists private.wa_test_events;
drop table if exists private.wa_test_numbers;
commit;

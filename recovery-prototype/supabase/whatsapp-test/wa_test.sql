-- WhatsApp FEASIBILITY TEST — isolated, NOT a migration. Applied only by an explicit, approved
-- step (it is not in supabase/migrations and no deploy script installs it). Remove with
-- supabase/whatsapp-test/wa_test_remove.sql.
--
-- Stores what the test must observe and nothing more:
--   * which WhatsApp phone number belongs to which RRE business (server-side isolation);
--   * webhook events as METADATA: kind, message id, status, time, a keyed hash of the customer's
--     WhatsApp id. Message text is stored ONLY for the one consenting test contact. Chat-history
--     webhooks are stored as COUNTS (threads, messages, types, date range) — never content;
--   * the controlled test sends: one row per idempotency key, at most 3 per number in total.
-- No business user can read or write any of it; the founder reads a summary; the Edge Function
-- writes through service-role functions only.

create table private.wa_test_numbers (
  phone_number_id text primary key check (phone_number_id ~ '^[0-9]{5,30}$'),
  waba_id text not null check (waba_id ~ '^[0-9]{5,30}$'),
  business_id uuid not null references public.businesses (id),
  registered_by uuid not null,
  created_at timestamptz not null default now()
);

create table private.wa_test_events (
  id bigint generated always as identity primary key,
  dedupe_key text not null unique check (char_length(dedupe_key) between 3 and 300),
  phone_number_id text not null references private.wa_test_numbers (phone_number_id),
  business_id uuid not null references public.businesses (id),
  kind text not null check (kind in ('INBOUND', 'STATUS', 'ECHO', 'HISTORY', 'HISTORY_DECLINED', 'CONTACT_SYNC')),
  contact_hash text check (contact_hash is null or contact_hash ~ '^[0-9a-f]{64}$'),
  is_test_contact boolean not null default false,
  wa_message_id text check (wa_message_id is null or char_length(wa_message_id) <= 200),
  reply_to text check (reply_to is null or char_length(reply_to) <= 200),
  status text check (status is null or char_length(status) <= 40),
  body text check (body is null or char_length(body) <= 4096),
  summary jsonb,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  check (body is null or (is_test_contact and kind in ('INBOUND', 'ECHO')))
);
create index wa_test_events_conv_idx on private.wa_test_events (business_id, contact_hash, occurred_at);

create table private.wa_test_outbound (
  idempotency_key uuid primary key,
  phone_number_id text not null references private.wa_test_numbers (phone_number_id),
  business_id uuid not null references public.businesses (id),
  mode text not null check (mode in ('TEXT', 'TEMPLATE')),
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'FAILED')),
  wa_message_id text check (wa_message_id is null or char_length(wa_message_id) <= 200),
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table private.wa_test_numbers enable row level security;
alter table private.wa_test_events enable row level security;
alter table private.wa_test_outbound enable row level security;
revoke all on table private.wa_test_numbers, private.wa_test_events, private.wa_test_outbound
  from public, anon, authenticated, service_role;

create function private.wa_require_service() returns void language plpgsql stable set search_path = '' as $$
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
end $$;

-- ---------------------------------------------------------------- service role (the Edge Function)
create function public.internal_wa_business_for_number(p_phone_number_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  return (select business_id from private.wa_test_numbers where phone_number_id = p_phone_number_id);
end $$;

-- Records events; a duplicate (same dedupe_key: a webhook retry or replay) changes nothing.
-- The business is always taken from the server-side number mapping, never from the caller.
create function public.internal_wa_record_events(p_events jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_e jsonb;
  v_business uuid;
  v_n integer := 0;
  v_rows integer;
begin
  perform private.wa_require_service();
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 500 then
    perform private.fail('VALIDATION', 'events must be an array of at most 500');
  end if;
  for v_e in select * from jsonb_array_elements(p_events) loop
    select business_id into v_business from private.wa_test_numbers where phone_number_id = v_e ->> 'phone_number_id';
    if v_business is null then continue; end if; -- an unknown number is never stored
    insert into private.wa_test_events (dedupe_key, phone_number_id, business_id, kind, contact_hash, is_test_contact,
                                        wa_message_id, reply_to, status, body, summary, occurred_at)
    values (v_e ->> 'dedupe_key', v_e ->> 'phone_number_id', v_business, v_e ->> 'kind', v_e ->> 'contact_hash',
            coalesce((v_e ->> 'is_test_contact')::boolean, false), v_e ->> 'wa_message_id', v_e ->> 'reply_to', v_e ->> 'status',
            v_e ->> 'body', v_e -> 'summary', to_timestamp(nullif(v_e ->> 'occurred_at', '')::double precision))
    on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  return v_n;
end $$;

-- Reserves one controlled send. 'NEW' only for a new key under the cap; a repeated key returns
-- 'DUPLICATE' (never sent twice); more than 3 sends per number in total returns 'CAP_REACHED'.
create function public.internal_wa_reserve_send(p_key uuid, p_phone_number_id text, p_mode text, p_requested_by uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_business uuid;
begin
  perform private.wa_require_service();
  perform pg_advisory_xact_lock(hashtext('rre-wa-test-send:' || coalesce(p_phone_number_id, '')));
  if exists (select 1 from private.wa_test_outbound where idempotency_key = p_key) then return 'DUPLICATE'; end if;
  select business_id into v_business from private.wa_test_numbers where phone_number_id = p_phone_number_id;
  if v_business is null then return 'UNKNOWN_NUMBER'; end if;
  if (select count(*) from private.wa_test_outbound where phone_number_id = p_phone_number_id) >= 3 then return 'CAP_REACHED'; end if;
  insert into private.wa_test_outbound (idempotency_key, phone_number_id, business_id, mode, requested_by)
  values (p_key, p_phone_number_id, v_business, p_mode, p_requested_by);
  return 'NEW';
end $$;

create function public.internal_wa_finish_send(p_key uuid, p_status text, p_wa_message_id text, p_error_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  update private.wa_test_outbound set status = p_status, wa_message_id = p_wa_message_id, error_code = p_error_code, finished_at = now()
   where idempotency_key = p_key and status = 'PENDING';
end $$;

-- The last time the test contact wrote to this number (the 24-hour customer-service window).
create function public.internal_wa_last_inbound_at(p_phone_number_id text, p_contact_hash text) returns timestamptz
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  return (select max(occurred_at) from private.wa_test_events
           where phone_number_id = p_phone_number_id and contact_hash = p_contact_hash and kind = 'INBOUND');
end $$;

-- Maps a number to a business after the founder completed onboarding (called by the Edge
-- Function on the founder's behalf, with the founder id it verified).
create function public.internal_wa_register_number(p_phone_number_id text, p_waba_id text, p_business_id uuid, p_founder uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  if not exists (select 1 from public.founders where user_id = p_founder) then perform private.fail('FORBIDDEN', 'founder only'); end if;
  if not exists (select 1 from public.businesses where id = p_business_id) then perform private.fail('NOT_FOUND', 'business not found'); end if;
  insert into private.wa_test_numbers (phone_number_id, waba_id, business_id, registered_by)
  values (p_phone_number_id, p_waba_id, p_business_id, p_founder)
  on conflict (phone_number_id) do nothing;
  if (select business_id from private.wa_test_numbers where phone_number_id = p_phone_number_id) <> p_business_id then
    perform private.fail('CONFLICT', 'this number is already mapped to another business');
  end if;
end $$;

-- ---------------------------------------------------------------- founder (read-only summary)
create function public.founder_wa_test_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_founder();
  return jsonb_build_object(
    'numbers', (select coalesce(jsonb_agg(jsonb_build_object('phone_number_id', n.phone_number_id, 'waba_id', n.waba_id, 'business', b.name)
                  order by n.created_at), '[]') from private.wa_test_numbers n join public.businesses b on b.id = n.business_id),
    'event_counts', (select coalesce(jsonb_object_agg(kind, c), '{}') from (select kind, count(*) c from private.wa_test_events group by kind) k),
    'history', (select coalesce(jsonb_agg(summary order by received_at), '[]') from private.wa_test_events where kind in ('HISTORY', 'HISTORY_DECLINED')),
    'outbound', (select coalesce(jsonb_agg(jsonb_build_object('status', o.status, 'mode', o.mode, 'wa_message_id', o.wa_message_id,
                  'error_code', o.error_code, 'created_at', o.created_at,
                  'delivery', (select coalesce(jsonb_agg(e.status order by e.occurred_at), '[]') from private.wa_test_events e
                                where e.kind = 'STATUS' and e.wa_message_id = o.wa_message_id)) order by o.created_at, o.idempotency_key), '[]')
                 from private.wa_test_outbound o),
    'test_contact_messages', (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'business', b.name, 'body', e.body,
                  'reply_to', e.reply_to, 'occurred_at', e.occurred_at,
                  'replies_to_test_send', exists (select 1 from private.wa_test_outbound o where o.wa_message_id = e.reply_to))
                  order by e.occurred_at), '[]')
                 from private.wa_test_events e join public.businesses b on b.id = e.business_id where e.is_test_contact));
end $$;

revoke all on function public.internal_wa_business_for_number(text), public.internal_wa_record_events(jsonb),
  public.internal_wa_reserve_send(uuid, text, text, uuid), public.internal_wa_finish_send(uuid, text, text, text),
  public.internal_wa_last_inbound_at(text, text), public.internal_wa_register_number(text, text, uuid, uuid),
  public.founder_wa_test_summary(), private.wa_require_service() from public, anon, authenticated, service_role;
grant execute on function public.internal_wa_business_for_number(text), public.internal_wa_record_events(jsonb),
  public.internal_wa_reserve_send(uuid, text, text, uuid), public.internal_wa_finish_send(uuid, text, text, text),
  public.internal_wa_last_inbound_at(text, text), public.internal_wa_register_number(text, text, uuid, uuid) to service_role;
grant execute on function public.founder_wa_test_summary() to authenticated;

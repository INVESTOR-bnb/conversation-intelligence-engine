-- RRE WhatsApp integration — ISOLATED bundle. Applied only to the separate WhatsApp development
-- environment, after supabase/migrations/*. It is NOT a migration of the current prototype's
-- database and no deploy script installs it there. Remove: supabase/whatsapp/wa_integration_remove.sql.
--
-- It adds new objects only (no existing table, function, policy or grant is changed):
--   connections (one per business; credentials stored ENCRYPTED by the Edge Function), the owner's
--   recorded authorization (history scope, sending mode, limits), contacts with recorded permission,
--   imported/live messages, history-sync bookkeeping, and a durable send queue.
-- Imported chats become ordinary RRE TEXT cases, so the existing founder-only analysis, founder
-- approval, response loop, restrictions and outcomes apply unchanged.
--
-- Sending rules enforced HERE (the Edge Function only executes what the database releases):
--   global switch ON, connection CONNECTED (not paused/action required), an active owner
--   authorization in AUTOMATIC mode, the contact OPTED_IN (unknown = ineligible), no opt-out or
--   restriction, no owner takeover, complete evidence, a founder-approved non-RED recommendation,
--   per-contact follow-up limit, per-day limit, estimated-spend limit; free-form text only inside the
--   24-hour window opened by a LIVE inbound message (imported history never opens it); otherwise
--   only the owner's approved reopening template. One durable row per intended message; an
--   ambiguous provider result becomes UNKNOWN and is never resent automatically.

-- ---------------------------------------------------------------- tables
create table private.wa_settings (
  id boolean primary key default true check (id),
  sending_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into private.wa_settings (id) values (true);

-- Estimated USD per delivered message, for the spending limit only (NOT a verified rate card;
-- the founder updates these from Meta's current Nigeria rate card before any live sending).
create table private.wa_price_estimates (
  category text primary key check (category in ('MARKETING', 'UTILITY', 'SERVICE')),
  usd numeric(10, 4) not null check (usd >= 0),
  note text not null
);
insert into private.wa_price_estimates values
  ('MARKETING', 0.0516, 'UNVERIFIED estimate for Nigeria from third-party reports; replace with Meta''s rate card'),
  ('UTILITY', 0.0067, 'UNVERIFIED estimate for Nigeria from third-party reports'),
  ('SERVICE', 0.0101, 'UNVERIFIED: service messages reported chargeable from 1 Oct 2026 after a monthly free allowance');

create table private.wa_connections (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  status text not null default 'DISCONNECTED' check (status in ('DISCONNECTED', 'CONNECTING', 'SYNCING', 'CONNECTED', 'PAUSED', 'ACTION_REQUIRED')),
  action_code text check (action_code is null or action_code ~ '^[A-Z0-9_]{1,64}$'),
  phone_number_id text unique check (phone_number_id is null or phone_number_id ~ '^[0-9]{5,30}$'),
  waba_id text check (waba_id is null or waba_id ~ '^[0-9]{5,30}$'),
  number_last4 text check (number_last4 is null or number_last4 ~ '^[0-9]{4}$'),
  token_ciphertext text check (token_ciphertext is null or char_length(token_ciphertext) <= 4000),
  history_status text not null default 'NOT_REQUESTED'
    check (history_status in ('NOT_REQUESTED', 'REQUESTED', 'RECEIVING', 'COMPLETE', 'DECLINED', 'FAILED')),
  history_progress integer check (history_progress between 0 and 100),
  history_requested_at timestamptz,
  connected_by uuid,
  updated_at timestamptz not null default now(),
  check (status in ('DISCONNECTED', 'CONNECTING') or phone_number_id is not null),
  check (status <> 'ACTION_REQUIRED' or action_code is not null)
);

create table private.wa_authorizations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  terms_version text not null check (terms_version ~ '^[a-z0-9.-]{1,20}$'),
  history_months integer not null check (history_months between 1 and 6),
  send_mode text not null check (send_mode in ('AUTOMATIC', 'OWNER_SENDS')),
  max_sends_per_day integer not null check (max_sends_per_day between 1 and 50),
  max_followups_per_contact integer not null check (max_followups_per_contact between 1 and 2),
  spend_limit_usd numeric(10, 2) not null check (spend_limit_usd between 0 and 50),
  reopen_template text check (reopen_template is null or (reopen_template ~ '^[a-z0-9_]+$' and char_length(reopen_template) <= 512)),
  reopen_template_lang text check (reopen_template_lang is null or reopen_template_lang ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  reopen_template_text text check (reopen_template_text is null or char_length(reopen_template_text) between 1 and 1024),
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((reopen_template is null) = (reopen_template_text is null) and (reopen_template is null) = (reopen_template_lang is null))
);
create unique index wa_authorizations_one_active on private.wa_authorizations (business_id) where revoked_at is null;

create table private.wa_contacts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  wa_id text not null check (wa_id ~ '^[1-9][0-9]{6,14}$'),
  permission text not null default 'UNKNOWN' check (permission in ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT')),
  permission_source text check (permission_source is null or permission_source in ('OWNER_ATTESTED', 'PROSPECT_STOP', 'OWNER_WITHDRAWN')),
  permission_note text check (permission_note is null or char_length(permission_note) <= 300),
  permission_at timestamptz,
  permission_by uuid,
  last_live_inbound_at timestamptz,
  takeover_at timestamptz,
  evidence_incomplete boolean not null default false,
  case_id uuid unique references public.cases (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, wa_id)
);

create table private.wa_messages (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  contact_id uuid not null references private.wa_contacts (id) on delete cascade,
  wamid text not null check (char_length(wamid) between 1 and 200),
  direction text not null check (direction in ('IN', 'OUT_HUMAN', 'OUT_RRE')),
  source text not null check (source in ('HISTORY', 'LIVE', 'ECHO', 'RRE')),
  msg_type text not null check (msg_type ~ '^[a-z_]{1,30}$'),
  body text check (body is null or char_length(body) <= 4096),
  content_available boolean not null,
  sent_at timestamptz not null,
  received_at timestamptz not null default now(),
  in_case_at timestamptz,
  unique (business_id, wamid)
);
create index wa_messages_contact_idx on private.wa_messages (contact_id, sent_at, wamid);

create table private.wa_history_chunks (
  business_id uuid not null references public.businesses (id) on delete cascade,
  chunk_key text not null check (char_length(chunk_key) between 1 and 100),
  phase integer, chunk_order integer, progress integer,
  kept integer not null, discarded integer not null,
  oldest timestamptz, newest timestamptz,
  received_at timestamptz not null default now(),
  primary key (business_id, chunk_key)
);

create table private.wa_sends (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  contact_id uuid not null references private.wa_contacts (id) on delete cascade,
  case_id uuid not null references public.cases (id) on delete cascade,
  approval_id uuid not null,
  authorization_id uuid not null references private.wa_authorizations (id),
  kind text not null check (kind in ('REOPEN_TEMPLATE', 'REPLY_TEXT')),
  category text not null check (category in ('MARKETING', 'UTILITY', 'SERVICE')),
  template_name text, template_lang text,
  body text not null check (char_length(body) between 1 and 4096),
  est_cost_usd numeric(10, 4) not null,
  status text not null default 'QUEUED' check (status in ('QUEUED', 'SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ',
    'FAILED', 'UNKNOWN', 'CANCELLED')),
  status_detail text check (status_detail is null or status_detail ~ '^[A-Za-z0-9_:.-]{1,80}$'),
  wamid text unique,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (approval_id, kind),
  check ((kind = 'REOPEN_TEMPLATE') = (template_name is not null))
);
create index wa_sends_queue_idx on private.wa_sends (status, created_at);

alter table private.wa_settings enable row level security;
alter table private.wa_price_estimates enable row level security;
alter table private.wa_connections enable row level security;
alter table private.wa_authorizations enable row level security;
alter table private.wa_contacts enable row level security;
alter table private.wa_messages enable row level security;
alter table private.wa_history_chunks enable row level security;
alter table private.wa_sends enable row level security;
revoke all on table private.wa_settings, private.wa_price_estimates, private.wa_connections, private.wa_authorizations,
  private.wa_contacts, private.wa_messages, private.wa_history_chunks, private.wa_sends from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- helpers
create function private.wa_require_service() returns void language plpgsql stable set search_path = '' as $$
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then perform private.fail('FORBIDDEN', 'server-side only'); end if;
end $$;

create function private.wa_my_business() returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  if (select auth.uid()) is null then perform private.fail('FORBIDDEN', 'sign-in required'); end if;
  v := private.my_business_id();
  if v is null then perform private.fail('FORBIDDEN', 'client access required'); end if;
  return v;
end $$;

create function private.wa_active_auth(p_business uuid) returns private.wa_authorizations
language sql stable security definer set search_path = '' as $$
  select * from private.wa_authorizations where business_id = p_business and revoked_at is null
$$;

-- Cancels every not-yet-sent message of a contact (reply, opt-out, takeover, pause-by-disconnect).
create function private.wa_cancel_pending(p_contact uuid, p_reason text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  update private.wa_sends set status = 'CANCELLED', status_detail = p_reason, updated_at = now()
   where contact_id = p_contact and status = 'QUEUED';
  get diagnostics v = row_count;
  return v;
end $$;

-- Why a planned or claimed send may not go out now (NULL = it may). Re-checked at claim time.
create function private.wa_block_reason(p_send private.wa_sends) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  c private.wa_connections;
  a private.wa_authorizations;
  k private.wa_contacts;
  v_case public.cases;
  r public.client_recommendations;
  v_spent numeric;
begin
  if not (select sending_enabled from private.wa_settings where id) then return 'SENDING_SWITCH_OFF'; end if;
  select * into c from private.wa_connections where business_id = p_send.business_id;
  if c.status is distinct from 'CONNECTED' then return 'CONNECTION_' || coalesce(c.status, 'MISSING'); end if;
  a := private.wa_active_auth(p_send.business_id);
  if a.id is null or a.id <> p_send.authorization_id then return 'AUTHORIZATION_CHANGED'; end if;
  if a.send_mode <> 'AUTOMATIC' then return 'OWNER_SENDS_MODE'; end if;
  select * into k from private.wa_contacts where id = p_send.contact_id;
  if k.permission <> 'OPTED_IN' then return 'NO_RECIPIENT_PERMISSION'; end if;
  if k.takeover_at is not null then return 'OWNER_TOOK_OVER'; end if;
  if k.evidence_incomplete then return 'EVIDENCE_INCOMPLETE'; end if;
  select * into v_case from public.cases where id = p_send.case_id;
  if v_case.workflow_state <> 'CLIENT_ACTION_REQUIRED' then return 'CASE_NOT_AWAITING_SEND'; end if;
  if private.has_active_restriction(v_case.id) then return 'CONTACT_RESTRICTED'; end if;
  select * into r from public.client_recommendations where case_id = v_case.id;
  if r.approval_id is distinct from p_send.approval_id or r.classification = 'RED' or r.approved_message is null then return 'APPROVAL_CHANGED'; end if;
  if p_send.kind = 'REPLY_TEXT' and (k.last_live_inbound_at is null or k.last_live_inbound_at < now() - interval '23 hours 30 minutes') then
    return 'REPLY_WINDOW_CLOSED';
  end if;
  if (select count(*) from private.wa_sends s where s.contact_id = k.id and s.id <> p_send.id
        and s.status in ('SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'UNKNOWN')) >= a.max_followups_per_contact then
    return 'FOLLOWUP_LIMIT';
  end if;
  if (select count(*) from private.wa_sends s where s.business_id = p_send.business_id and s.id <> p_send.id
        and s.status in ('SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'UNKNOWN') and s.claimed_at > now() - interval '24 hours') >= a.max_sends_per_day then
    return 'DAILY_LIMIT';
  end if;
  select coalesce(sum(est_cost_usd), 0) into v_spent from private.wa_sends s
   where s.authorization_id = a.id and s.id <> p_send.id and s.status in ('SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'UNKNOWN');
  if v_spent + p_send.est_cost_usd > a.spend_limit_usd then return 'SPEND_LIMIT'; end if;
  return null;
end $$;

-- ---------------------------------------------------------------- service role: connection lifecycle
create function public.internal_wa_business_for_number(p_phone_number_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  return (select business_id from private.wa_connections where phone_number_id = p_phone_number_id and status <> 'DISCONNECTED');
end $$;

-- Called by the Edge Function after it verified the caller is a member of p_business and Meta's
-- Embedded Signup completed. The business is the caller's own (checked by the Edge Function from
-- the member's session, never from the browser's request body).
create function public.internal_wa_record_connection(p_business uuid, p_actor uuid, p_phone_number_id text, p_waba_id text,
  p_last_four text, p_token_ciphertext text, p_status text, p_action_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  if not exists (select 1 from public.business_members where business_id = p_business and user_id = p_actor) then
    perform private.fail('FORBIDDEN', 'only a member of this business can connect its WhatsApp');
  end if;
  if p_status in ('CONNECTING', 'SYNCING', 'CONNECTED') and (private.wa_active_auth(p_business)).id is null then
    perform private.fail('AUTHORIZATION_REQUIRED', 'the owner must authorize recovery before connecting');
  end if;
  if exists (select 1 from private.wa_connections where phone_number_id = p_phone_number_id and business_id <> p_business and status <> 'DISCONNECTED') then
    perform private.fail('CONFLICT', 'this WhatsApp number is connected to another business');
  end if;
  insert into private.wa_connections (business_id, status, action_code, phone_number_id, waba_id, number_last4, token_ciphertext,
                                      history_status, history_requested_at, connected_by, updated_at)
  values (p_business, p_status, p_action_code, p_phone_number_id, p_waba_id, p_last_four, p_token_ciphertext,
          'NOT_REQUESTED', null, p_actor, now())
  on conflict (business_id) do update set status = excluded.status, action_code = excluded.action_code,
    phone_number_id = excluded.phone_number_id, waba_id = excluded.waba_id, number_last4 = excluded.number_last4,
    token_ciphertext = excluded.token_ciphertext, connected_by = excluded.connected_by, updated_at = now(),
    -- a reconnection starts a fresh history request; an earlier result is kept only for the same number
    history_status = case when private.wa_connections.phone_number_id = excluded.phone_number_id then private.wa_connections.history_status else 'NOT_REQUESTED' end,
    history_progress = case when private.wa_connections.phone_number_id = excluded.phone_number_id then private.wa_connections.history_progress end;
  perform private.audit('WA_CONNECTION', null, p_business, 'SERVICE', null, jsonb_build_object('status', p_status, 'action_code', p_action_code));
end $$;

create function public.internal_wa_set_connection_status(p_business uuid, p_status text, p_action_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  update private.wa_connections set status = p_status, action_code = p_action_code, updated_at = now(),
    token_ciphertext = case when p_status = 'DISCONNECTED' or p_action_code = 'TOKEN_REVOKED' then null else token_ciphertext end
   where business_id = p_business;
  if p_status in ('DISCONNECTED', 'ACTION_REQUIRED') then
    update private.wa_sends set status = 'CANCELLED', status_detail = 'CONNECTION_' || p_status, updated_at = now()
     where business_id = p_business and status = 'QUEUED';
  end if;
end $$;

-- Called after Meta accepted the history request. Webhooks may already have arrived (they find the
-- mapping recorded before the request): a completed or declined history goes straight to CONNECTED.
create function public.internal_wa_mark_history_requested(p_business uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  perform private.wa_require_service();
  update private.wa_connections set
    history_status = case when history_status in ('COMPLETE', 'RECEIVING', 'DECLINED') then history_status else 'REQUESTED' end,
    history_requested_at = coalesce(history_requested_at, now()),
    status = case when status = 'CONNECTING' then (case when history_status in ('COMPLETE', 'DECLINED') then 'CONNECTED' else 'SYNCING' end) else status end,
    updated_at = now()
   where business_id = p_business returning status into v;
  return v;
end $$;

-- Whether the owner has an active authorization (checked before the Meta code exchange).
create function public.internal_wa_has_authorization(p_business uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  return to_jsonb((private.wa_active_auth(p_business)).id is not null);
end $$;

-- The encrypted token of a business (for Graph calls); null when not connected.
create function public.internal_wa_connection(p_business uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  return (select jsonb_build_object('status', status, 'phone_number_id', phone_number_id, 'waba_id', waba_id, 'token', token_ciphertext)
            from private.wa_connections where business_id = p_business);
end $$;

-- Businesses the worker serves (connected or syncing, not paused or disconnected).
create function public.internal_wa_active_businesses() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  return (select coalesce(jsonb_agg(business_id order by business_id), '[]') from private.wa_connections where status in ('CONNECTED', 'SYNCING'));
end $$;

-- ---------------------------------------------------------------- service role: webhook ingestion
-- p_events: normalized by the Edge Function. Each: kind (MESSAGE | STATUS | HISTORY_CHUNK | HISTORY_DECLINED | ACCOUNT),
-- phone_number_id, and per kind: wa_id, wamid, direction, source, msg_type, body, content_available, sent_at (epoch s),
-- context_wamid; status, error_code; chunk_key, phase, chunk_order, progress, messages[]; event.
create function public.internal_wa_ingest(p_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e jsonb; m jsonb;
  v_business uuid; v_contact private.wa_contacts; v_auth private.wa_authorizations;
  v_new integer; v_ins integer := 0; v_dup integer := 0; v_unknown integer := 0; v_kept integer; v_disc integer;
  v_at timestamptz; v_oldest timestamptz; v_newest timestamptz; v_rank integer;
  v_case public.cases;
begin
  perform private.wa_require_service();
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 1000 then
    perform private.fail('VALIDATION', 'events must be an array of at most 1000');
  end if;
  for e in select * from jsonb_array_elements(p_events) loop
    -- the business comes only from the server-side mapping (account notices carry the WABA id instead of a number)
    select business_id into v_business from private.wa_connections
     where status <> 'DISCONNECTED' and (phone_number_id = e ->> 'phone_number_id'
           or (e ->> 'phone_number_id' is null and e ->> 'kind' = 'ACCOUNT' and waba_id = e ->> 'waba_id'));
    if v_business is null then v_unknown := v_unknown + 1; continue; end if;   -- unknown mapping: never stored

    if e ->> 'kind' = 'MESSAGE' then
      insert into private.wa_contacts (business_id, wa_id) values (v_business, e ->> 'wa_id') on conflict (business_id, wa_id) do nothing;
      select * into v_contact from private.wa_contacts where business_id = v_business and wa_id = e ->> 'wa_id';
      v_at := to_timestamp((e ->> 'sent_at')::double precision);
      insert into private.wa_messages (business_id, contact_id, wamid, direction, source, msg_type, body, content_available, sent_at)
      values (v_business, v_contact.id, e ->> 'wamid', e ->> 'direction', e ->> 'source', e ->> 'msg_type',
              case when (e ->> 'content_available')::boolean then left(e ->> 'body', 4096) end, (e ->> 'content_available')::boolean, v_at)
      on conflict (business_id, wamid) do nothing;
      get diagnostics v_new = row_count;
      if v_new = 0 then v_dup := v_dup + 1; continue; end if;                  -- retry or replay: nothing more happens
      v_ins := v_ins + 1;
      if e ->> 'source' = 'LIVE' and e ->> 'direction' = 'IN' then
        -- only a LIVE inbound message opens (or extends) the 24-hour window; delayed events never move it back
        update private.wa_contacts set last_live_inbound_at = greatest(coalesce(last_live_inbound_at, v_at), v_at) where id = v_contact.id;
        if upper(btrim(coalesce(e ->> 'body', ''))) in ('STOP', 'UNSUBSCRIBE', 'STOP MESSAGES', 'OPT OUT', 'OPT-OUT') then
          update private.wa_contacts set permission = 'OPTED_OUT', permission_source = 'PROSPECT_STOP', permission_at = now() where id = v_contact.id;
          perform private.wa_cancel_pending(v_contact.id, 'PROSPECT_OPTED_OUT');
          select * into v_case from public.cases where id = v_contact.case_id for update;
          if found and not private.is_terminal(v_case.workflow_state) and not private.has_active_restriction(v_case.id) then
            perform private.add_restriction(v_case, 'EXPLICIT_OPT_OUT', 'CLIENT', 'Prospect replied STOP on WhatsApp', null, 'SERVICE');
          end if;
          continue;
        end if;
        perform private.wa_cancel_pending(v_contact.id, 'PROSPECT_REPLIED');
        select * into v_case from public.cases where id = v_contact.case_id for update;
        if found and v_case.workflow_state = 'WAITING_FOR_PROSPECT' and (e ->> 'content_available')::boolean then
          insert into public.case_messages (case_id, business_id, kind, body)
          values (v_case.id, v_case.business_id, 'PROSPECT_RESPONSE', left(e ->> 'body', 5000));
          update public.cases set workflow_state = 'PROSPECT_REPLIED', evidence_version = evidence_version + 1,
            review_reason = 'PROSPECT_RESPONSE', queued_at = now() where id = v_case.id;
          perform private.audit('RESPONSE_ADDED', v_case.id, v_case.business_id, 'SERVICE', 'Prospect replied on WhatsApp — under review');
        end if;
      elsif e ->> 'source' = 'ECHO' then
        -- the owner wrote from the WhatsApp Business app: a human handles this conversation now
        if v_contact.case_id is not null or exists (select 1 from private.wa_sends where contact_id = v_contact.id) then
          update private.wa_contacts set takeover_at = coalesce(takeover_at, now()) where id = v_contact.id;
          perform private.wa_cancel_pending(v_contact.id, 'OWNER_TOOK_OVER');
        end if;
      end if;

    elsif e ->> 'kind' = 'STATUS' then
      -- delivery status of an RRE send; never moves backwards, never turns into "replied" or "sold"
      v_rank := case e ->> 'status' when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
      update private.wa_sends set status = case when e ->> 'status' = 'failed' then 'FAILED'
                                               else upper(e ->> 'status') end,
        status_detail = case when e ->> 'status' = 'failed' then 'META_' || coalesce(e ->> 'error_code', 'X') else status_detail end, updated_at = now()
       where wamid = e ->> 'wamid' and business_id = v_business
         and ((e ->> 'status' = 'failed' and status in ('ACCEPTED', 'SENT', 'UNKNOWN'))
              or (v_rank > 0 and (case status when 'ACCEPTED' then 0 when 'UNKNOWN' then 0 when 'SENT' then 1 when 'DELIVERED' then 2 when 'READ' then 3 else 99 end) < v_rank));
      get diagnostics v_new = row_count;
      v_ins := v_ins + v_new;

    elsif e ->> 'kind' = 'HISTORY_CHUNK' then
      v_auth := private.wa_active_auth(v_business);
      v_kept := 0; v_disc := 0; v_oldest := null; v_newest := null;
      if exists (select 1 from private.wa_history_chunks where business_id = v_business and chunk_key = e ->> 'chunk_key') then
        v_dup := v_dup + 1; continue;
      end if;
      for m in select * from jsonb_array_elements(coalesce(e -> 'messages', '[]')) loop
        v_at := to_timestamp((m ->> 'sent_at')::double precision);
        -- outside the owner's authorized history scope (or no authorization yet): discarded, never stored
        if v_auth.id is null or v_at < now() - make_interval(months => v_auth.history_months) then v_disc := v_disc + 1; continue; end if;
        insert into private.wa_contacts (business_id, wa_id) values (v_business, m ->> 'wa_id') on conflict (business_id, wa_id) do nothing;
        select * into v_contact from private.wa_contacts where business_id = v_business and wa_id = m ->> 'wa_id';
        insert into private.wa_messages (business_id, contact_id, wamid, direction, source, msg_type, body, content_available, sent_at)
        values (v_business, v_contact.id, m ->> 'wamid', m ->> 'direction', 'HISTORY', m ->> 'msg_type',
                case when (m ->> 'content_available')::boolean then left(m ->> 'body', 4096) end, (m ->> 'content_available')::boolean, v_at)
        on conflict (business_id, wamid) do nothing;
        if not (m ->> 'content_available')::boolean then update private.wa_contacts set evidence_incomplete = true where id = v_contact.id; end if;
        v_kept := v_kept + 1;
        v_oldest := least(coalesce(v_oldest, v_at), v_at); v_newest := greatest(coalesce(v_newest, v_at), v_at);
      end loop;
      insert into private.wa_history_chunks (business_id, chunk_key, phase, chunk_order, progress, kept, discarded, oldest, newest)
      values (v_business, e ->> 'chunk_key', (e ->> 'phase')::integer, (e ->> 'chunk_order')::integer, (e ->> 'progress')::integer,
              v_kept, v_disc, v_oldest, v_newest);
      update private.wa_connections set history_progress = greatest(coalesce(history_progress, 0), coalesce((e ->> 'progress')::integer, 0)),
        history_status = case when history_status = 'COMPLETE' or coalesce((e ->> 'progress')::integer, 0) >= 100 then 'COMPLETE' else 'RECEIVING' end,
        status = case when status in ('CONNECTING', 'SYNCING') and coalesce((e ->> 'progress')::integer, 0) >= 100 and history_requested_at is not null
                      then 'CONNECTED' else status end,
        updated_at = now()
       where business_id = v_business;
      v_ins := v_ins + 1;

    elsif e ->> 'kind' = 'HISTORY_DECLINED' then
      update private.wa_connections set history_status = 'DECLINED',
        status = case when status in ('CONNECTING', 'SYNCING') and history_requested_at is not null then 'CONNECTED' else status end,
        updated_at = now() where business_id = v_business;
      v_ins := v_ins + 1;

    elsif e ->> 'kind' = 'ACCOUNT' then
      -- the owner disconnected the app, the account was restricted, or the permission was removed
      perform public.internal_wa_set_connection_status(v_business, 'ACTION_REQUIRED', left(upper(regexp_replace(e ->> 'event', '[^A-Za-z0-9_]', '_', 'g')), 64));
      v_ins := v_ins + 1;
    end if;
  end loop;
  return jsonb_build_object('stored', v_ins, 'duplicates', v_dup, 'unknown_number', v_unknown);
end $$;

-- ---------------------------------------------------------------- service role: chats → RRE cases
-- Builds an ordinary TEXT case from one contact's stored conversation (oldest first, speakers
-- attributed, missing content marked, never invented). Only conversations with both sides, last
-- message at least 2 days old, inside the authorized scope; at most p_limit new cases per call.
create function public.internal_wa_import_cases(p_business uuid, p_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  k private.wa_contacts; v_auth private.wa_authorizations; v_case uuid; v_text text; v_lines text[]; m private.wa_messages;
  v_n integer := 0; v_missing integer; v_first timestamptz; v_last timestamptz;
begin
  perform private.wa_require_service();
  v_auth := private.wa_active_auth(p_business);
  if v_auth.id is null then return 0; end if;
  -- never analyse an incomplete import: history must be complete (or declined) and settled
  if not exists (select 1 from private.wa_connections where business_id = p_business and history_status in ('COMPLETE', 'DECLINED')) then return 0; end if;
  if exists (select 1 from private.wa_history_chunks where business_id = p_business and received_at > now() - interval '10 minutes') then return 0; end if;
  for k in select c.* from private.wa_contacts c
            where c.business_id = p_business and c.case_id is null and c.permission <> 'OPTED_OUT'
              and exists (select 1 from private.wa_messages x where x.contact_id = c.id and x.direction = 'IN')
              and exists (select 1 from private.wa_messages x where x.contact_id = c.id and x.direction <> 'IN')
              and (select max(sent_at) from private.wa_messages x where x.contact_id = c.id) < now() - interval '2 days'
            order by c.created_at limit greatest(0, least(p_limit, 20)) loop
    v_lines := array[]::text[]; v_missing := 0; v_first := null; v_last := null;
    for m in select * from private.wa_messages where contact_id = k.id
               and sent_at >= now() - make_interval(months => v_auth.history_months) order by sent_at, wamid loop
      v_first := coalesce(v_first, m.sent_at); v_last := m.sent_at;
      v_lines := v_lines || format('[%s] %s: %s', to_char(m.sent_at at time zone 'Africa/Lagos', 'YYYY-MM-DD HH24:MI'),
        case m.direction when 'IN' then 'Prospect' else 'Business' end,
        case when m.content_available then replace(m.body, E'\n', ' ')
             else format('[%s not available to RRE — content not imported]', m.msg_type) end);
      if not m.content_available then v_missing := v_missing + 1; end if;
    end loop;
    v_text := array_to_string(v_lines, E'\n');
    if char_length(v_text) > 19000 then
      v_text := '[Earlier messages omitted: conversation too long]' || E'\n' || right(v_text, 18900);
      v_missing := v_missing + 1;
    end if;
    if char_length(v_text) < 20 then continue; end if;
    insert into public.cases (business_id, reference, product_service, lead_source, last_interaction_date, client_context,
                              conversation_source, idempotency_key, workflow_state, evidence_version, review_reason, queued_at)
    values (p_business, 'WA-' || right(k.wa_id, 4) || '-' || to_char(now(), 'MMDDHH24MI'), 'WhatsApp conversation', 'Unknown',
            (v_last at time zone 'Africa/Lagos')::date,
            format('Imported from WhatsApp (%s to %s, %s message(s) without importable content).',
              to_char(v_first at time zone 'Africa/Lagos', 'YYYY-MM-DD'), to_char(v_last at time zone 'Africa/Lagos', 'YYYY-MM-DD'), v_missing),
            'TEXT', gen_random_uuid(), 'SUBMITTED', 1, 'NEW_SUBMISSION', now())
    returning id into v_case;
    insert into public.case_messages (case_id, business_id, kind, body) values (v_case, p_business, 'PASTED_CONVERSATION', v_text);
    update private.wa_contacts set case_id = v_case, evidence_incomplete = evidence_incomplete or v_missing > 0 where id = k.id;
    update private.wa_messages set in_case_at = now() where contact_id = k.id and in_case_at is null
       and sent_at >= now() - make_interval(months => v_auth.history_months);
    perform private.audit('CASE_CREATED', v_case, p_business, 'SERVICE', 'Imported from WhatsApp');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- History that arrives after a contact's case was created (a late or out-of-order batch) is added to
-- the case as an extra, labelled conversation entry. The case's evidence version rises, so earlier
-- analyses become stale and their approvals unusable; a reviewed or approved case returns to the
-- founder for re-analysis and queued sends are cancelled. Never silently ignored, never merged unseen.
create function public.internal_wa_apply_late_history(p_business uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  k private.wa_contacts; v_case public.cases; m private.wa_messages; v_lines text[]; v_n integer := 0; v_missing integer;
begin
  perform private.wa_require_service();
  if exists (select 1 from private.wa_history_chunks where business_id = p_business and received_at > now() - interval '10 minutes') then return 0; end if;
  for k in select c.* from private.wa_contacts c where c.business_id = p_business and c.case_id is not null
             and exists (select 1 from private.wa_messages x where x.contact_id = c.id and x.source = 'HISTORY' and x.in_case_at is null) loop
    select * into v_case from public.cases where id = k.case_id for update;
    if not found or private.is_terminal(v_case.workflow_state) then continue; end if;
    v_lines := array[format('[Additional WhatsApp history received later — earlier messages in this conversation]')]; v_missing := 0;
    for m in select * from private.wa_messages where contact_id = k.id and source = 'HISTORY' and in_case_at is null order by sent_at, wamid loop
      v_lines := v_lines || format('[%s] %s: %s', to_char(m.sent_at at time zone 'Africa/Lagos', 'YYYY-MM-DD HH24:MI'),
        case m.direction when 'IN' then 'Prospect' else 'Business' end,
        case when m.content_available then replace(m.body, E'\n', ' ') else format('[%s not available to RRE — content not imported]', m.msg_type) end);
      if not m.content_available then v_missing := v_missing + 1; end if;
    end loop;
    insert into public.case_messages (case_id, business_id, kind, body)
    values (v_case.id, v_case.business_id, 'PASTED_CONVERSATION', left(array_to_string(v_lines, E'\n'), 19000));
    update private.wa_messages set in_case_at = now() where contact_id = k.id and source = 'HISTORY' and in_case_at is null;
    update private.wa_contacts set evidence_incomplete = evidence_incomplete or v_missing > 0 where id = k.id;
    perform private.wa_cancel_pending(k.id, 'EVIDENCE_CHANGED');
    update public.cases set evidence_version = evidence_version + 1,
      workflow_state = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT')
                            then 'REANALYZING'::public.workflow_state else workflow_state end,
      review_reason = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT')
                           then 'REANALYSIS'::public.review_reason else review_reason end,
      queued_at = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT') then now() else queued_at end
     where id = v_case.id;
    perform private.audit('WA_LATE_HISTORY', v_case.id, v_case.business_id, 'SERVICE', null, jsonb_build_object('missing', v_missing));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------- service role: the send queue
-- Plans the send for every founder-approved WhatsApp case that is eligible now. Idempotent:
-- one row per (approval, kind). Free-form text only inside the live window; otherwise the
-- owner's approved reopening template (its fixed text; no AI text in variables).
create function public.internal_wa_plan_sends() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record; v_auth private.wa_authorizations; v_kind text; v_body text; v_cat text; v_cost numeric; v_new integer; v_n integer := 0;
  v_send private.wa_sends;
begin
  perform private.wa_require_service();
  for r in select k.id contact_id, k.business_id, k.last_live_inbound_at, c.id case_id, rec.approval_id, rec.approved_message
             from private.wa_contacts k join public.cases c on c.id = k.case_id
             join public.client_recommendations rec on rec.case_id = c.id
            where c.workflow_state = 'CLIENT_ACTION_REQUIRED' and rec.classification <> 'RED' and rec.approved_message is not null loop
    v_auth := private.wa_active_auth(r.business_id);
    if v_auth.id is null or v_auth.send_mode <> 'AUTOMATIC' then continue; end if;
    if r.last_live_inbound_at is not null and r.last_live_inbound_at > now() - interval '23 hours 30 minutes' then
      v_kind := 'REPLY_TEXT'; v_body := r.approved_message; v_cat := 'SERVICE';
    elsif v_auth.reopen_template is not null then
      v_kind := 'REOPEN_TEMPLATE'; v_body := v_auth.reopen_template_text; v_cat := 'MARKETING';
    else
      continue; -- no approved template: an old prospect cannot be contacted
    end if;
    select usd into v_cost from private.wa_price_estimates where category = v_cat;
    insert into private.wa_sends (business_id, contact_id, case_id, approval_id, authorization_id, kind, category, template_name, template_lang, body, est_cost_usd)
    values (r.business_id, r.contact_id, r.case_id, r.approval_id, v_auth.id, v_kind, v_cat,
            case when v_kind = 'REOPEN_TEMPLATE' then v_auth.reopen_template end,
            case when v_kind = 'REOPEN_TEMPLATE' then v_auth.reopen_template_lang end, v_body, v_cost)
    on conflict (approval_id, kind) do nothing;
    get diagnostics v_new = row_count;
    v_n := v_n + v_new;
  end loop;
  return v_n;
end $$;

-- Claims due sends for the worker. Each is re-checked; a blocked one is cancelled with its reason
-- (or left queued when the block is temporary: paused, switch off, window, limits).
-- A send left SENDING by a crashed worker for 10 minutes becomes UNKNOWN (never resent automatically).
create function public.internal_wa_claim_sends(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s private.wa_sends; v_reason text; v_out jsonb := '[]'; k private.wa_contacts; c private.wa_connections;
begin
  perform private.wa_require_service();
  update private.wa_sends set status = 'UNKNOWN', status_detail = 'WORKER_LOST', updated_at = now()
   where status = 'SENDING' and claimed_at < now() - interval '10 minutes';
  for s in select * from private.wa_sends where status = 'QUEUED' order by created_at
            limit greatest(0, least(p_limit, 20)) for update skip locked loop
    v_reason := private.wa_block_reason(s);
    if v_reason is not null then
      -- permanent blocks cancel; temporary ones (switch off, paused, no permission yet, daily or spend limit) hold the send
      if v_reason in ('OWNER_TOOK_OVER', 'EVIDENCE_INCOMPLETE', 'CASE_NOT_AWAITING_SEND', 'CONTACT_RESTRICTED',
                      'APPROVAL_CHANGED', 'AUTHORIZATION_CHANGED', 'OWNER_SENDS_MODE', 'FOLLOWUP_LIMIT', 'REPLY_WINDOW_CLOSED') then
        update private.wa_sends set status = 'CANCELLED', status_detail = v_reason, updated_at = now() where id = s.id;
      else
        update private.wa_sends set status_detail = v_reason, updated_at = now() where id = s.id; -- temporary: stays queued
      end if;
      continue;
    end if;
    update private.wa_sends set status = 'SENDING', claimed_at = now(), status_detail = null, updated_at = now() where id = s.id;
    select * into k from private.wa_contacts where id = s.contact_id;
    select * into c from private.wa_connections where business_id = s.business_id;
    v_out := v_out || jsonb_build_object('send_id', s.id, 'business_id', s.business_id, 'phone_number_id', c.phone_number_id,
      'token', c.token_ciphertext, 'to', k.wa_id, 'kind', s.kind, 'template_name', s.template_name, 'template_lang', s.template_lang, 'body', s.body);
  end loop;
  return v_out;
end $$;

-- Records the provider's answer. ACCEPTED (Meta returned a message id; NOT delivered): the case
-- records the message as sent and waits for the prospect. FAILED: definitive refusal (no retry).
-- UNKNOWN: the request may have been accepted (timeout, 5xx, network): held for the founder to
-- reconcile, never resent automatically.
create function private.wa_finish(p_send_id uuid, p_outcome text, p_wamid text, p_detail text) returns void
language plpgsql security definer set search_path = '' as $$
declare s private.wa_sends; v_case public.cases; v_rec public.client_recommendations; v_attempt integer;
begin
  select * into s from private.wa_sends where id = p_send_id for update;
  if not found or s.status <> 'SENDING' then return; end if;
  if p_outcome not in ('ACCEPTED', 'FAILED', 'UNKNOWN') then perform private.fail('VALIDATION', 'bad outcome'); end if;
  update private.wa_sends set status = p_outcome, wamid = case when p_outcome = 'ACCEPTED' then p_wamid end,
    status_detail = p_detail, updated_at = now() where id = s.id;
  if p_outcome = 'ACCEPTED' then
    insert into private.wa_messages (business_id, contact_id, wamid, direction, source, msg_type, body, content_available, sent_at)
    values (s.business_id, s.contact_id, p_wamid, 'OUT_RRE', 'RRE', case when s.kind = 'REOPEN_TEMPLATE' then 'template' else 'text' end,
            s.body, true, now()) on conflict (business_id, wamid) do nothing;
    select * into v_case from public.cases where id = s.case_id for update;
    select * into v_rec from public.client_recommendations where case_id = s.case_id;
    if v_case.workflow_state = 'CLIENT_ACTION_REQUIRED' then
      select count(*) + 1 into v_attempt from public.case_messages where case_id = v_case.id and kind = 'RECOVERY_SENT';
      insert into public.case_messages (case_id, business_id, kind, body, attempt, approval_id, sent_exactly)
      values (v_case.id, v_case.business_id, 'RECOVERY_SENT', s.body, v_attempt, s.approval_id, s.body = v_rec.approved_message);
      update public.cases set workflow_state = 'WAITING_FOR_PROSPECT', evidence_version = evidence_version + 1 where id = v_case.id;
      perform private.audit('MESSAGE_SENT', v_case.id, v_case.business_id, 'SERVICE',
        case when s.kind = 'REOPEN_TEMPLATE' then 'WhatsApp reopening message sent by RRE' else 'WhatsApp follow-up sent by RRE' end,
        jsonb_build_object('attempt', v_attempt, 'kind', s.kind));
    end if;
  end if;
end $$;

create function public.internal_wa_finish_send(p_send_id uuid, p_outcome text, p_wamid text, p_detail text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.wa_require_service();
  perform private.wa_finish(p_send_id, p_outcome, p_wamid, p_detail);
end $$;

-- ---------------------------------------------------------------- business owner (own business only)
create function public.client_wa_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := private.wa_my_business(); c private.wa_connections; a private.wa_authorizations;
begin
  select * into c from private.wa_connections where business_id = v;
  a := private.wa_active_auth(v);
  return jsonb_build_object(
    'status', coalesce(c.status, 'DISCONNECTED'), 'action_code', c.action_code, 'number_last4', c.number_last4,
    'history', jsonb_build_object('status', coalesce(c.history_status, 'NOT_REQUESTED'), 'progress', c.history_progress,
      'oldest', (select min(oldest) from private.wa_history_chunks where business_id = v),
      'newest', (select max(newest) from private.wa_history_chunks where business_id = v),
      'kept', (select coalesce(sum(kept), 0) from private.wa_history_chunks where business_id = v),
      'discarded', (select coalesce(sum(discarded), 0) from private.wa_history_chunks where business_id = v)),
    'authorization', case when a.id is null then null else jsonb_build_object('send_mode', a.send_mode, 'history_months', a.history_months,
      'max_sends_per_day', a.max_sends_per_day, 'max_followups_per_contact', a.max_followups_per_contact, 'spend_limit_usd', a.spend_limit_usd,
      'reopen_template_text', a.reopen_template_text, 'granted_at', a.granted_at, 'terms_version', a.terms_version) end,
    'counts', jsonb_build_object(
      'conversations_reviewed', (select count(*) from private.wa_contacts k join public.cases cs on cs.id = k.case_id
                                  where k.business_id = v and cs.workflow_state not in ('DRAFT', 'SUBMITTED', 'ANALYZING')),
      'followups_sent', (select count(*) from private.wa_sends where business_id = v and status in ('ACCEPTED', 'SENT', 'DELIVERED', 'READ')),
      'replies_received', (select count(*) from private.wa_messages m where m.business_id = v and m.direction = 'IN' and m.source = 'LIVE'
                             and exists (select 1 from private.wa_messages o where o.contact_id = m.contact_id and o.direction = 'OUT_RRE' and o.sent_at <= m.sent_at)),
      'waiting_for_permission', (select count(*) from private.wa_contacts where business_id = v and case_id is not null and permission = 'UNKNOWN')));
end $$;

-- The owner's explicit, limited authorization (replaces any previous one). Nothing is sent
-- without it; connecting alone authorizes nothing.
create function public.client_wa_authorize(p_terms_version text, p_history_months integer, p_send_mode text, p_max_sends_per_day integer,
  p_max_followups_per_contact integer, p_spend_limit_usd numeric, p_reopen_template text, p_reopen_template_lang text, p_reopen_template_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare v uuid := private.wa_my_business();
begin
  update private.wa_authorizations set revoked_at = now() where business_id = v and revoked_at is null;
  insert into private.wa_authorizations (business_id, terms_version, history_months, send_mode, max_sends_per_day, max_followups_per_contact,
    spend_limit_usd, reopen_template, reopen_template_lang, reopen_template_text, granted_by)
  values (v, p_terms_version, p_history_months, p_send_mode, p_max_sends_per_day, p_max_followups_per_contact, p_spend_limit_usd,
          nullif(p_reopen_template, ''), nullif(p_reopen_template_lang, ''), nullif(btrim(coalesce(p_reopen_template_text, '')), ''), (select auth.uid()));
  update private.wa_sends set status = 'CANCELLED', status_detail = 'AUTHORIZATION_CHANGED', updated_at = now() where business_id = v and status = 'QUEUED';
  perform private.audit('WA_AUTHORIZED', null, v, 'CLIENT', 'WhatsApp recovery settings updated',
    jsonb_build_object('send_mode', p_send_mode, 'spend_limit_usd', p_spend_limit_usd));
end $$;

create function public.client_wa_pause(p_paused boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare v uuid := private.wa_my_business(); v_status text;
begin
  update private.wa_connections set status = case when p_paused and status = 'CONNECTED' then 'PAUSED'
                                                   when not p_paused and status = 'PAUSED' then 'CONNECTED' else status end, updated_at = now()
   where business_id = v returning status into v_status;
  perform private.audit(case when p_paused then 'WA_PAUSED' else 'WA_RESUMED' end, null, v, 'CLIENT');
  return coalesce(v_status, 'DISCONNECTED');
end $$;

create function public.client_wa_disconnect() returns void
language plpgsql security definer set search_path = '' as $$
declare v uuid := private.wa_my_business();
begin
  update private.wa_authorizations set revoked_at = now() where business_id = v and revoked_at is null;
  update private.wa_connections set status = 'DISCONNECTED', action_code = null, token_ciphertext = null, updated_at = now() where business_id = v;
  update private.wa_sends set status = 'CANCELLED', status_detail = 'DISCONNECTED', updated_at = now() where business_id = v and status = 'QUEUED';
  perform private.audit('WA_DISCONNECTED', null, v, 'CLIENT');
end $$;

-- Conversations the owner can grant or withdraw permission for (own business only; no analysis).
create function public.client_wa_contacts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := private.wa_my_business();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'number', '+' || k.wa_id, 'permission', k.permission,
            'taken_over', k.takeover_at is not null, 'evidence_incomplete', k.evidence_incomplete,
            'last_message_at', (select max(sent_at) from private.wa_messages m where m.contact_id = k.id),
            'case_status', (select workflow_state from public.cases where id = k.case_id)) order by k.created_at), '[]')
          from private.wa_contacts k where k.business_id = v and k.case_id is not null);
end $$;

create function public.client_wa_set_permission(p_contact_id uuid, p_opted_in boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v uuid := private.wa_my_business(); k private.wa_contacts;
begin
  select * into k from private.wa_contacts where id = p_contact_id and business_id = v for update;
  if not found then perform private.fail('NOT_FOUND', 'conversation not found'); end if;
  if k.permission = 'OPTED_OUT' and k.permission_source = 'PROSPECT_STOP' then perform private.fail('CONTACT_RESTRICTED', 'the prospect asked not to be contacted'); end if;
  if p_opted_in and char_length(btrim(coalesce(p_note, ''))) < 10 then perform private.fail('VALIDATION', 'say how this person agreed to be contacted'); end if;
  update private.wa_contacts set permission = case when p_opted_in then 'OPTED_IN' else 'OPTED_OUT' end,
    permission_source = case when p_opted_in then 'OWNER_ATTESTED' else 'OWNER_WITHDRAWN' end,
    permission_note = left(btrim(coalesce(p_note, '')), 300), permission_at = now(), permission_by = (select auth.uid()) where id = k.id;
  if not p_opted_in then perform private.wa_cancel_pending(k.id, 'PERMISSION_WITHDRAWN'); end if;
end $$;

create function public.client_wa_takeover(p_contact_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v uuid := private.wa_my_business();
begin
  update private.wa_contacts set takeover_at = coalesce(takeover_at, now()) where id = p_contact_id and business_id = v;
  if not found then perform private.fail('NOT_FOUND', 'conversation not found'); end if;
  perform private.wa_cancel_pending(p_contact_id, 'OWNER_TOOK_OVER');
end $$;

-- ---------------------------------------------------------------- founder (diagnostics and global switch)
create function public.founder_wa_set_sending(p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_founder();
  update private.wa_settings set sending_enabled = p_enabled, updated_at = now() where id;
  perform private.audit(case when p_enabled then 'WA_SENDING_ON' else 'WA_SENDING_OFF' end, null, null, 'FOUNDER');
end $$;

create function public.founder_wa_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_founder();
  return jsonb_build_object(
    'sending_enabled', (select sending_enabled from private.wa_settings where id),
    'businesses', (select coalesce(jsonb_agg(jsonb_build_object('business', b.name, 'status', c.status, 'action_code', c.action_code,
        'history_status', c.history_status, 'history_progress', c.history_progress,
        'sends', (select coalesce(jsonb_object_agg(st, n), '{}') from (select status st, count(*) n from private.wa_sends s where s.business_id = c.business_id group by status) x),
        'unknown_sends', (select coalesce(jsonb_agg(jsonb_build_object('send_id', s.id, 'case_id', s.case_id, 'kind', s.kind, 'detail', s.status_detail)), '[]')
                            from private.wa_sends s where s.business_id = c.business_id and s.status = 'UNKNOWN'))), '[]')
      from private.wa_connections c join public.businesses b on b.id = c.business_id));
end $$;

-- Reconciles an UNKNOWN send after checking the owner's app / Meta: it was sent, or it was not.
-- "Not sent" never re-queues automatically: the founder approves again to send again.
create function public.founder_wa_resolve_unknown(p_send_id uuid, p_was_sent boolean, p_wamid text) returns void
language plpgsql security definer set search_path = '' as $$
declare s private.wa_sends;
begin
  perform private.require_founder();
  select * into s from private.wa_sends where id = p_send_id for update;
  if not found or s.status <> 'UNKNOWN' then perform private.fail('INVALID_STATE', 'not an unresolved send'); end if;
  if p_was_sent then
    update private.wa_sends set status = 'SENDING' where id = s.id;
    perform private.wa_finish(s.id, 'ACCEPTED', coalesce(nullif(p_wamid, ''), 'reconciled-' || s.id::text), 'RECONCILED_BY_FOUNDER');
  else
    update private.wa_sends set status = 'CANCELLED', status_detail = 'RECONCILED_NOT_SENT', updated_at = now() where id = s.id;
  end if;
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function private.wa_require_service(), private.wa_my_business(), private.wa_active_auth(uuid),
  private.wa_cancel_pending(uuid, text), private.wa_block_reason(private.wa_sends), private.wa_finish(uuid, text, text, text)
  from public, anon, authenticated, service_role;
do $$
declare f text;
begin
  foreach f in array array['internal_wa_active_businesses()', 'internal_wa_mark_history_requested(uuid)', 'internal_wa_has_authorization(uuid)',
    'internal_wa_apply_late_history(uuid)', 'internal_wa_business_for_number(text)', 'internal_wa_record_connection(uuid, uuid, text, text, text, text, text, text)',
    'internal_wa_set_connection_status(uuid, text, text)', 'internal_wa_connection(uuid)', 'internal_wa_ingest(jsonb)',
    'internal_wa_import_cases(uuid, integer)', 'internal_wa_plan_sends()', 'internal_wa_claim_sends(integer)',
    'internal_wa_finish_send(uuid, text, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['client_wa_status()', 'client_wa_authorize(text, integer, text, integer, integer, numeric, text, text, text)',
    'client_wa_pause(boolean)', 'client_wa_disconnect()', 'client_wa_contacts()', 'client_wa_set_permission(uuid, boolean, text)',
    'client_wa_takeover(uuid)', 'founder_wa_set_sending(boolean)', 'founder_wa_overview()', 'founder_wa_resolve_unknown(uuid, boolean, text)'] loop
    execute format('revoke all on function public.%s from public, anon, service_role', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

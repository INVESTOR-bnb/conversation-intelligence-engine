-- Stage 2A-1 — guarded state-changing functions.
--
-- All are SECURITY DEFINER with an empty search_path. Each checks the caller
-- (client membership or founder role), the case's current state and its
-- inputs, takes a row lock on the case, and writes the audit log in the same
-- transaction. Error messages start with a stable code:
--   FORBIDDEN (42501), NOT_FOUND (P0002), INVALID_STATE, VALIDATION,
--   STALE_ANALYSIS, CONTACT_RESTRICTED, RATE_LIMITED (P0001).

-- ---------------------------------------------------------------- internal helpers

create function private.fail(p_code text, p_detail text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%: %', p_code, p_detail using errcode = case p_code
    when 'FORBIDDEN' then '42501' when 'NOT_FOUND' then 'P0002' else 'P0001' end;
end $$;

create function private.require_founder() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.is_founder() then
    perform private.fail('FORBIDDEN', 'founder access required');
  end if;
  return (select auth.uid());
end $$;

-- Locks and returns a case the calling client's business owns. Cases of other
-- businesses are reported as NOT_FOUND so their existence is not revealed.
create function private.client_case_for_update(p_case_id uuid) returns public.cases
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases;
begin
  if (select auth.uid()) is null then
    perform private.fail('FORBIDDEN', 'sign-in required');
  end if;
  select * into v_case from public.cases where id = p_case_id for update;
  if not found or not private.is_member(v_case.business_id) then
    perform private.fail('NOT_FOUND', 'case not found');
  end if;
  return v_case;
end $$;

create function private.founder_case_for_update(p_case_id uuid) returns public.cases
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases;
begin
  perform private.require_founder();
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'case not found');
  end if;
  return v_case;
end $$;

create function private.has_active_restriction(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.contact_restrictions r where r.case_id = p_case_id and r.status = 'ACTIVE');
$$;

create function private.is_terminal(p_state public.workflow_state) returns boolean
language sql immutable set search_path = '' as $$
  select p_state in ('PAUSED', 'WON', 'LOST', 'DISQUALIFIED');
$$;

-- Adds a contact restriction. A restriction is new evidence: the evidence
-- version increases (so earlier analyses become stale) and a case whose
-- recommendation is with the client returns to founder review, which hides
-- the message from the client.
create function private.add_restriction(
  p_case public.cases, p_kind public.restriction_kind, p_source public.restriction_source,
  p_note text, p_evidence jsonb, p_actor_role text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into public.contact_restrictions (case_id, business_id, kind, source, note, evidence, created_by)
  values (p_case.id, p_case.business_id, p_kind, p_source, nullif(btrim(coalesce(p_note, '')), ''), p_evidence, (select auth.uid()))
  returning id into v_id;

  update public.cases set
    evidence_version = evidence_version + 1,
    workflow_state = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT')
                          then 'REANALYZING'::public.workflow_state else workflow_state end,
    review_reason = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT')
                         then 'CONTACT_RESTRICTION'::public.review_reason else review_reason end,
    queued_at = case when workflow_state in ('AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT')
                     then now() else queued_at end
  where id = p_case.id;

  perform private.audit('RESTRICTION_ADDED', p_case.id, p_case.business_id, p_actor_role,
    case when p_actor_role = 'CLIENT' then 'Opt-out recorded — under review' end,
    jsonb_build_object('restriction_id', v_id, 'kind', p_kind, 'source', p_source));
  return v_id;
end $$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;
grant execute on function private.is_founder() to authenticated;
grant execute on function private.is_member(uuid) to authenticated;

-- ---------------------------------------------------------------- identity

create function public.whoami() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_business public.businesses;
begin
  if v_uid is null then
    perform private.fail('FORBIDDEN', 'sign-in required');
  end if;
  if private.is_founder() then
    return jsonb_build_object('user_id', v_uid, 'role', 'FOUNDER');
  end if;
  select b.* into v_business from public.businesses b where b.id = private.my_business_id();
  if found then
    return jsonb_build_object('user_id', v_uid, 'role', 'CLIENT', 'business_id', v_business.id,
                              'business_name', v_business.name, 'currency', v_business.currency);
  end if;
  -- Invited but not yet assigned: no access to anything.
  return jsonb_build_object('user_id', v_uid, 'role', 'NONE');
end $$;

-- ---------------------------------------------------------------- founder: businesses and members

create function public.founder_create_business(p_name text, p_industry text default '', p_currency text default 'NGN')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_founder();
  insert into public.businesses (name, industry, currency, created_by)
  values (btrim(p_name), btrim(coalesce(p_industry, '')), upper(btrim(coalesce(p_currency, 'NGN'))), (select auth.uid()))
  returning id into v_id;
  perform private.audit('BUSINESS_CREATED', null, v_id, 'FOUNDER');
  return v_id;
end $$;

-- Links an invited user (created via the Supabase dashboard invite) to a business.
create function public.founder_add_member(p_business_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_founder();
  if not exists (select 1 from public.businesses where id = p_business_id) then
    perform private.fail('NOT_FOUND', 'business not found');
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    perform private.fail('NOT_FOUND', 'user not found');
  end if;
  if exists (select 1 from public.founders where user_id = p_user_id) then
    perform private.fail('VALIDATION', 'a founder cannot be a client member');
  end if;
  if exists (select 1 from public.business_members where user_id = p_user_id) then
    perform private.fail('VALIDATION', 'user already belongs to a business');
  end if;
  insert into public.business_members (business_id, user_id, created_by) values (p_business_id, p_user_id, (select auth.uid()));
  perform private.audit('MEMBER_ADDED', null, p_business_id, 'FOUNDER', null, jsonb_build_object('user_id', p_user_id));
end $$;

-- ---------------------------------------------------------------- client: cases

create function public.client_create_case(
  p_idempotency_key uuid,
  p_reference text,
  p_product_service text,
  p_lead_source text,
  p_conversation_source public.conversation_source,
  p_conversation_text text default null,
  p_estimated_value numeric default null,
  p_last_interaction_date date default null,
  p_client_context text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_business uuid;
  v_id uuid;
  v_text text := nullif(btrim(coalesce(p_conversation_text, '')), '');
begin
  if (select auth.uid()) is null then
    perform private.fail('FORBIDDEN', 'sign-in required');
  end if;
  v_business := private.my_business_id();
  if v_business is null then
    perform private.fail('FORBIDDEN', 'client access required');
  end if;
  if p_idempotency_key is null then
    perform private.fail('VALIDATION', 'idempotency key required');
  end if;

  select id into v_id from public.cases where business_id = v_business and idempotency_key = p_idempotency_key;
  if found then
    return v_id; -- retry of an earlier request: same case, no duplicate
  end if;

  if (select count(*) from public.cases where business_id = v_business and created_at > now() - interval '1 day') >= 20 then
    perform private.fail('RATE_LIMITED', 'daily case limit reached');
  end if;
  if p_conversation_source = 'TEXT' and char_length(coalesce(v_text, '')) < 20 then
    perform private.fail('VALIDATION', 'pasted conversation is too short');
  end if;

  begin
    insert into public.cases (business_id, reference, product_service, lead_source, estimated_value,
                              last_interaction_date, client_context, conversation_source, idempotency_key, created_by)
    values (v_business, btrim(p_reference), btrim(p_product_service), p_lead_source, p_estimated_value,
            p_last_interaction_date, nullif(btrim(coalesce(p_client_context, '')), ''), p_conversation_source,
            p_idempotency_key, (select auth.uid()))
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.cases where business_id = v_business and idempotency_key = p_idempotency_key;
    return v_id;
  end;

  if p_conversation_source = 'TEXT' then
    insert into public.case_messages (case_id, business_id, kind, body, created_by)
    values (v_id, v_business, 'PASTED_CONVERSATION', v_text, (select auth.uid()));
  end if;

  perform private.audit('CASE_CREATED', v_id, v_business, 'CLIENT');
  return v_id;
end $$;

create function public.client_submit_case(p_case_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
  v_shots integer;
begin
  if v_case.workflow_state <> 'DRAFT' then
    perform private.fail('INVALID_STATE', 'only draft cases can be submitted');
  end if;
  if v_case.conversation_source = 'TEXT' then
    if not exists (select 1 from public.case_messages where case_id = v_case.id and kind = 'PASTED_CONVERSATION') then
      perform private.fail('VALIDATION', 'conversation missing');
    end if;
  else
    select count(*) into v_shots from public.case_screenshots where case_id = v_case.id;
    if v_shots < 1 or v_shots > 10 then
      perform private.fail('VALIDATION', 'between 1 and 10 screenshots are required');
    end if;
  end if;

  update public.cases set workflow_state = 'SUBMITTED', evidence_version = evidence_version + 1,
    review_reason = 'NEW_SUBMISSION', queued_at = now()
  where id = v_case.id;
  perform private.audit('CASE_SUBMITTED', v_case.id, v_case.business_id, 'CLIENT', 'Case submitted');
end $$;

create function public.client_record_sent(p_case_id uuid, p_actual_text text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
  v_rec public.client_recommendations;
  v_actual text := nullif(btrim(coalesce(p_actual_text, '')), '');
  v_attempt integer;
begin
  if v_case.workflow_state <> 'CLIENT_ACTION_REQUIRED' then
    perform private.fail('INVALID_STATE', 'no recommendation is awaiting action');
  end if;
  select * into v_rec from public.client_recommendations where case_id = v_case.id;
  if not found or v_rec.classification = 'RED' or v_rec.approved_message is null then
    perform private.fail('INVALID_STATE', 'there is no approved message to send');
  end if;
  if private.has_active_restriction(v_case.id) then
    perform private.fail('CONTACT_RESTRICTED', 'contact with this prospect is restricted');
  end if;
  if p_actual_text is not null and v_actual is null then
    perform private.fail('VALIDATION', 'paste the exact message you sent');
  end if;

  select count(*) + 1 into v_attempt from public.case_messages where case_id = v_case.id and kind = 'RECOVERY_SENT';
  insert into public.case_messages (case_id, business_id, kind, body, attempt, approval_id, sent_exactly, created_by)
  values (v_case.id, v_case.business_id, 'RECOVERY_SENT', coalesce(v_actual, v_rec.approved_message), v_attempt,
          v_rec.approval_id, v_actual is null or v_actual = v_rec.approved_message, (select auth.uid()));
  update public.cases set workflow_state = 'WAITING_FOR_PROSPECT', evidence_version = evidence_version + 1
  where id = v_case.id;
  perform private.audit('MESSAGE_SENT', v_case.id, v_case.business_id, 'CLIENT', format('Message sent (attempt %s)', v_attempt),
    jsonb_build_object('attempt', v_attempt, 'sent_exactly', v_actual is null or v_actual = v_rec.approved_message));
end $$;

create function public.client_add_response(p_case_id uuid, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
begin
  if v_case.workflow_state <> 'WAITING_FOR_PROSPECT' then
    perform private.fail('INVALID_STATE', 'responses can be added only while waiting for the prospect');
  end if;
  if v_text is null or char_length(v_text) > 5000 then
    perform private.fail('VALIDATION', 'response must be 1 to 5000 characters');
  end if;
  if (select count(*) from public.case_messages where case_id = v_case.id and kind = 'PROSPECT_RESPONSE'
        and created_at > now() - interval '1 day') >= 10 then
    perform private.fail('RATE_LIMITED', 'daily response limit reached for this case');
  end if;

  insert into public.case_messages (case_id, business_id, kind, body, created_by)
  values (v_case.id, v_case.business_id, 'PROSPECT_RESPONSE', v_text, (select auth.uid()));
  update public.cases set workflow_state = 'PROSPECT_REPLIED', evidence_version = evidence_version + 1,
    review_reason = 'PROSPECT_RESPONSE', queued_at = now()
  where id = v_case.id;
  perform private.audit('RESPONSE_ADDED', v_case.id, v_case.business_id, 'CLIENT', 'Prospect response added — under review');
end $$;

create function public.client_report_opt_out(p_case_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
begin
  if private.is_terminal(v_case.workflow_state) then
    perform private.fail('INVALID_STATE', 'case is closed');
  end if;
  perform private.add_restriction(v_case, 'EXPLICIT_OPT_OUT', 'CLIENT', p_note, null, 'CLIENT');
end $$;

create function public.client_record_outcome(
  p_case_id uuid, p_state public.workflow_state,
  p_deal_value numeric default null, p_amount_paid numeric default null,
  p_payment_date date default null, p_note text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.client_case_for_update(p_case_id);
begin
  if v_case.workflow_state not in ('CLIENT_ACTION_REQUIRED', 'WAITING_FOR_PROSPECT') then
    perform private.fail('INVALID_STATE', 'an outcome can be recorded only after a recommendation');
  end if;
  if p_state not in ('WON', 'LOST', 'PAUSED', 'DISQUALIFIED') then
    perform private.fail('VALIDATION', 'invalid outcome');
  end if;
  if p_state = 'WON' and (coalesce(p_amount_paid, 0) <= 0 or p_payment_date is null) then
    perform private.fail('VALIDATION', 'a won deal requires the amount paid and payment date');
  end if;

  insert into public.outcomes (case_id, business_id, state, deal_value, amount_paid, payment_date, note, recorded_by, recorded_by_role)
  values (v_case.id, v_case.business_id, p_state,
          case when p_state = 'WON' then p_deal_value end, case when p_state = 'WON' then p_amount_paid end,
          case when p_state = 'WON' then p_payment_date end, nullif(btrim(coalesce(p_note, '')), ''),
          (select auth.uid()), 'CLIENT');
  update public.cases set workflow_state = p_state, closed_at = now(), queued_at = null, review_reason = null
  where id = v_case.id;
  perform private.audit('OUTCOME_RECORDED', v_case.id, v_case.business_id, 'CLIENT',
    case p_state when 'WON' then 'Deal won — recovered' when 'LOST' then 'Closed — lost'
                 when 'PAUSED' then 'Case paused' else 'Disqualified' end,
    jsonb_build_object('state', p_state));
end $$;

-- ---------------------------------------------------------------- client: approved-only reads

-- The client-safe projection (server-side equivalent of src/domain/clientView.ts).
-- Recommendation fields appear only while the case awaits client action; RED
-- never carries a message. No analysis, notes, restrictions or AI proposals.
create function public.client_list_cases()
returns table (
  id uuid, reference text, product_service text, status text,
  classification public.classification, deal_situation text, next_action text, approved_message text,
  recovery_attempts integer, last_sent_message text, responses_added integer,
  won_deal_value numeric, won_amount_paid numeric, won_payment_date date,
  closed_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select
    c.id, c.reference, c.product_service,
    case
      when c.workflow_state = 'DRAFT' then 'DRAFT'
      when c.workflow_state in ('SUBMITTED', 'ANALYZING', 'AWAITING_ADMIN_REVIEW', 'PROSPECT_REPLIED', 'REANALYZING') then 'UNDER_REVIEW'
      when c.workflow_state = 'CLIENT_ACTION_REQUIRED' then 'ACTION_REQUIRED'
      when c.workflow_state = 'WAITING_FOR_PROSPECT' then 'WAITING'
      else c.workflow_state::text
    end,
    case when c.workflow_state = 'CLIENT_ACTION_REQUIRED' then r.classification end,
    case when c.workflow_state = 'CLIENT_ACTION_REQUIRED' then r.deal_situation end,
    case when c.workflow_state = 'CLIENT_ACTION_REQUIRED' then r.next_action end,
    case when c.workflow_state = 'CLIENT_ACTION_REQUIRED' and r.classification <> 'RED' then r.approved_message end,
    (select count(*)::integer from public.case_messages m where m.case_id = c.id and m.kind = 'RECOVERY_SENT'),
    (select m.body from public.case_messages m where m.case_id = c.id and m.kind = 'RECOVERY_SENT'
      order by m.attempt desc limit 1),
    (select count(*)::integer from public.case_messages m where m.case_id = c.id and m.kind = 'PROSPECT_RESPONSE'),
    case when o.state = 'WON' then o.deal_value end,
    case when o.state = 'WON' then o.amount_paid end,
    case when o.state = 'WON' then o.payment_date end,
    o.created_at,
    c.updated_at
  from public.cases c
  left join public.client_recommendations r on r.case_id = c.id
  left join public.outcomes o on o.case_id = c.id
  where c.business_id = (select private.my_business_id())
  order by c.created_at desc;
$$;

create function public.client_get_case(p_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  select to_jsonb(v) || jsonb_build_object('history', coalesce((
      select jsonb_agg(jsonb_build_object('at', a.at, 'label', a.client_label) order by a.at, a.id)
      from public.audit_log a where a.case_id = v.id and a.client_label is not null), '[]'::jsonb))
    into v_result
  from public.client_list_cases() v
  where v.id = p_case_id;
  if v_result is null then
    perform private.fail('NOT_FOUND', 'case not found');
  end if;
  return v_result;
end $$;

-- ---------------------------------------------------------------- founder: analysis lifecycle

-- Opens an analysis for the case's current evidence and locks the case into
-- ANALYZING. Called by the founder (via the 2A-3 Edge Function) — never automatic.
create function public.founder_start_analysis(p_case_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_version integer;
  v_manifest jsonb;
  v_id uuid;
begin
  if v_case.workflow_state not in ('SUBMITTED', 'PROSPECT_REPLIED', 'REANALYZING') then
    perform private.fail('INVALID_STATE', 'case is not waiting for analysis');
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.analyses where case_id = v_case.id;
  v_manifest := jsonb_build_object(
    'evidence_version', v_case.evidence_version,
    'screenshots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'sha256', s.sha256)
                                              order by s.position)
                             from public.case_screenshots s where s.case_id = v_case.id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'created_at', m.created_at)
                                           order by m.created_at, m.id)
                          from public.case_messages m where m.case_id = v_case.id), '[]'::jsonb),
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'source', r.source, 'status', r.status)
                                               order by r.created_at)
                              from public.contact_restrictions r where r.case_id = v_case.id), '[]'::jsonb));

  insert into public.analyses (case_id, business_id, version, evidence_version, evidence_manifest, prior_state, requested_by)
  values (v_case.id, v_case.business_id, v_version, v_case.evidence_version, v_manifest, v_case.workflow_state, (select auth.uid()))
  returning id into v_id;
  update public.cases set workflow_state = 'ANALYZING' where id = v_case.id;
  perform private.audit('ANALYSIS_STARTED', v_case.id, v_case.business_id, 'FOUNDER', null,
    jsonb_build_object('analysis_id', v_id, 'version', v_version, 'evidence_version', v_case.evidence_version));
  return v_id;
end $$;

-- Records the result of an analysis. Server-side only (service role, Edge
-- Function). A failed or stale analysis returns the case to its prior state
-- and is never shown to anyone but the founder.
create function public.internal_complete_analysis(
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
  if jsonb_typeof(v_restrictions) <> 'array' then
    perform private.fail('VALIDATION', 'detected restrictions must be an array');
  end if;
  select * into v_case from public.cases where id = v_analysis.case_id for update;

  if p_status = 'ERROR' or v_case.evidence_version <> v_analysis.evidence_version or v_case.workflow_state <> 'ANALYZING' then
    update public.analyses set status = 'ERROR',
      error = left(coalesce(case when p_status = 'ERROR' then p_error end, 'STALE: evidence changed during analysis'), 2000),
      model = p_model, prompt_version = p_prompt_version, input_tokens = p_input_tokens,
      output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
    where id = v_analysis.id;
    update public.cases set workflow_state = v_analysis.prior_state
    where id = v_case.id and workflow_state = 'ANALYZING';
    perform private.audit('ANALYSIS_FAILED', v_case.id, v_case.business_id, 'SERVICE', null,
      jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version));
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
end $$;

-- Releases a stuck analysis (e.g. the Edge Function crashed).
create function public.founder_abandon_analysis(p_analysis_id uuid) returns void
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
end $$;

create function public.founder_request_reanalysis(p_case_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
begin
  if v_case.workflow_state <> 'AWAITING_ADMIN_REVIEW' then
    perform private.fail('INVALID_STATE', 'reanalysis can be requested only during review');
  end if;
  update public.cases set workflow_state = 'REANALYZING', review_reason = coalesce(review_reason, 'REANALYSIS')
  where id = v_case.id;
  perform private.audit('REANALYSIS_REQUESTED', v_case.id, v_case.business_id, 'FOUNDER');
end $$;

-- ---------------------------------------------------------------- founder: approval

create function public.founder_approve(
  p_case_id uuid,
  p_analysis_id uuid,
  p_expected_evidence_version integer,
  p_classification public.classification,
  p_deal_situation text,
  p_next_action text,
  p_approved_message text,
  p_approval_type public.approval_type
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_analysis public.analyses;
  v_latest integer;
  v_message text := nullif(btrim(coalesce(p_approved_message, '')), '');
  v_id uuid;
begin
  if v_case.workflow_state <> 'AWAITING_ADMIN_REVIEW' then
    perform private.fail('INVALID_STATE', 'case is not awaiting review');
  end if;
  select * into v_analysis from public.analyses where id = p_analysis_id and case_id = v_case.id;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found for this case');
  end if;
  select max(version) into v_latest from public.analyses where case_id = v_case.id and status <> 'ERROR';
  if v_analysis.status not in ('COMPLETE', 'INSUFFICIENT_EVIDENCE') or v_analysis.version <> v_latest
     or v_analysis.evidence_version <> v_case.evidence_version
     or p_expected_evidence_version is distinct from v_case.evidence_version then
    perform private.fail('STALE_ANALYSIS', 'evidence or analysis changed; review the latest analysis');
  end if;
  if p_classification is null then
    perform private.fail('VALIDATION', 'classification required');
  end if;
  if p_classification = 'RED' and v_message is not null then
    perform private.fail('VALIDATION', 'a RED decision never carries a message');
  end if;
  if p_classification <> 'RED' and v_message is null then
    perform private.fail('VALIDATION', 'an approved message is required for GREEN and YELLOW');
  end if;
  if p_classification <> 'RED' and private.has_active_restriction(v_case.id) then
    perform private.fail('CONTACT_RESTRICTED', 'contact is restricted; only a RED decision is possible');
  end if;
  if p_approval_type = 'UNCHANGED' and (p_classification is distinct from v_analysis.ai_classification
                                         or v_message is distinct from v_analysis.ai_proposed_message) then
    perform private.fail('VALIDATION', 'UNCHANGED approval must match the analysis proposal');
  end if;
  if p_approval_type = 'MARKED_RED' and p_classification <> 'RED' then
    perform private.fail('VALIDATION', 'MARKED_RED requires RED');
  end if;

  insert into public.approvals (case_id, business_id, analysis_id, founder_id, evidence_version, approval_type,
                                ai_classification, classification, ai_proposed_message, approved_message,
                                deal_situation, next_action)
  values (v_case.id, v_case.business_id, v_analysis.id, (select auth.uid()), v_case.evidence_version, p_approval_type,
          v_analysis.ai_classification, p_classification, v_analysis.ai_proposed_message, v_message,
          btrim(p_deal_situation), btrim(p_next_action))
  returning id into v_id;

  insert into public.client_recommendations (case_id, business_id, approval_id, classification, deal_situation, next_action, approved_message)
  values (v_case.id, v_case.business_id, v_id, p_classification, btrim(p_deal_situation), btrim(p_next_action), v_message)
  on conflict (case_id) do update set approval_id = excluded.approval_id, classification = excluded.classification,
    deal_situation = excluded.deal_situation, next_action = excluded.next_action,
    approved_message = excluded.approved_message, published_at = now();

  update public.cases set workflow_state = 'CLIENT_ACTION_REQUIRED', queued_at = null, review_reason = null
  where id = v_case.id;
  perform private.audit('APPROVED', v_case.id, v_case.business_id, 'FOUNDER', 'Recommendation ready',
    jsonb_build_object('approval_id', v_id, 'analysis_version', v_analysis.version, 'classification', p_classification,
                       'ai_classification', v_analysis.ai_classification, 'approval_type', p_approval_type,
                       'evidence_version', v_case.evidence_version));
  return v_id;
end $$;

-- A RED "stop contact" decision that needs no analysis: stopping is always safe.
create function public.founder_stop_contact(
  p_case_id uuid,
  p_deal_situation text default 'This prospect is not currently recommended for further recovery attempts.',
  p_next_action text default 'No further contact is recommended.'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_id uuid;
begin
  if v_case.workflow_state in ('DRAFT', 'ANALYZING') or private.is_terminal(v_case.workflow_state) then
    perform private.fail('INVALID_STATE', 'case cannot be stopped in its current state');
  end if;
  insert into public.approvals (case_id, business_id, analysis_id, founder_id, evidence_version, approval_type,
                                classification, approved_message, deal_situation, next_action)
  values (v_case.id, v_case.business_id, null, (select auth.uid()), v_case.evidence_version, 'MARKED_RED',
          'RED', null, btrim(p_deal_situation), btrim(p_next_action))
  returning id into v_id;
  insert into public.client_recommendations (case_id, business_id, approval_id, classification, deal_situation, next_action, approved_message)
  values (v_case.id, v_case.business_id, v_id, 'RED', btrim(p_deal_situation), btrim(p_next_action), null)
  on conflict (case_id) do update set approval_id = excluded.approval_id, classification = 'RED',
    deal_situation = excluded.deal_situation, next_action = excluded.next_action, approved_message = null, published_at = now();
  update public.cases set workflow_state = 'CLIENT_ACTION_REQUIRED', queued_at = null, review_reason = null
  where id = v_case.id;
  perform private.audit('STOP_CONTACT', v_case.id, v_case.business_id, 'FOUNDER', 'Recommendation ready',
    jsonb_build_object('approval_id', v_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------- founder: restrictions, notes, pause

create function public.founder_add_restriction(p_case_id uuid, p_kind public.restriction_kind, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
begin
  return private.add_restriction(v_case, p_kind, 'FOUNDER', p_note, null, 'FOUNDER');
end $$;

-- Only an AI-detected restriction can be dismissed, and only as a misreading
-- of the evidence, with a written reason. Founder- and client-recorded
-- restrictions are permanent.
create function public.founder_dismiss_ai_restriction(p_restriction_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_r public.contact_restrictions;
begin
  perform private.require_founder();
  select * into v_r from public.contact_restrictions where id = p_restriction_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'restriction not found');
  end if;
  if v_r.source <> 'AI_DETECTED' then
    perform private.fail('FORBIDDEN', 'founder- and client-recorded restrictions are permanent');
  end if;
  if v_r.status <> 'ACTIVE' then
    perform private.fail('INVALID_STATE', 'restriction already dismissed');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 20 then
    perform private.fail('VALIDATION', 'explain in at least 20 characters why the evidence was misread');
  end if;
  update public.contact_restrictions set status = 'DISMISSED_AS_MISREAD', dismissed_by = (select auth.uid()),
    dismissed_reason = btrim(p_reason), dismissed_at = now()
  where id = v_r.id;
  perform private.audit('RESTRICTION_DISMISSED_AS_MISREAD', v_r.case_id, v_r.business_id, 'FOUNDER', null,
    jsonb_build_object('restriction_id', v_r.id, 'reason', btrim(p_reason)));
end $$;

create function public.founder_add_note(p_case_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
  v_id uuid;
begin
  insert into public.founder_notes (case_id, business_id, body, author)
  values (v_case.id, v_case.business_id, btrim(p_body), (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

create function public.founder_pause_case(p_case_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_case public.cases := private.founder_case_for_update(p_case_id);
begin
  if private.is_terminal(v_case.workflow_state) then
    perform private.fail('INVALID_STATE', 'case is already closed');
  end if;
  update public.analyses set status = 'ERROR', error = 'Case paused', completed_at = now()
  where case_id = v_case.id and status = 'PENDING';
  insert into public.outcomes (case_id, business_id, state, note, recorded_by, recorded_by_role)
  values (v_case.id, v_case.business_id, 'PAUSED', nullif(btrim(coalesce(p_note, '')), ''), (select auth.uid()), 'FOUNDER');
  update public.cases set workflow_state = 'PAUSED', closed_at = now(), queued_at = null, review_reason = null
  where id = v_case.id;
  perform private.audit('CASE_PAUSED', v_case.id, v_case.business_id, 'FOUNDER', 'Case paused');
end $$;

-- ---------------------------------------------------------------- execute grants (default deny)

revoke all on all functions in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema private from public, anon, authenticated, service_role;
grant execute on function private.is_founder() to authenticated;
grant execute on function private.is_member(uuid) to authenticated;

grant execute on function
  public.whoami(),
  public.client_create_case(uuid, text, text, text, public.conversation_source, text, numeric, date, text),
  public.client_submit_case(uuid),
  public.client_record_sent(uuid, text),
  public.client_add_response(uuid, text),
  public.client_report_opt_out(uuid, text),
  public.client_record_outcome(uuid, public.workflow_state, numeric, numeric, date, text),
  public.client_list_cases(),
  public.client_get_case(uuid),
  public.founder_create_business(text, text, text),
  public.founder_add_member(uuid, uuid),
  public.founder_start_analysis(uuid),
  public.founder_abandon_analysis(uuid),
  public.founder_request_reanalysis(uuid),
  public.founder_approve(uuid, uuid, integer, public.classification, text, text, text, public.approval_type),
  public.founder_stop_contact(uuid, text, text),
  public.founder_add_restriction(uuid, public.restriction_kind, text),
  public.founder_dismiss_ai_restriction(uuid, text),
  public.founder_add_note(uuid, text),
  public.founder_pause_case(uuid, text)
to authenticated;

grant execute on function
  public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)
to service_role;

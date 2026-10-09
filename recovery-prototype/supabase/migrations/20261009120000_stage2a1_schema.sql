-- Stage 2A-1 — core schema.
-- Tables, types and integrity constraints only. Access control lives in the
-- next migration; state changes happen only through guarded functions.
--
-- Conventions
--   * Every business-owned row carries business_id. Child tables reference
--     cases(id, business_id) with a composite foreign key so a row can never
--     point at a case belonging to a different business.
--   * Workflow state names are kept from Stage 1 (src/domain/types.ts);
--     "ADMIN" in a state name means the founder.

-- ---------------------------------------------------------------- types

create type public.workflow_state as enum (
  'DRAFT', 'SUBMITTED', 'ANALYZING', 'AWAITING_ADMIN_REVIEW', 'CLIENT_ACTION_REQUIRED',
  'WAITING_FOR_PROSPECT', 'PROSPECT_REPLIED', 'REANALYZING', 'PAUSED', 'WON', 'LOST', 'DISQUALIFIED'
);
create type public.classification as enum ('GREEN', 'YELLOW', 'RED');
create type public.conversation_source as enum ('SCREENSHOTS', 'TEXT');
create type public.message_kind as enum ('PASTED_CONVERSATION', 'RECOVERY_SENT', 'PROSPECT_RESPONSE');
create type public.analysis_status as enum ('PENDING', 'COMPLETE', 'INSUFFICIENT_EVIDENCE', 'ERROR');
create type public.approval_type as enum ('UNCHANGED', 'EDITED', 'MARKED_RED');
create type public.review_reason as enum ('NEW_SUBMISSION', 'PROSPECT_RESPONSE', 'REANALYSIS', 'CONTACT_RESTRICTION');
create type public.restriction_kind as enum ('EXPLICIT_OPT_OUT', 'PROHIBITED_CONTACT', 'OTHER');
create type public.restriction_source as enum ('AI_DETECTED', 'FOUNDER', 'CLIENT');
create type public.restriction_status as enum ('ACTIVE', 'DISMISSED_AS_MISREAD');

-- ---------------------------------------------------------------- identity

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  industry text not null default '' check (char_length(industry) <= 120),
  currency text not null default 'NGN' check (currency ~ '^[A-Z]{3}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- A client user belongs to exactly one business.
create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

-- Founder role. No API write path exists (see security migration); rows are
-- added only by a database administrator.
create table public.founders (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- cases

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  reference text not null check (char_length(btrim(reference)) between 1 and 40),
  product_service text not null check (char_length(btrim(product_service)) between 1 and 200),
  lead_source text not null check (lead_source in (
    'Facebook / Instagram Ads', 'Google', 'Referral', 'Website', 'Organic Social', 'Walk-in', 'Unknown', 'Other')),
  estimated_value numeric(14, 2) check (estimated_value is null or estimated_value >= 0),
  last_interaction_date date,
  client_context text check (client_context is null or char_length(client_context) <= 2000),
  conversation_source public.conversation_source not null,
  workflow_state public.workflow_state not null default 'DRAFT',
  -- Incremented whenever case evidence changes; analyses record the version they used.
  evidence_version integer not null default 0 check (evidence_version >= 0),
  review_reason public.review_reason,
  queued_at timestamptz,
  idempotency_key uuid not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (business_id, idempotency_key),
  unique (id, business_id)
);
create index cases_business_idx on public.cases (business_id, created_at desc);
create index cases_queue_idx on public.cases (queued_at) where queued_at is not null;

create table public.case_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  kind public.message_kind not null,
  body text not null check (char_length(btrim(body)) between 1 and 20000),
  attempt integer check (attempt is null or attempt >= 1),
  approval_id uuid,
  sent_exactly boolean,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  check (kind <> 'RECOVERY_SENT' or (attempt is not null and approval_id is not null and sent_exactly is not null)),
  check (kind = 'PASTED_CONVERSATION' or char_length(body) <= 5000)
);
create index case_messages_case_idx on public.case_messages (case_id, created_at);

-- Screenshot metadata. Storage wiring (bucket, uploads, content checks) is Stage 2A-2.
create table public.case_screenshots (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  position integer not null check (position between 1 and 10),
  storage_path text not null unique check (char_length(storage_path) <= 300),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  unique (case_id, position)
);

-- ---------------------------------------------------------------- private intelligence (founder only)

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  version integer not null check (version >= 1),
  status public.analysis_status not null default 'PENDING',
  evidence_version integer not null,
  evidence_manifest jsonb not null,
  prior_state public.workflow_state not null,
  model text check (model is null or char_length(model) <= 100),
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 50),
  output jsonb,
  ai_classification public.classification,
  ai_proposed_message text check (ai_proposed_message is null or char_length(ai_proposed_message) <= 2000),
  error text check (error is null or char_length(error) <= 2000),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  estimated_cost_usd numeric(10, 4) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  unique (case_id, version),
  -- A message is never proposed alongside a RED classification.
  check (ai_classification is distinct from 'RED' or ai_proposed_message is null)
);
-- At most one analysis in flight per case (the analysis lock).
create unique index analyses_one_pending_per_case on public.analyses (case_id) where status = 'PENDING';

-- Immutable approval history.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  analysis_id uuid references public.analyses (id),
  founder_id uuid references auth.users (id) on delete set null,
  evidence_version integer not null,
  approval_type public.approval_type not null,
  ai_classification public.classification,
  classification public.classification not null,
  ai_proposed_message text,
  approved_message text check (approved_message is null or char_length(btrim(approved_message)) between 1 and 2000),
  deal_situation text not null check (char_length(btrim(deal_situation)) between 1 and 500),
  next_action text not null check (char_length(btrim(next_action)) between 1 and 300),
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  -- RED never carries a message; GREEN/YELLOW always do.
  check ((classification = 'RED') = (approved_message is null)),
  check (approval_type <> 'MARKED_RED' or classification = 'RED'),
  -- Only a RED stop-contact decision may be made without an analysis.
  check (analysis_id is not null or classification = 'RED')
);
create index approvals_case_idx on public.approvals (case_id, created_at);

-- The latest approved, client-safe recommendation per case.
create table public.client_recommendations (
  case_id uuid primary key,
  business_id uuid not null,
  approval_id uuid not null unique references public.approvals (id),
  classification public.classification not null,
  deal_situation text not null,
  next_action text not null,
  approved_message text,
  published_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  check ((classification = 'RED') = (approved_message is null))
);

create table public.contact_restrictions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  kind public.restriction_kind not null,
  source public.restriction_source not null,
  status public.restriction_status not null default 'ACTIVE',
  note text check (note is null or char_length(note) <= 1000),
  evidence jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  dismissed_by uuid references auth.users (id) on delete set null,
  dismissed_reason text,
  dismissed_at timestamptz,
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  -- Only AI-detected restrictions can ever be dismissed, and only with a reason.
  check (status = 'ACTIVE' or (source = 'AI_DETECTED' and char_length(btrim(coalesce(dismissed_reason, ''))) >= 20
                               and dismissed_by is not null and dismissed_at is not null))
);
create index contact_restrictions_case_idx on public.contact_restrictions (case_id) where status = 'ACTIVE';

create table public.founder_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null,
  business_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  author uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade
);

-- ---------------------------------------------------------------- outcomes and audit

create table public.outcomes (
  case_id uuid primary key,
  business_id uuid not null,
  state public.workflow_state not null check (state in ('WON', 'LOST', 'PAUSED', 'DISQUALIFIED')),
  deal_value numeric(14, 2) check (deal_value is null or deal_value > 0),
  amount_paid numeric(14, 2) check (amount_paid is null or amount_paid > 0),
  payment_date date,
  note text check (note is null or char_length(note) <= 1000),
  recorded_by uuid references auth.users (id) on delete set null,
  recorded_by_role text not null check (recorded_by_role in ('CLIENT', 'FOUNDER')),
  created_at timestamptz not null default now(),
  foreign key (case_id, business_id) references public.cases (id, business_id) on delete cascade,
  check (state <> 'WON' or (amount_paid is not null and payment_date is not null))
);

-- Append-only. client_label marks entries a client may see in their case history.
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_role text not null check (actor_role in ('CLIENT', 'FOUNDER', 'SERVICE', 'SYSTEM')),
  action text not null,
  case_id uuid,
  business_id uuid,
  client_label text,
  details jsonb not null default '{}'::jsonb
);
create index audit_log_case_idx on public.audit_log (case_id, at);

-- ---------------------------------------------------------------- immutability and housekeeping

create function public.tg_forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'IMMUTABLE: % rows cannot be changed or deleted', tg_table_name using errcode = '42501';
end $$;

create trigger approvals_immutable before update or delete on public.approvals
  for each row execute function public.tg_forbid_change();
create trigger approvals_no_truncate before truncate on public.approvals
  for each statement execute function public.tg_forbid_change();
create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function public.tg_forbid_change();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.tg_forbid_change();

create function public.tg_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger cases_touch before update on public.cases
  for each row execute function public.tg_touch_updated_at();

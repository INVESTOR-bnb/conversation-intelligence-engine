# Stage 2A-1 — Database, Security and Authentication Plan

Status: **proposed — not authorised.** No Supabase resources exist; no code
for this increment has been written.

Goal: the smallest database + auth layer that enforces client isolation,
founder authority, evidence versioning, stale-approval protection and
non-overridable contact restrictions — **before** any storage or AI work.

Not in 2A-1: screenshot storage (2A-2), Claude calls (2A-3), new founder/client
screens beyond sign-in (2A-4/5).

## 1. Deliverables

1. SQL migrations in `recovery-prototype/supabase/migrations/` (version-controlled).
2. A local test harness: Postgres 16 with a minimal emulation of Supabase's
   `auth` schema and roles, plus SQL security tests (`supabase/tests/`).
3. Frontend data-access interface with two adapters:
   - **demo** — wraps the existing Stage-1 store (default; behaviour unchanged);
   - **live** — Supabase sign-in/sign-out, session, role lookup, route guards.
4. Real sign-in on the existing C01 login screen (live mode only). No visual redesign.
5. The same security tests re-run against the Supabase project with real JWTs.

## 2. Roles and identity

| Role | How it is established | Can it be self-assigned? |
|---|---|---|
| anon | No session | — |
| CLIENT | Row in `business_members` (user ↔ business) | No — insert only by founder RPC |
| FOUNDER | Row in `founders` | No — no API write path; seeded by a migration/manual SQL |

- Never derived from `user_metadata` (user-editable).
- Helpers (SECURITY DEFINER, `search_path = ''`): `is_founder()`,
  `is_member(business_id)`.
- Users are invited from the Supabase dashboard (invite-only); public sign-up
  disabled in Auth settings. No service-role key in the app.

## 3. Schema (initial)

All ids `uuid default gen_random_uuid()`; all timestamps `timestamptz default now()`.
Text columns have length `CHECK`s (e.g. messages ≤ 5 000 chars, notes ≤ 10 000).

| Table | Key columns | Notes |
|---|---|---|
| `businesses` | name, industry, currency | |
| `business_members` | business_id, user_id, unique pair | client ↔ business |
| `founders` | user_id (pk) | no insert/update/delete grants |
| `cases` | business_id, reference, product_service, lead_source, estimated_value, last_interaction_date, client_context, workflow_state, conversation_source, **evidence_version int**, idempotency_key (unique per business), created_by | **no private columns** |
| `case_messages` | case_id, business_id, kind (`PASTED_CONVERSATION`, `RECOVERY_SENT`, `PROSPECT_RESPONSE`), text, attempt, approval_id, sent_exactly, created_by | insert only via RPCs |
| `case_screenshots` | case_id, business_id, position, storage_path, mime, size_bytes, sha256, width, height | table now; storage wiring in 2A-2 |
| `analyses` | case_id, version, status (`PENDING`, `COMPLETE`, `INSUFFICIENT_EVIDENCE`, `ERROR`), **evidence_version**, **evidence_manifest jsonb**, model, prompt_version, output jsonb, error, usage/cost columns, requested_by | founder-only |
| `approvals` | case_id, analysis_id, founder_id, ai_classification, classification, deal_situation, next_action, ai_proposed_message, approved_message, approval_type, evidence_version | **immutable** |
| `client_recommendations` | case_id, business_id, approval_id, classification, deal_situation, next_action, approved_message | the only approved-content source for clients |
| `contact_restrictions` | case_id, business_id, kind, source (`AI_DETECTED`, `FOUNDER`, `CLIENT`), status (`ACTIVE`, `DISMISSED_AS_MISREAD`), evidence, dismissed_by/reason/at | see §5 |
| `founder_notes` | case_id, body, author | founder-only |
| `outcomes` | case_id, state, won fields, note, recorded_by | |
| `audit_log` | actor, action, case_id, details jsonb | **append-only** |
| `usage_limits` / counters | per-business daily counts | request limits |

Enums mirror Stage 1 (`src/domain/types.ts`): `workflow_state`, `classification`, `lead_source`.
State names are kept from Stage 1 to avoid churn ("admin" in a state name means the founder).

Immutability: `approvals` and `audit_log` get `BEFORE UPDATE OR DELETE` triggers
that raise, in addition to having no update/delete grants.

## 4. Access control

- RLS **enabled and forced** on every table. Default grants to `anon` and
  `authenticated` revoked; only `SELECT` re-granted where a policy exists.
  **No direct INSERT/UPDATE/DELETE for clients on any table.**
- `anon`: no access to anything.

| Table | CLIENT (member of business) | FOUNDER |
|---|---|---|
| businesses | own business: select | all |
| cases | own business: select | all |
| case_messages | own business: select (own pasted text, sent messages, responses) | all |
| client_recommendations | own business: select | all |
| outcomes | own business: select | all |
| analyses, approvals, founder_notes, contact_restrictions, audit_log, usage | **none** | select |
| founders, business_members | own membership row only | all |

### Guarded functions (SECURITY DEFINER, `search_path = ''`, EXECUTE revoked from `public`/`anon`)

Each function checks the caller, business membership, current state and input
limits, writes `audit_log`, and runs in one transaction.

| Function | Caller | Allowed from | Effect |
|---|---|---|---|
| `client_create_case(idempotency_key, …)` | client | — | creates case (idempotent), state `DRAFT`; daily limit |
| `client_submit_case(case_id)` | client | DRAFT | requires evidence present → `SUBMITTED`; `evidence_version`++ |
| `client_record_sent(case_id, approval_id, actual_text \| null)` | client | CLIENT_ACTION_REQUIRED, non-RED, no active restriction | → `WAITING_FOR_PROSPECT` |
| `client_add_response(case_id, text)` | client | WAITING_FOR_PROSPECT | → `PROSPECT_REPLIED`; `evidence_version`++ |
| `client_report_opt_out(case_id, note)` | client | any non-terminal | adds ACTIVE `CLIENT` restriction |
| `client_record_outcome(case_id, …)` | client | CLIENT_ACTION_REQUIRED, WAITING | terminal; WON requires amount + date |
| `client_list_cases()` / `client_get_case(id)` | client | — | returns only the client-safe projection |
| `founder_approve(case_id, analysis_id, expected_evidence_version, …)` | founder | AWAITING_ADMIN_REVIEW | see §5 |
| `founder_request_reanalysis(case_id)` | founder | AWAITING_ADMIN_REVIEW | → `REANALYZING` |
| `founder_add_restriction` / `founder_dismiss_ai_restriction(id, reason)` | founder | — | see §5 |
| `founder_pause_case`, `founder_add_member`, `founder_create_business` | founder | — | |
| `whoami()` | any signed-in | — | role + business ids (no secrets) |

The analysis-writing path (2A-3) runs only inside the Edge Function with the
service role; there is **no client- or browser-callable way to write an analysis**.

## 5. Founder security rules → enforcement

**Evidence version (rule 4).** `cases.evidence_version` increments whenever
evidence changes (submission, prospect response, screenshot changes in 2A-2).
Each analysis stores `evidence_version` and an `evidence_manifest` (screenshot
ids + sha256 + positions, message ids).

**Stale approval (rule 5).** `founder_approve` raises `STALE_ANALYSIS` unless:
the analysis is the case's latest non-ERROR analysis, `analysis.evidence_version
= cases.evidence_version = expected_evidence_version`, and the case is
`AWAITING_ADMIN_REVIEW`. The founder UI must re-load and re-review on this error.

**Contact restrictions (rule 6).**
- `founder_approve` rejects GREEN/YELLOW and any non-null message while the case
  has an ACTIVE restriction; only RED/no-message approval is possible.
- `FOUNDER` and `CLIENT` restrictions can never be removed through any API.
- An `AI_DETECTED` restriction may be dismissed **only** as
  `DISMISSED_AS_MISREAD` (the model misread the evidence), with a mandatory
  written reason, audited. *Founder decision required — see §8.*
- `client_record_sent` also refuses while a restriction is active.

## 6. Testing

**Local (no network, no cost).** Postgres 16 in the container:
- emulate `auth.users`, `auth.uid()` (from `request.jwt.claims`), roles
  `anon` / `authenticated` / `service_role`;
- apply migrations from scratch; run SQL tests as Client A, Client B, founder, anon.

Required tests:
1. Client A cannot select/insert/update Client B's businesses, cases, messages, recommendations, outcomes.
2. Client A cannot call any RPC on Client B's case.
3. Client cannot insert into `founders`, add themselves to another business, or gain founder rights via metadata.
4. anon gets nothing from any table or RPC.
5. Clients get zero rows from `analyses`, `approvals`, `founder_notes`, `contact_restrictions`, `audit_log`.
6. Stale approval is rejected after a new prospect response.
7. Active opt-out blocks GREEN/YELLOW approval and `client_record_sent`; FOUNDER/CLIENT restrictions cannot be dismissed.
8. `approvals` and `audit_log` cannot be updated or deleted, even by the founder.
9. Invalid state transitions are rejected (mirrors `tests/unit/transitions.spec.ts`).
10. Idempotent case creation returns the same case for the same key.

**On Supabase (after network + project are available).** Re-run 1–10 with real
users and JWTs through supabase-js; confirm Supabase's default grants did not
re-open anything. The local emulation is not proof on its own.

**Frontend.** Existing Stage-1 unit and e2e suites must stay green in demo mode.
Live mode: sign-in, sign-out, wrong password, role routing, a client blocked
from founder routes (UI guard + server rejection).

## 7. Prerequisites (founder actions)

1. **Network:** allow `supabase.com` and `supabase.co` for this environment (currently denied).
2. **Project:** create one Supabase **Free** project for synthetic data
   (region: nearest available to your users; confirm in the dashboard).
3. **Auth settings:** disable public sign-ups; email/password provider on.
4. **Migration access** — choose one:
   - (a) you run the migrations in the SQL editor / CLI from the repository; or
   - (b) give me the database connection string for this **staging project
     only**, rotated after 2A-1. Avoid an account-wide personal access token.
5. **Founder account:** invite yourself from the dashboard; the founder row is
   inserted by a one-line SQL statement you approve.
6. **Synthetic test users:** two client users + one second business for isolation tests.
7. **Frontend config:** project URL and anon (public) key via `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_ANON_KEY`. The service-role key is never needed by the app.

Cost of 2A-1: **$0** (Supabase Free; no Anthropic usage).

## 8. Decisions requested for 2A-1

1. Approve this schema and access model.
2. Approve the new runtime dependency `@supabase/supabase-js` (exact-pinned).
3. AI-detected opt-out: allow dismissal **only** as "misread" with an audited
   reason (recommended), or make every restriction permanent.
4. Migration access option (a) or (b) above.
5. Daily limits: cases per business per day (suggest 20); responses per case per day (suggest 10).

## 9. Known risks carried into 2A-1

- **Same prospect resubmitted as a new case** bypasses a restriction recorded on
  the old case. V0 has no prospect identity. Mitigation options (later): client
  attests no prior opt-out; founder-visible duplicate warning by reference/product.
- Local auth emulation can differ from Supabase; staging re-test is mandatory.
- Supabase Free projects pause after inactivity and have no backups — acceptable
  only for synthetic data.
- Supabase's built-in email sending is heavily rate-limited; enough for a few invites.

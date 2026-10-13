# Stage 2A-5d-3b — pipeline and Edge Function wired to the spending controls

**Status.** Code and local tests only. Nothing is deployed and no database change was
made: the 2A-5d-3a functions are used exactly as deployed. No AI provider is connected
and there is no API key. Spending stays **disabled**. The fake provider is the only
provider.

## What changed

The pipeline core (`supabase/functions/_shared/analysis-pipeline/`) now runs every
analysis through the database's spending controls. The Edge Function adapter
(`_shared/edge/supabaseRest.ts`) calls them with the service credential, the same
credential and headers as `internal_complete_analysis`.

Order of one run:

1. Restriction pre-check, then `founder_start_analysis` (lock and snapshot), then the
   snapshot restriction check, then evidence loading. All of this is unchanged.
2. **Reserve:** `internal_reserve_ai_spend(analysis, analyst model, reviewer model)`.
   - The database computes the amount and returns the approved model and output cap
     for each role.
   - Refusals become the run's code, and no provider call is made: `SPENDING_DISABLED`,
     `BUDGET_EXCEEDED`, `RATE_LIMITED`, `MODEL_NOT_PRICED`, `RESERVATION_TOO_LARGE`.
     Any other failure is `SPEND_RESERVATION_FAILED`.
   - A reservation for other models, or with a cap that is not a positive integer, is
     not used (`SPEND_RESERVATION_INVALID`).
   - The reservation is only attempted if there is still time for the analyst call.
3. **For each call (analyst, then reviewer):**
   1. **Deadline check.**
   2. **Dispatch record** (`internal_ai_dispatch`). If it fails, or its outcome is
      unknown, nothing is sent (`DISPATCH_FAILED_<ROLE>`). If it did commit, the
      database holds the money.
   3. **The request.** It uses the database-approved model and `max_output_tokens`.
   4. **Usage report** (`internal_ai_report_usage`). Usage is reported only when the
      provider returned plausible counts: whole numbers from 0 to 10,000,000. It is
      reported **before** the answer is judged, so a truncated, refused or invalid
      answer is still billed.
4. **Completion:** `internal_complete_analysis`. As before, it records the result and
   releases the lock. It settles the reservation from the dispatch record.

## How each requirement is met

| Requirement | How |
|---|---|
| Reserve before any provider request | Step 2. There is no code path to the provider without a valid reservation. |
| Record each dispatch before the request | Step 3.2, awaited. The database commits it before the RPC returns. |
| Report usage per role | Step 3.4. The database refuses usage for an undispatched call, and refuses a second report. |
| Enforce database-approved output limits | The request's `maxOutputTokens` is the database's cap. Output above the cap is reported in full and fails the run (`PROVIDER_LIMIT_EXCEEDED_<ROLE>`). Local configuration no longer has a cap. |
| No automatic retries | Providers must declare `maxRetries: 0`: a compile-time type and a runtime check (`PROVIDER_RETRIES_NOT_DISABLED`, before anything starts). The pipeline never retries, and the database refuses a second dispatch of a role. |
| Unknown usage is potentially billable | Usage is never reported as 0 by default. A provider error, a timeout, missing or implausible counts, or a failed usage report all leave the dispatched call without usage. Completion or abandonment then settles **HELD** at the full reservation. |
| Refuse when disabled, reservation fails or budget exhausted | Step 2. |
| Founder-only permissions and RLS | Unchanged. Founder reads still use the founder's JWT. The spending functions refuse founder, business and anonymous sessions (tested through the HTTP layer). |
| Fake provider kept; no Anthropic, no key | `FakeAnalysisProvider` declares `maxRetries: 0` and reports 0 tokens. It is priced at 0 with a cap of 1 in the database, so it reserves USD 0, but it still needs spending enabled. |
| Failures release the lock without releasing money | Every failure path still ends in `internal_complete_analysis` (ERROR) or `founder_abandon_analysis`. Both settle from the dispatch record: NO_DISPATCH means USD 0, otherwise HELD. If neither can be written (LOCK_HELD), the reservation stays RESERVED and counted. |

## Consequence on staging

Spending is disabled, so **every run on staging now ends `FAILED / SPENDING_DISABLED`**:
- no provider call is made;
- the lock is released;
- the case returns to SUBMITTED.

This includes runs with the fake provider. It is intended. Enabling spending (even only
for the USD 0 fake model) is a separate, explicit decision. The steps are in
`DEPLOY-STAGE-2A-5D-3A.md`.

## Tests (local only)

| Suite | What it covers |
|---|---|
| `tests/unit/pipeline.spec.ts` (+14) | order of calls; database caps used; every reservation refusal; invalid reservations; dispatch refused or lost; provider failure or timeout after dispatch leaves HELD with no retry; unknown or implausible usage never reported as 0; unusable answers still billed; cap overrun; failed usage report; retrying provider refused; deadline before reserving; abandon keeps HELD; LOCK_HELD keeps RESERVED |
| `tests/pipeline/pipeline-db.spec.ts` (+4) | the real ledger: exact settlement at each role's database price (USD 0.0210); HELD with the known lower bound after an analyst or reviewer failure; disabled means no request; a second dispatch is refused by the database |
| `tests/pipeline/edge-function.spec.ts` (+5, 3 updated) | over HTTP against the real database: disabled; budget exhausted; rate limit; unpriced model; dispatch RPC unreachable; usage RPC unreachable; spending RPCs refused to founder, business and anonymous sessions; the service credential used only for the six service calls, in order; LOCK_HELD keeps RESERVED and manual abandon settles |
| `tests/pipeline/edge-deno.spec.ts` | the same flow under real Deno |

**Mutation testing:** 14 deliberate defects in the new pipeline code. All 14 are caught
by the unit suite, and 7 of them are also caught by the database-backed suite. The
defects were:
- unknown usage reported as 0;
- no dispatch record;
- sending after a failed dispatch;
- a local cap instead of the database's;
- no reservation;
- an ignored refusal;
- a retrying provider allowed;
- usage not reported for unusable answers;
- a cap overrun accepted;
- a provider error retried;
- an unvalidated reservation;
- an ignored usage-report failure;
- no deadline check before reserving;
- a hidden refusal code.

## Remaining risks

- **A real provider adapter does not exist yet.** It must set `maxRetries: 0` on the
  SDK client, pass `maxOutputTokens` through unchanged, and return the provider's
  billed counts (input including any cache tokens; output including any thinking
  tokens). A wrong mapping makes reported usage too low. The database cannot detect
  that.
- **A run killed by the host** after a dispatch leaves the reservation RESERVED with
  the lock held. It needs founder abandonment, then reconciliation. This is the same
  limit as 2A-5d-4a, now with money held as well, which is the safe direction.
- **Concurrency across Edge Function instances** is enforced by the database
  (2A-5d-3a concurrency tests). The pipeline tests here run their database calls one
  at a time.

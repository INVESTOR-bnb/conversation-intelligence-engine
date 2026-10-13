# Stage 2A-5d-3a — server-enforced AI spending controls (database only, staging only)

**Status.** Implemented and tested locally. **Not deployed.**
- No AI provider is connected and no provider credential exists anywhere.
- The Edge Function (2A-5d-4b) does **not** call these functions yet. Wiring the
  pipeline to them is Stage 2A-5d-3b.
- Spending is **disabled** at deployment.

**What changes**
- **Database:** one migration, `20261018120000_stage2a5d3a_ai_spending.sql`.
  - Three private tables: `private.ai_spend_config`, `private.ai_model_prices`
    and `private.ai_spend_ledger`. RLS is on, there are no policies, and no API
    role (anon, authenticated, service_role) has any privilege on them.
  - Four private helpers that no API role can execute:
    - `private.ai_estimate_usd`
    - `private.ai_committed_usd`
    - `private.ai_settle`
    - `private.ai_reconcile`
  - Three service-role functions:
    - `internal_reserve_ai_spend`
    - `internal_ai_dispatch`
    - `internal_ai_report_usage`
  - One founder function: `founder_ai_spend_summary`. It is read-only and
    returns totals only.
  - `internal_complete_analysis` is the exact 2A-5b body plus one settlement
    call on each exit path (failure and success). It keeps:
    - every check: service role, contract, staleness;
    - restriction preservation;
    - its privileges.
  - `founder_abandon_analysis` is the exact 2A-1 body plus one settlement call.
- **No website change.**

## The rules

| Rule | Value | Where |
|---|---|---|
| Staging budget | USD 20 | `ai_spend_config.budget_usd` |
| New reservations stop at | USD 18 committed | `stop_at_usd` |
| Maximum reservation per analysis | USD 1 | `max_reservation_usd` |
| Founder attempts | 10 per rolling 24 h | `founder_attempts_24h` |
| Case attempts | 3 per rolling 24 h, 10 in total | `case_attempts_24h`, `case_attempts_total` |
| Spending | **disabled** by default | `enabled` |

- **What counts as an attempt:** a successful reservation. Refused reservations
  write nothing and do not count.
- **How the limits are protected:**
  - Only the database owner (Supabase SQL Editor) can change them.
  - No application role can read or write the tables, so the founder cannot
    raise a limit through the app.

### Reservation (before any provider call)
- **Who calls it:** the pipeline calls
  `internal_reserve_ai_spend(analysis_id, analyst_model, reviewer_model)` while the
  analysis is PENDING.
- **What it computes from:** the analysis's frozen evidence snapshot, never a
  caller-supplied amount.
- **How it prices:** each call separately, at each model's own snapshotted
  prices and output cap.

```
E      = 6 tokens × UTF-8 bytes of the snapshot's messages + 64 × messages + 5000 × screenshots
A_in   = 8000 (prompt overhead) + E                     A_out = analyst model's output cap
R_in   = 8000 + E + 2 × A_out  (reviewer also receives the analyst's output)
R_out  = reviewer model's output cap
reserved = ceil to USD 0.0001 of (A_in·a_in + A_out·a_out + R_in·r_in + R_out·r_out) / 1,000,000
```

- **Refused, with nothing written:**

  | Error | When |
  |---|---|
  | `SPENDING_DISABLED` | spending is disabled |
  | `MODEL_NOT_PRICED` | either model is unknown or inactive |
  | `VALIDATION` | the snapshot cannot be measured |
  | `RATE_LIMITED` | a rate limit is reached |
  | `RESERVATION_TOO_LARGE` | the reservation is above USD 1 |
  | `BUDGET_EXCEEDED` | committed spend plus this reservation would exceed USD 18 |

- **No overshoot under concurrency:** every reservation locks the single
  configuration row, so concurrent requests cannot overshoot. This was tested
  with real concurrent sessions, plus a control showing that the unlocked
  version does overshoot.
- **What the pipeline must use:** the returned `max_output_tokens` per role.
  That cap is what the reservation priced.

### Dispatch, usage, settlement — why a zero never releases money by mistake

1. **Before each provider request** the pipeline must call
   `internal_ai_dispatch(analysis_id, 'ANALYST' | 'REVIEWER')` and commit it.
   - Dispatch rules:
     - each role can be dispatched once, so there are no retries inside a
       reservation;
     - the reviewer can only be dispatched after the analyst's usage is
       reported;
     - no dispatch is possible once the analysis is finished or the reservation
       is settled.
   - **If the dispatch call fails or its outcome is unknown**, the pipeline must
     not call the provider.
2. **After each response** the pipeline calls
   `internal_ai_report_usage(analysis_id, role, input_tokens, output_tokens)`:
   - once per role;
   - only for a dispatched role;
   - with no overwrite.
3. **Settlement** happens automatically inside `internal_complete_analysis`
   (every path) and `founder_abandon_analysis`. The token counts and cost the
   pipeline passes to `internal_complete_analysis` are **ignored** for money.

| Dispatch record | Result |
|---|---|
| No role dispatched | `SETTLED` at USD 0 (`NO_DISPATCH`): no request may leave without a committed dispatch |
| Every dispatched role reported usage | `SETTLED` at Σ tokens × that role's snapshotted prices (`REPORTED_USAGE`) |
| A dispatched role has no usage (crash, timeout, provider error after sending, lost response, abandoned) | `HELD` (`UNKNOWN_USAGE`): **the full reservation stays committed** until reconciliation |
| Actual above the reservation | recorded in full, flagged `overrun`, **spending disabled**, audited `AI_SPEND_OVERRUN` |
| Analysis still running (the process died; nobody completed or abandoned it) | stays `RESERVED` and committed |

**Committed spend:**
- `SETTLED` and `RECONCILED` rows count at their actual amount;
- everything else counts at the larger of the reservation and the known usage.

## Deploy (only after founder approval)

**Database only (Supabase SQL Editor, staging project `aqwdwswpmbnzmkvyuqil`,
after Stage 2A-5d-2).** There is no Edge Function or website step.

On Android (Chrome), for each file:
1. Open the file on GitHub, on branch
   `claude/revenue-recovery-engine-stage-1-8xg8vf`, under
   `recovery-prototype/supabase/deploy/`.
2. Tap **Raw**, then select all and copy.
3. In Supabase → **SQL Editor** → **New query**, paste it as one query and tap
   **Run**.

**The files, in order:**
1. **`stage2a5d3a_deploy.sql`.** Expected: "Success. No rows returned". It is all
   or nothing.
   - **Refuses**, changing nothing, if:
     - 2A-5d-2 is missing;
     - `internal_complete_analysis` is not byte-for-byte the reviewed 2A-5b
       version;
     - `founder_abandon_analysis` is not byte-for-byte the reviewed 2A-1
       version;
     - 2A-5d-3a is already applied;
     - your role cannot bypass RLS.
   - **Aborts** and undoes everything if:
     - a spending table is reachable by an API role;
     - a function has the wrong privileges or no pinned `search_path`;
     - spending is enabled;
     - completion lost its contract, restriction preservation or settlement
       calls;
     - the estimator self-test does not give 0.2204;
     - the settlement self-test does not behave as reviewed. The four cases are:
       no dispatch → 0; dispatched without usage → HELD; reported usage →
       exact; overrun → disables spending. This self-test runs on synthetic
       rows that are undone.
2. **`stage2a5d3a_verify.sql`.** Expected **PASS (8 pass, 0 fail, 2 info)**.
   - Row 9 must say `disabled`.
   - Row 10 shows the ledger: reserved, held, settled, reconciled, overrun and
     stuck counts.
   - Before deployment (or after rollback) this file stops with "does not
     exist". That also means "not applied".
3. **Re-run the earlier verify files.** All must show **OVERALL PASS**:
   - `stage2a5d2_verify.sql`
   - `stage2a5d1_verify.sql`
   - `stage2a5b_verify.sql`
   - `stage2a5a_verify.sql`
   - `stage2a4c1_verify.sql`
   - `stage2a4c_verify.sql`
   - `stage2a4b_verify.sql`
   - `stage2a1_verify.sql`

If anything says FAIL, REFUSED or ABORTED, stop and send the output.

## Administration (SQL Editor only; do NOT do this until 2A-5d-3b is reviewed)

**Before enabling spending for any real model:**
1. Set a **hard monthly spend limit of USD 20** (or lower) in the AI provider's
   console. The database limit protects against our own bugs. It cannot stop a
   leaked key being used elsewhere.
2. Add one price row per real model, using prices **verified on the provider's
   pricing page on the day**. Use USD per million tokens, and the output cap the
   pipeline will send:

```sql
insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note)
values ('<exact model id>', <input price>, <output price>, <output cap>, true, 'Verified on <date> at <pricing page URL>');
```

**Enable or disable spending.** Disabling is safe at any time. A running
analysis keeps its reservation.

```sql
update private.ai_spend_config set enabled = true,  updated_at = now() where id;
update private.ai_spend_config set enabled = false, updated_at = now() where id;
```

**Retire a model.** Existing reservations keep their snapshotted prices.

```sql
update private.ai_model_prices set active = false where model = '<exact model id>';
```

**See what needs attention.** This lists held reservations, and reserved ones
whose analysis is no longer running:

```sql
select l.analysis_id, l.status, l.reserved_usd, l.actual_usd, l.analyst_dispatched_at, l.reviewer_dispatched_at,
       l.analyst_input_tokens, l.reviewer_input_tokens, a.status as analysis_status, l.created_at
from private.ai_spend_ledger l left join public.analyses a on a.id = l.analysis_id
where l.status = 'HELD' or (l.status = 'RESERVED' and coalesce(a.status::text, '') <> 'PENDING')
order by l.created_at;
```

**Reconcile one held reservation** to what the provider actually billed. Take
the amount from the provider's usage console for that request or time window.
- The note is required: at least 20 characters, saying where the amount came
  from.
- Reconciliation is audited as `AI_SPEND_RECONCILED`.
- A reservation can be reconciled only once.
- A reservation whose analysis is still running cannot be reconciled.

```sql
select private.ai_reconcile('<analysis id>', <billed USD>, 'Provider usage console, <date>, request <id>: <amount>');
```

**After an overrun**, spending is disabled automatically. Find the cause before
you re-enable it:

```sql
select * from private.ai_spend_ledger where overrun;
```

**Raising a limit** is a deliberate SQL Editor change, for example
`update private.ai_spend_config set budget_usd = 30, stop_at_usd = 27 where id;`.
- The table rejects a stop line above the budget.
- No application role can make this change.

## Rollback
1. **Run `stage2a5d3a_rollback.sql`.** It:
   - disables spending;
   - restores `internal_complete_analysis` exactly as 2A-5b and
     `founder_abandon_analysis` exactly as 2A-1 (its self-check compares md5s
     and privileges);
   - drops the eight spending functions;
   - **keeps the three tables and every ledger record**, which stay private;
   - is audited, and a second run is refused.
   - A later re-deployment re-uses the kept records and is disabled again.
2. **Rollback order is strict.** `stage2a5d2_rollback.sql` and
   `stage2a5b_rollback.sql` refuse while 2A-5d-3a is installed.
3. **Warning:** after rollback nothing reserves, limits or settles AI spending.
   Do not run a real provider while it is rolled back.

## Tests (local only)
- **`supabase/tests/16_ai_spending.test.sql`** (95 assertions). It covers:
  - reservation arithmetic for different-priced models (the order matters),
    screenshots and caps;
  - every refusal;
  - rate limits, budget exhaustion and the stop line;
  - dispatch rules;
  - settlement on every path, including a provider failure after dispatch with
    zero tokens reported;
  - abandoned runs, overrun and reconciliation;
  - authorization for anon, business, founder and service role, with and
    without the claim;
  - the founder summary.
- **`supabase/scripts/test-deploy-2a5d3a.sh`** (117 checks). It covers:
  - the generated files;
  - a control on 2A-5d-2;
  - deploy, verify and all earlier verifies;
  - the contract and restriction scenarios unchanged;
  - the full spending flow through the deployed files, including authorization,
    rate limits, budget, overrun and reconciliation;
  - injected weaknesses and sabotaged bodies aborting the deployment;
  - preflight refusals and verify detection;
  - rollback (records kept, functions identical to 2A-5d-2), re-deploy, and the
    full reverse order.
- **`supabase/scripts/test-concurrency-2a5d3a.sh`** (8 checks, real concurrent
  sessions). It covers:
  - budget races;
  - the founder-limit race;
  - duplicate dispatch;
  - abandon racing dispatch;
  - an unlocked control that overshoots.
- **Mutation testing:** 45 deliberate defects in the migration (formula, limits, locks, dispatch rules, settlement paths, privileges, contract and restriction checks). Every one is caught by at least one of the three suites. The lock defect is caught only by the concurrency test.

## Not covered and remaining risks
- **The estimate is not the bill.** Tokenizers, image token counts and
  provider-side extras (for example, thinking tokens) can exceed the
  6-tokens-per-byte and 5000-per-image assumptions. Overruns are detected,
  recorded and stop spending, but only after the money is spent. The
  provider-console limit is the backstop.
- **The service role is trusted to report usage honestly.** A compromised
  service key could under-report usage. It could not raise limits or touch the
  tables directly.
- **HELD and stuck rows need a human.** Each one keeps up to USD 1 committed
  until it is reconciled.
- **Nothing calls this yet.** 2A-5d-3b must make the pipeline:
  - reserve;
  - dispatch and commit before each call;
  - report usage;
  - use the returned caps;
  - disable SDK retries.

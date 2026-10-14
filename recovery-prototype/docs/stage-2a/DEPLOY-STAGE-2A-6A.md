# Stage 2A-6a — reservation terms for pre-dispatch checks (database only)

**Status.** Implemented and tested locally. Deployed to staging by the founder;
verification reported `PASS (4 pass, 0 fail, 1 info)`. No AI provider, no credentials,
no spending change. Stage 2A-6b's pipeline now uses this function before every dispatch.

## What changes
- **Migration:** `20261019120000_stage2a6a_reservation_terms.sql` adds **one** function:
  `public.internal_ai_reservation_terms(analysis_id) -> jsonb`.
- **What the function returns,** for an existing spending reservation, exactly as the
  ledger recorded it:
  - for each call (analyst, reviewer): the model, the output cap (`max_output_tokens`),
    the **input-token bound**, and the **snapshotted** input and output prices per
    million tokens;
  - the reservation's status and its reserved amount.
- **Why:** before a real provider request is dispatched, the pipeline (Stage 2A-6b)
  must prove the request is inside what the database reserved:
  - its counted input tokens are at most the reserved bound;
  - its output cap equals the reserved cap;
  - the model and prices the provider code expects equal the snapshotted prices.

  Any mismatch refuses the run before the dispatch record. The reservation then
  settles at USD 0, as no request could have left.
- **How it is locked down:**
  - it can only read the ledger: it is declared *STABLE*, so PostgreSQL refuses any
    write inside it;
  - it executes as `SECURITY DEFINER` with an empty `search_path`;
  - only the **service role** may execute it, and the function also checks the
    service-role claim itself;
  - refusals: `FORBIDDEN` (any other caller) and `NOT_RESERVED` (no reservation).
- **Unchanged:**
  - every 2A-5d-3a function (reserve, dispatch, report usage, settle, reconcile,
    summary);
  - completion, abandonment, the analysis contract, every table, policy, privilege,
    spending setting, price, and all data.

  The post-install check proves this with a fingerprint of those functions and a
  check of the data and settings.
- **The fake-provider pipeline is unaffected:** it does not call the new function. The
  pipeline and Edge Function tests pass with 2A-6a installed.

## Deploy (only after separate founder approval; staging only)
Supabase SQL Editor (staging project `aqwdwswpmbnzmkvyuqil`), **after Stage 2A-5d-3a**.
For each file in `recovery-prototype/supabase/deploy/`: open it on GitHub → **Raw** →
copy → paste as one query → **Run**.

1. **`stage2a6a_deploy.sql`.** Expected: "Success. No rows returned". It is all or
   nothing.
   - **Refuses**, changing nothing, if:
     - 2A-5d-3a is missing;
     - 2A-6a is already applied;
     - your role cannot bypass RLS.
   - **Aborts** and undoes everything if:
     - the function is not STABLE, not SECURITY DEFINER, or has no pinned
       `search_path`;
     - it is callable by anyone but the service role;
     - its self-test fails. The self-test runs on a synthetic ledger row, which is
       undone. It checks: the exact terms, `NOT_RESERVED` for no reservation, and
       `FORBIDDEN` for a non-service caller;
     - any existing spending, contract or settlement function changed;
     - any data, setting or price would change;
     - a spending table gained a policy, or analyses are no longer founder-only.
2. **`stage2a6a_verify.sql`.** Expected **PASS (4 pass, 0 fail, 1 info)**. Row 5 shows the
   spending state, which this stage does not change.
3. **Re-run `stage2a5d3a_verify.sql`** (expected `PASS (8 pass, 0 fail, 2 info)`) and the
   earlier verification files. All must show **OVERALL PASS**.

**Risk assessment:**
- Additive only, with no data change, so the deployment risk is **very low**.
- The new function exposes nothing to any client.
- Spending stays disabled.

## Rollback
- **`stage2a6a_rollback.sql`:**
  - drops the function and nothing else (its self-check compares fingerprints, data,
    settings and prices before and after);
  - is audited, and a second run is refused.
- **Effect:** a Stage 2A-6b pipeline would then refuse to dispatch paid requests. The
  fake provider keeps working.
- **Order:** `stage2a5d3a_rollback.sql` now refuses while 2A-6a is installed. Roll back
  2A-6a first.

## Tests (local only)
- **`supabase/tests/17_reservation_terms.test.sql`** (19 assertions). It covers:
  - exact per-call terms, matching the ledger and the reservation;
  - recomputing the reserved amount from the terms;
  - prices are the snapshot, not the current price list;
  - swapped models;
  - the status after an abandoned dispatched run;
  - both refusals;
  - the founder, business and anonymous callers denied;
  - a non-service token refused inside the function;
  - the definition and privileges;
  - reading writes nothing.
- **`supabase/scripts/test-deploy-2a6a.sh`** (56 checks). It covers:
  - the generated files;
  - a control on 2A-5d-3a;
  - deploy, verify and every earlier verify;
  - nothing else changed;
  - behaviour and authorisation;
  - re-run and single-query mode;
  - 8 injected weaknesses and 3 sabotaged bodies aborting the deployment;
  - the preflight refusal;
  - verify detecting 3 weaknesses;
  - rollback (refusal order, nothing else changed, re-deploy, full reverse order).
- **Mutation testing:** 8 deliberate defects in the migration, all caught.

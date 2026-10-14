# Stage 2A-6c — Anthropic model prices (inactive) and adapter review

**Status.** Implemented and tested **offline only**.
- Not deployed.
- No staging change, no provider key, no paid call.
- Spending stays disabled.

## What changes

### Database: one migration, `20261020120000_stage2a6c_model_prices.sql`
Two rows are added to `private.ai_model_prices`. Nothing else changes: no function, table, policy, privilege, setting, existing row or data.

| Model | USD per million tokens (input / output) | Output cap (`max_output_tokens`) | Active |
|---|---|---|---|
| `claude-opus-5-5` | 4 / 20 | 8,000 | **no** |
| `claude-sonnet-5-5` | 2 / 10 | 8,000 | **no** |

- **Prices.** Verified 2026-10-14 against the official models overview and pricing pages. They are the standard-tier, global-inference list prices; both models also have a 128K maximum output and a 1M context.
- **The 8,000 cap is provisional.** Thinking tokens count as output, and each call has 55 seconds. The paid evaluation should calibrate it.
- **Inactive means unusable.** The existing reservation function refuses inactive models (`MODEL_NOT_PRICED`). So neither model can be reserved, and therefore neither can be called, until a separately approved step activates it.
- **Unchanged:** the fake provider's row, the USD 20 budget, the USD 18 stop threshold, the USD 1 per-analysis limit and the **disabled** state. The deployment self-check proves all of these.

**What one analysis may cost**, under the existing reservation formula, once a model is active:

| Analyst + reviewer | Reserved for a 1,000-byte conversation | Largest conversation within USD 1 |
|---|---|---|
| Opus + Opus | USD 0.4966 | about 11 KB |
| Opus + Sonnet | USD 0.3564 | about 18 KB |
| Sonnet + Sonnet | USD 0.2483 | about 32 KB |

Larger cases are refused by the existing limit (`RESERVATION_TOO_LARGE`).

### Prices and caps cannot silently differ

The values live in three places, and each pair is checked:

| Pair | How it is enforced |
|---|---|
| Database ↔ code | **At runtime, before every dispatch.** The pipeline compares the reservation's snapshot with the code allowlist (`ANTHROPIC_MODELS` in `anthropicProvider.ts`): prices must be exactly equal, and the cap must equal the **approved cap**. New in this stage: any other cap is refused with `SPEND_TERMS_MISMATCH` (`…_CAP_NOT_APPROVED`) and USD 0. |
| Migration ↔ code ↔ deployment files | **In tests.** A unit test reads the migration, the deployment self-check and the verification file, and requires the same prices and caps as the allowlist. |
| Database ↔ reservation logic | **In the deployment self-check and the deploy tests.** The existing estimate function is run on the new rows under the live configuration and must give the reviewed amounts. |

### Adapter review

1. **`service_tier` is removed.**
   - Priority Tier is not offered on Opus 5.5 or Sonnet 5.5, and Priority Tier commitments are no longer sold, so the parameter only added compatibility uncertainty.
   - The response check stays: `usage.service_tier` must be `standard` or absent, otherwise the bill is untrusted and the reservation is HELD.
2. **`inference_geo: "global"` is kept, deliberately.**
   - It is a documented value and the default.
   - Left out, a workspace whose default is `"us"` would run the request at **1.1×**, above the reservation's snapshot price.
   - Sent explicitly, such a workspace instead **rejects** the request (HTTP 400). That leaves the reservation HELD, but it can never bill above the snapshot.
   - **Precondition for any paid test:** the Anthropic workspace must allow `"global"` inference. Confirm this when the key is created.
3. **Token counting no longer creates an untracked disclosure.** In 2A-6b the free `count_tokens` request ran after the reservation but **before** the dispatch record. It sent the conversation to Anthropic, and the database had no record of that if the run then stopped. Now:
   - **The order is:** reservation → terms check → **dispatch record (committed)** → count → generation.
   - **Every request that carries conversation data is on the ledger**, whether it only counted or also generated. A refused dispatch sends nothing at all.
   - **If the count refuses the call** (input over the reserved bound, or the count fails or hangs), no generation request was made. Counting is documented as free, so the call's usage is reported as **0/0** and the reservation settles at USD 0, with the dispatch, that is the disclosure, recorded. This is evidence-based, not an assumption: the code never issued the generation request.
   - **If that 0/0 report itself fails**, the reservation is **HELD**, as before.
   - **Counting does not bypass spending authorisation.** It runs only for a reserved, terms-checked, dispatched call. A priced call from a provider that cannot count is still refused **before** its dispatch (`TOKEN_COUNT_UNAVAILABLE_<ROLE>`).

## Deploy (NOT authorised yet — separate founder approval; staging only)

Supabase SQL Editor (staging project `aqwdwswpmbnzmkvyuqil`), **after Stage 2A-6a**. For each file in `recovery-prototype/supabase/deploy/`: open it on GitHub → **Raw** → copy → paste as one query → **Run**.

1. **`stage2a6c_deploy.sql`.** Expected: "Success. No rows returned". It is all or nothing.
   - **Refuses**, changing nothing, if:
     - 2A-6a is missing;
     - spending is **enabled**;
     - a row for either model already exists (it never overwrites a row);
     - your role cannot bypass RLS.
   - **Aborts** and undoes everything if:
     - the rows differ in any way from the reviewed values, or either is active;
     - any model other than the fake is active;
     - the budget, stop or per-analysis limit is not 20 / 18 / 1, or spending is enabled;
     - the estimate for the new rows is not the reviewed amount;
     - any function, data, ledger row, configuration or existing price changed;
     - a spending table became readable by a client.
2. **`stage2a6c_verify.sql`.** Expected **PASS (5 pass, 0 fail, 1 info)**. Row 6 shows what a 1,000-byte case would reserve.
3. **Re-run the earlier verification files:**
   - `stage2a6a_verify.sql`: expected (4 pass, 0 fail, 1 info);
   - `stage2a5d3a_verify.sql`: expected (8 pass, 0 fail, 2 info);
   - every earlier file must show **OVERALL PASS**.

**Risk:** very low.
- Two inactive rows; there is no code path that can reserve them.
- Prices are not readable by any client: only the database owner can read them.

## Rollback

`stage2a6c_rollback.sql`:
- deletes the two rows and nothing else;
- **refuses** while either row is active, or while an unsettled (RESERVED or HELD) reservation uses either model;
- settled ledger rows keep their own price snapshot;
- is audited; a second run is refused.

**Order:** `stage2a6a_rollback.sql` now refuses while 2A-6c is installed. The full reverse order is 2A-6c → 2A-6a → 2A-5d-3a.

## Tests (offline)

| Suite | What it covers |
|---|---|
| `supabase/scripts/test-deploy-2a6c.sh` (73 checks) | **Generated files:** up to date, and nothing in them beyond one insert and one scoped delete. **Deploy and verify:** a control before deployment; deploy and verify; every earlier verification; nothing else changed. **Behaviour:** inactive rows refused even with spending enabled; prices private. **Synthetic activation** (local only): reservations of 0.4534 (Opus + Opus) and 0.2267 (Sonnet + Sonnet) for a 100-byte case; the terms carry exactly 4/20 and the 8,000 cap; 11 KB fits the USD 1 limit and 12 KB is refused. **Robustness:** re-run and single-query mode; 12 injected weaknesses abort the deployment; 3 preflight refusals; verify catches 5 weaknesses. **Rollback:** the 2A-6a rollback is refused first; refused while active; refused while a HELD reservation exists; succeeds and changes nothing else; redeploy works; the full reverse order works. |
| `supabase/tests/18_model_prices.test.sql` (9) | Both install modes: exact rows, inactive; the fake row and configuration unchanged; reservations refused; prices private. |
| `tests/unit/anthropicProvider.spec.ts` | Updated for the 8,000 caps and the request body without `service_tier`. New: an unapproved cap is refused; counts happen only after the dispatch record; a refused or failed count reports 0/0; a failed 0/0 report is HELD; a refused dispatch sends nothing; the migration, deployment files and allowlist agree. |
| `tests/pipeline/anthropic-db.spec.ts`, `edge-anthropic.spec.ts` | Now run on the migration's own rows, activated locally only and restored to inactive. An over-bound count is recorded as a dispatch with 0/0 usage, at USD 0, in the real ledger. |

**Mutation testing:** 10 deliberate defects, all caught. They covered:
- the pipeline: the cap-approval check removed; the 0/0 report removed; counting moved back before the dispatch; an uncountable provider allowed;
- the adapter: `service_tier` reintroduced; `inference_geo` removed;
- the code allowlist: a different cap; a different price;
- the migration: a model active; a different cap.

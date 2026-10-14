# Stage 2A-6d — guarded deployment of the Anthropic-capable function, and one paid synthetic run

**Status.** Implemented and tested **offline only**.
- Nothing deployed.
- No credentials, no paid call, no spending change.
- Each phase below needs its **own** founder approval.

| Phase | What | Changes on staging | Cost |
|---|---|---|---|
| A | Deploy the Anthropic-capable `analyze-case` code, **fake provider configured** | Function code only | USD 0 |
| B | **One** paid synthetic analysis | For seconds-to-minutes only: function settings, one or two price rows set active, spending on. All restored. | At most the database's estimate: USD 0.2436 (Sonnet + Sonnet) to USD 0.4871 (Opus + Opus); hard limits USD 1 per analysis, USD 3 per run |

## Phase A — deploy with the fake provider

**Before**
- **A Codespace** on `claude/revenue-recovery-engine-stage-1-8xg8vf`, at the pushed commit.
- **A scoped Supabase access token:**
  - permissions: Edge Functions **read-write**, Edge Function Secrets **read-write**;
  - staging project only;
  - shortest expiry.

**Run**
```bash
bash
set +o history
cd recovery-prototype
git pull --ff-only
bash supabase/scripts/deploy-analyze-case-2a6d.sh
```

**Refusals.** The script refuses, deploying nothing (exit 2), unless all of these hold:
- the branch is right, the checkout is clean and pushed, and it contains Stage 2A-6c (`20cbdf2`);
- the code passes `function-source-guard.mjs`:
  - the pinned SDK `npm:@anthropic-ai/sdk@0.133.0`, only in `analyze-case/index.ts`;
  - nothing shaped like a key, no other library, no retries, no fallbacks;
  - every reviewed safeguard present;
- you type `aqwdwswpmbnzmkvyuqil` back;
- the token is shaped `sbp_…`;
- the function's settings contain **no** paid-provider setting: no `ANTHROPIC_*`, `ALLOW_PAID_PROVIDER`, `ANALYST_MODEL` or `REVIEWER_MODEL`.

**What it then does**
- Deploys **only** `analyze-case`, with `verify_jwt = true`.
- Sets **only** `ANALYSIS_PROVIDER=fake` and `ALLOW_FAKE_PROVIDER=staging-only`.
- Never sets a key, never switches the provider, never touches the database.

**After deploying**
1. **Security check:** `bash supabase/scripts/analyze-case-live-check.sh` (unchanged; expect 51 pass, 0 fail).
2. **Fake regression** (optional, approval as before): `bash supabase/scripts/fake-pipeline-e2e.sh`.
   - It now accepts exactly the reviewed Anthropic-capable code, and still refuses any paid setting among the secrets.
   - Expected: 30 pass, 0 fail, USD 0.

**Code rollback** (restores today's fake-only function, commit `9ee3767`):
```bash
bash supabase/scripts/deploy-analyze-case-2a6d.sh --rollback
```

## Phase B — one paid synthetic analysis (separate approval)

**Before. Founder actions in the Anthropic console** (the script cannot verify any of these; you confirm them by typing):
1. Create a **dedicated workspace** for this evaluation.
2. Set its **spending limit** to an amount you choose, at most USD 15. USD 5 is suggested.
3. Make sure it **allows global inference**.
4. Create **one API key in that workspace only**.
5. **Scoped Supabase token permissions:** Database **read-write**, Edge Functions **read**, Edge Function Secrets **read-write**.

**Run**
```bash
bash
set +o history
cd recovery-prototype
git pull --ff-only
bash supabase/scripts/paid-pipeline-e2e.sh
```

**Prompts:**
- token (hidden);
- publishable key;
- the three synthetic accounts (passwords hidden);
- the Anthropic key (hidden);
- the analyst and reviewer models (`claude-sonnet-5-5` / `claude-opus-5-5`);
- your workspace limit in USD;
- the run budget (at most 3).

### 1. Read-only audit

It stops, changing nothing, if any of these fails:
- spending is disabled;
- the free fake is the only active model;
- both paid price rows are exactly as reviewed and inactive;
- nothing is RESERVED or HELD;
- the function is ACTIVE with the JWT check on, and its deployed source is the reviewed Anthropic-capable version;
- the settings are fake, with no key;
- the accounts are correct.

Client A then creates **one** synthetic case (`E2E-PAID-…`, invented text, 802 bytes). The database's own estimate of the most it can cost must be within all of:
- the run budget;
- the USD 1 per-analysis limit;
- your provider limit.

### 2. Confirmations

1. Type `PROVIDER-LIMIT-CONFIRMED`: confirms the workspace limit and global inference.
2. Type `RUN-ONE-PAID-ANALYSIS`.

Anything else, including extra spaces, lower case or an empty line, changes nothing.

### 3. The window

1. Writes the function settings: `ANALYSIS_PROVIDER=anthropic`, `ALLOW_PAID_PROVIDER=staging-only`, the key, the models, `ANTHROPIC_EFFORT=medium`. Reads them back by name.
2. **One guarded SQL statement** activates exactly the chosen model(s) and enables spending, only if all of these still hold:
   - spending is still off;
   - the rows still have the reviewed prices and caps;
   - no other paid model is active;
   - nothing is unsettled.

   Otherwise nothing changes, and the settings are removed again.
3. **One** founder call.
4. **Immediately after the call:** spending off and both paid models inactive (retried, then read back). Then the key and paid settings are deleted and the fake restored (read back).

This also runs on any failure, Ctrl-C, SIGTERM, SIGHUP or crash of the script.

### 4. Verification

- The analysis was made by the chosen paid models.
- Exactly one new ledger row.
- Reserved within the budget.
- **Settled from reported usage**, or a clear **HELD** to reconcile.
- No overrun.
- Spending, models and settings off; limits unchanged.
- Founder-only access: client A, client B and anonymous see nothing.

The analysis text is **not** printed. Read it in the founder workspace.

**Exit codes:** 0 pass · 1 a check failed (all restored) · 2 refused (nothing changed) · 3 platform JWT rejected (restored; do not use `--no-verify-jwt`) · **4 something could not be confirmed off: follow the printed steps now** · 130 interrupted (restored).

**After the run**
1. Revoke the Anthropic key, or keep it only if the next evaluation step is approved.
2. Revoke the Supabase token.
3. Delete the Codespace.

## Recovery: paid provider off (any time)

```bash
bash supabase/scripts/paid-pipeline-e2e.sh --paid-off
```
It needs only the token. It:
- disables spending;
- deactivates both paid models;
- deletes `ANTHROPIC_API_KEY`, `ALLOW_PAID_PROVIDER`, `ANALYST_MODEL`, `REVIEWER_MODEL` and `ANTHROPIC_EFFORT`;
- restores the fake settings;
- reads everything back.

**Without a Codespace:**
1. Supabase SQL Editor: run `supabase/deploy/stage2a6d_paid_off.sql` (database part).
2. Dashboard → Edge Functions → Secrets: delete those five settings and set `ANALYSIS_PROVIDER=fake`.
3. Revoke the key in the Anthropic console.

## What cannot be guaranteed, and the exposure if it fails

- **If the Codespace dies inside the window**, the paid configuration stays on until `--paid-off`. The exposure is bounded by the database and the provider:
  - only the founder's JWT can start an analysis;
  - each analysis is at most USD 1;
  - 10 attempts per founder per 24 hours;
  - the USD 18 stop;
  - and your provider-side limit.
- **Supabase may keep a warm function instance's old settings** for a while.
  - **Stale fake during the run:** the run costs USD 0, and the script reports "the function still ran the FAKE".
  - **Stale paid after the run:** the database refuses any reservation, because spending is off and the models are inactive. No paid request can be made.

## Tests (offline)

| Suite | What it covers |
|---|---|
| `tests/unit/stage2a6d.spec.ts` (11) | **Source guard:** the current code passes and the old code is identified; 14 injected violations are caught. **Deployed-bundle guard.** **Price agreement:** the paid script's price table equals the code allowlist (and so the migration). **Targets:** the staging project is the only target; no JWT bypass. **The deploy script, run for real** with a fake Supabase CLI: the fake-only deploy and the rollback; refusal with each paid setting present (both modes); unreadable settings; wrong reference; malformed token; a committed key literal; another library; wrong branch, dirty, unpushed, pre-2A-6c; unknown option; a failed deploy sets nothing. |
| `tests/pipeline/paid-e2e.spec.ts` (40) | **The paid script as a real process** against the real local database: Supabase and Management API emulators (including secret write and delete), the real handler re-reading its settings on every request, and the Anthropic API scripted. **Covers:** the approved run (order of operations, exact cost 0.0228, key only reaching the function, nothing printed); Opus + Sonnet; 6 wrong or missing confirmations; 18 refusals before any change; a token without settings-write; two database-guard races; 5 window failures (function 500, platform 401, provider 500 → HELD, stale fake configuration, failed switch-off retried); SIGINT, SIGTERM and SIGHUP mid-call; an unrecoverable database switch-off (exit 4, then `--paid-off`); unrecoverable settings removal (exit 4, then `--paid-off`); `--paid-off` with nothing to do. |
| `tests/pipeline/fake-e2e.spec.ts` (+5) | The fake regression accepts the reviewed Anthropic-capable code. It refuses that code with a key-shaped string or a missing safeguard, and with `ALLOW_PAID_PROVIDER` or a model choice among the secrets. |

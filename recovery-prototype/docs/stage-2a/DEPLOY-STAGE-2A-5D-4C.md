# Stage 2A-5d-4c — first controlled staging deployment of `analyze-case` (Android runbook)

> **From Stage 2A-6b on, this script refuses the branch's function code**: it now contains the
> pinned Anthropic SDK (inert without a key and explicit configuration). This is deliberate. Staging keeps
> the deployed fake-only function (code as of `9ee3767`). Deploying the 2A-6b code needs its own approved
> stage. See `STAGE-2A-6B-ANTHROPIC-ADAPTER.md`.

**Scope.** This deploys the `analyze-case` Edge Function to the Supabase **staging** project
`aqwdwswpmbnzmkvyuqil` only, then checks it.
- **Provider:** the fake only (`ANALYSIS_PROVIDER=fake`).
- **No AI provider:** no Anthropic or other paid provider, and no API key.
- **Spending stays disabled.** No database, permission or migration change.
- **Synthetic data only.**

With spending disabled, every founder run ends `FAILED / SPENDING_DISABLED`:
- no provider call is made (not even the fake);
- the lock is released;
- nothing is reserved.

That is the expected result of this stage.

## What you need
- **A GitHub Codespace** on branch `claude/revenue-recovery-engine-stage-1-8xg8vf` (Chrome on
  Android → the repository → **Code** → **Codespaces** → create).
- **A Supabase personal access token**, created just for this: Supabase → Account → Access
  Tokens → name `codespace-once`. Use the shortest expiry offered. You will revoke it at the
  end.
  - **Why it matters:** a personal token can manage every project on your account. The deploy
    script only ever uses `aqwdwswpmbnzmkvyuqil`, and makes you type it back first.
- **The staging publishable key** (`sb_publishable_…`), and the three **synthetic** accounts
  from Stage 2A-4c:
  - Client A and Client B, linked to **different** synthetic businesses;
  - the founder.

## Step 1 — Codespace terminal

```bash
bash
set +o history
cd recovery-prototype
git pull --ff-only
git log -1 --format='%h %s'
```

The last line must show the Stage 2A-5d-4c commit, or a later one on this branch.

## Step 2 — Deploy (one command)

```bash
bash supabase/scripts/deploy-analyze-case-staging.sh
```

**1. It first checks, and stops with `REFUSED (nothing deployed)` otherwise:**
- the checkout is this branch;
- the checkout is clean, identical to GitHub, and contains Stage 2A-5d-3b;
- the function code has no AI-provider SDK, endpoint or key.

**2. It then shows the target and asks two questions:**
- **Type the project reference to confirm:** type `aqwdwswpmbnzmkvyuqil` exactly.
- **Supabase access token (hidden):** paste it. Nothing appears; that is expected.

**3. Then it does exactly three things:**
- deploys **only** `analyze-case`, with the platform JWT check **on** (`verify_jwt = true`);
- sets `ANALYSIS_PROVIDER=fake` and `ALLOW_FAKE_PROVIDER=staging-only`;
- lists the deployed functions.

**4. Expected end:** `DEPLOYED. Next: …`.

**If something goes wrong:**
- **`DEPLOY FAILED`:** nothing else was changed. Send the output.
- **`SETTINGS FAILED`:** the function is deployed but refuses every call (503). Send the
  output.

## Step 3 — Security test (one command)

```bash
bash supabase/scripts/analyze-case-live-check.sh
```

It asks for the publishable key and the three synthetic accounts. Passwords are hidden. The
values exist only while the script runs and are never printed.

**What it does:**
- creates **one** synthetic text case, `AC-LIVE-<time>`, as Client A;
- tests, through the deployed function (details below): founder authentication, the platform
  JWT check, unauthenticated and unauthorised callers, business-user rejection, invalid
  requests, the spending-disabled behaviour, and that businesses and anonymous callers cannot
  read analyses or spending information;
- signs every session out (this session only).

**Result by exit code:**

| Exit code | Meaning | What to do |
|---|---|---|
| `0` | every check passed (`== N pass, 0 fail …`) | go to step 4 |
| `1` | a check failed (`FAIL …` lines) | send the output; leave the function in place, or disable it (see Rollback) |
| `2` | stopped before testing (refused value, missing setting, spending enabled, wrong accounts) | read the `stopped:` line |
| `3` | **the platform rejected the founder's valid session token** | **STOP.** Do **not** redeploy with `--no-verify-jwt`. Send the output. The function refuses every call, so nothing is exposed. |

**What it checks:**

| Area | Checks |
|---|---|
| Spending | disabled at the start; unchanged after the run (nothing reserved, held or committed) |
| Platform JWT check | the founder's session reaches the function's own code |
| Callers who must get 401 | no token; the publishable key used as a token; a forged token |
| Callers who must get 403 | Client A on its own case; Client B; the founder from another website |
| Nothing started | no analysis is created by any refused call |
| Invalid requests (founder) | wrong method (405); wrong content type (415); not JSON (400); extra field (400); body over 1 KiB (413); unknown case (404) |
| Founder run | `FAILED / SPENDING_DISABLED`; the founder reads the analysis as ERROR with no output, classification or message; the case is `SUBMITTED` again; a second run is accepted and refused again |
| Businesses and anonymous callers | no rows from `analyses`; the analysis invisible even by id; no rows from `contact_restrictions`; spending summary refused; private spending tables unreachable; every service-only function refused |
| Client A's own case view | carries nothing from the analysis or spending |
| Control | the founder **can** read the analysis |

## Step 4 — Clean up (always)

```bash
exit
```

1. Supabase → Account → Access Tokens → **revoke** `codespace-once`.
2. github.com/codespaces → ⋯ → **Delete** the Codespace.

Optional read-only confirmation in the SQL Editor:

```sql
select enabled from private.ai_spend_config;            -- false
select count(*) from private.ai_spend_ledger;           -- unchanged from before
select reference, workflow_state from public.cases where reference like 'AC-LIVE-%' order by created_at desc limit 3;
```

Then re-run `stage2a5d3a_verify.sql`. Expect `PASS (8 pass, 0 fail, 2 info)`.

## Rollback
- **Instant refusal of every call:** Dashboard → Edge Functions → Secrets → delete
  `ANALYSIS_PROVIDER`. Calls then get 503 `PROVIDER_NOT_CONFIGURED`.
- **Remove the function:** Dashboard → Edge Functions → analyze-case → Delete.

Neither changes the database.

## Not covered
- The fake provider actually running end to end needs spending enabled. That is a separate,
  explicit decision, not part of this stage.
- Screenshot cases (CPU and memory limits on the free plan) are not exercised. The live check
  uses one text case.

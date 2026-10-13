# Stage 2A-5d-4d — guarded fake-provider end-to-end test on staging (Android runbook)

**Status.** The script and its offline tests exist. **It has not been run against
staging.** Run it only after explicit approval.

**What it proves:**
- the deployed `analyze-case` function, using the **fake** provider, analyses one synthetic
  WhatsApp-style text case end to end;
- evidence integrity;
- analysis completion;
- the adversarial review;
- ledger settlement at **USD 0**;
- case states and the audit trail;
- founder-only access.

**What it never does:**
- connect Anthropic or any paid provider;
- deploy anything;
- change a migration, a permission or production.

**The only change it makes:** spending is enabled for the seconds the single call takes, and
only after you type `ENABLE-FAKE-SPENDING`.

## What you need
- **A GitHub Codespace** on `claude/revenue-recovery-engine-stage-1-8xg8vf`.
- **The staging publishable key** (`sb_publishable_…`).
- **The three synthetic accounts:** Client A and Client B, in different businesses, and the
  founder.
- **A new scoped Supabase access token.** Supabase → Account → Access Tokens → **Generate
  new token** → **scoped** (scoped tokens start `sbp_fc`):

  | Setting | Value | Used for |
  |---|---|---|
  | Organisation and project | only the staging project `aqwdwswpmbnzmkvyuqil` | — |
  | **Database** | **Read-write** | Run a query: the read-only checks, plus the two writes (the guarded enable and the disable) |
  | **Edge Functions** | **Read** | Get a function (status, `verify_jwt`); Get a function body (the deployed source, scanned) |
  | **Edge Function Secrets** | **Read** | List all secrets (names only; values are digests and are never printed) |
  | Everything else | none | — |
  | Expiry | the shortest offered | — |

  These permission names come from Supabase's scoped-token permission table: *Run a query*
  under Database; *Get a function* and *Get a function body* under Edge Functions; *List all
  secrets* under Edge Function Secrets. **How they are enforced can only be confirmed live.**
  - A missing permission makes the script stop with "the access token lacks a permission
    for …", naming the missing permission.
  - That happens before spending is touched. If it is the write that is refused, the script
    confirms spending is still off.
  - A classic (legacy) token also works, but can do anything on your account. **Prefer
    scoped.**

## The test (one command)

```bash
bash
set +o history
cd recovery-prototype
git pull --ff-only
bash supabase/scripts/fake-pipeline-e2e.sh
```

Enter the token (hidden), the publishable key and the three accounts (passwords hidden). Then:

**1. Read-only audit.** It stops with `stopped: …` and changes nothing if any of these fails:
- spending is **disabled**;
- the only active priced model is `FAKE-PROVIDER-NOT-AI`, at USD 0 input and 0 output;
- `analyze-case` is **ACTIVE** with the platform JWT check **on**;
- the **deployed** source:
  - downloads, and is checked against its recorded hash;
  - contains the fake provider and the spending controls;
  - contains no AI-provider library, endpoint or key;
- the function's secrets include `ANALYSIS_PROVIDER` (confirmed `fake` when its digest allows)
  and `ALLOW_FAKE_PROVIDER`, and no provider key name;
- the accounts are two clients of different businesses, plus the founder.

Client A then creates and submits **one** synthetic WhatsApp-style case, `E2E-FAKE-<time>`.

**2. Your approval.** Type `ENABLE-FAKE-SPENDING` exactly. Anything else (including extra
spaces or lower case) ends the run, and spending is never touched.

**3. The window. It lasts seconds:**
- One SQL statement enables spending **only if** it is still off **and** the free fake is
  still the only priced model. The database re-checks this at that moment. If it refuses,
  nothing is changed.
- **One** founder call to `analyze-case`.
- Spending is **disabled immediately**, before any result is read. The script retries, then
  reads the setting back to confirm.

**4. Verification (spending is already off):**

| Area | Checks |
|---|---|
| Evidence integrity | snapshot version 2; exactly one message; its SHA-256 equals the hash of the exact text submitted |
| Analysis | `INSUFFICIENT_EVIDENCE` under `rre-analysis/2`; the fake model for both calls; 0 tokens; cost 0; every text labelled as a fake test; no findings |
| Adversarial review | `UPHOLD_WITH_CONCERNS`, with its challenge |
| Ledger | `SETTLED` from reported usage; reserved 0; actual 0; both calls dispatched (analyst first); 0 tokens; prices 0 |
| Spend totals | committed unchanged; exactly one new ledger row; nothing open, held or overrun |
| Case and audit | case `SUBMITTED` before and `AWAITING_ADMIN_REVIEW` after; audit trail, in order: created, submitted, started, reserved, completed, settled |
| Access | the founder reads the analysis; Client A, Client B and anonymous see no analysis (not even by id), no audit trail, no restrictions and no spending information; Client A's own case view carries nothing from the analysis; Client B can't read Client A's case |

**Result by exit code:**

| Exit code | Meaning |
|---|---|
| `0` | all passed (`== N pass, 0 fail`) |
| `1` | a check failed. Spending is already off. Send the output. |
| `2` | refused or stopped. Spending was never enabled, or was restored. Read the `stopped:` line. |
| `3` | the platform rejected the founder's session token. Spending is off. **Do not redeploy with `--no-verify-jwt`**; send the output. |
| `4` | **spending could NOT be confirmed off.** Do the recovery below **now**. |
| `130` | interrupted. Spending was disabled first if it had been enabled. |

## Recovery (spending off, nothing else)

```bash
bash supabase/scripts/fake-pipeline-e2e.sh --disable-spending-only
```

It needs only the access token. If even that fails, run this in the Supabase **SQL Editor**:

```sql
update private.ai_spend_config set enabled = false, updated_at = now() where id;
select enabled from private.ai_spend_config;   -- must be false
```

## Cleanup is not guaranteed if the Codespace dies

The script disables spending itself after the call, on any failure, on Ctrl-C and on
SIGTERM, SIGHUP or a crash of the script.

**It cannot run** in these cases:
- the Codespace is stopped or deleted;
- the machine loses power;
- the network drops during the window and stays down.

In those cases **spending stays enabled** until you run the recovery above.

- **What that costs:** USD 0. The function only accepts the fake provider, and the fake is
  the only priced model, at 0.
- **How you would notice:**
  - the next `analyze-case-live-check.sh` refuses to run while spending is enabled;
  - `stage2a5d3a_verify.sql` row 9 reads `ENABLED`.
- **To avoid it:** keep the phone awake and the tab open until the script prints `exit code:`.

## Afterwards
1. Supabase → Account → Access Tokens → **revoke** the token.
2. github.com/codespaces → **Delete** the Codespace.

**What stays on staging:**
- one synthetic case, `E2E-FAKE-<time>`, with its fake analysis (founder-only, labelled);
- one USD 0 ledger row;
- its audit rows.

## Offline tests (no staging access)

`tests/pipeline/fake-e2e.spec.ts` runs the real script as a child process against the
**real local test database**:
- the real Supabase API emulation;
- the real `analyze-case` handler, behind an emulated platform JWT check;
- a Management API emulator that executes the script's SQL as the database owner, and serves
  the real function sources EZBR-encoded, the way a CLI deployment uploads them.

Every other host is blocked. It covers:
- the approved run, with window ordering;
- six wrong approval phrases;
- sixteen refusals before enabling: unexpected or non-zero-priced models; spending already on;
  `verify_jwt` off; the function not active; a provider library in the deployed source; an
  unreadable source; an old version; a provider secret; missing settings; missing token
  permissions (database read, Edge Functions read, secrets read); a rejected token; an API
  failure;
- the database guard (a paid model appearing at the last moment; someone else enabling
  spending);
- a token without database write;
- failures inside the window (a function error; a platform JWT rejection; a failed first
  disable);
- failed restoration (exit 4, and the state really is still on), then recovery;
- SIGINT, SIGTERM and SIGHUP during the call, and Ctrl-C at the prompt;
- a business able to read analyses;
- non-zero recorded spend;
- recovery-only mode;
- credential and URL guards;
- and the fixed SQL.

**Mutation testing:** 13 deliberate defects in the script, all caught by these tests.

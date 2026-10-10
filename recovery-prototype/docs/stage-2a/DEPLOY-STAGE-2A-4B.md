# Stage 2A-4b — client cases and founder case view (Android runbook)

**What changes**

- **Database:** four SELECT policies only. `cases`, `case_messages`,
  `case_screenshots` and `outcomes` become founder-only for direct reads.
  Clients read their cases only through `client_list_cases()` and
  `client_get_case()`. No tables, columns, grants, functions or data change.
- **Site:** clients can create and submit cases with a pasted, synthetic
  conversation. The founder sees a **Submitted cases** list and a read-only
  case page.

**Order:** database first, then the site. Each works with the other's old
version: the current live site never reads case tables directly.

Synthetic data only. Never paste real customer conversations, names or phone
numbers.

---

## Step 1 — Database (Supabase SQL Editor, phone browser)

All files are in the repository under `recovery-prototype/supabase/deploy/`,
on branch `claude/revenue-recovery-engine-stage-1-8xg8vf`. On GitHub, open a
file, tap **Raw**, select all and copy.

1. **Before:** run `stage2a4b_client_view_check.sql` with your synthetic
   client's User ID in place of `REPLACE_WITH_CLIENT_USER_ID`. If that client
   has a case, you will see non-zero `direct_*` counts: that is the exposure
   being fixed. If the client has no case yet, the counts are 0; that's fine.
2. **Deploy:** paste the whole of `stage2a4b_deploy.sql` into a new query →
   **Run**. Expected: "Success. No rows returned". It runs in one transaction:
   any error means nothing changed. A second run is refused with
   "Stage 2A-4b is already applied".
3. **Verify:** run `stage2a4b_verify.sql`. Every row must be **PASS**
   (row 8 is INFO). Then run `stage2a1_verify.sql`; it must still be
   **OVERALL PASS**.
4. **After:** run the client view check again: `direct_cases`,
   `direct_outcomes`, `direct_messages` and `direct_screenshots` must all be
   **0**. `role_seen` must be **CLIENT**. The check always rolls back.

If any row says FAIL, stop and send the output. Do not deploy the site.

## Step 2 — Site (GitHub Actions, phone browser)

1. Chrome → `https://github.com/INVESTOR-bnb/conversation-intelligence-engine/actions`
   (use "Desktop site" if the button is missing).
2. **Deploy recovery prototype (Cloudflare Pages)** → **Run workflow** →
   *Use workflow from*: `claude/revenue-recovery-engine-stage-1-8xg8vf` → **Run workflow**.
3. Wait for the green tick (about 5–8 minutes). It runs the unit and browser
   tests before building. A red cross means nothing was deployed.

## Step 3 — Phone checks

1. **Client** (incognito tab): sign in → **New case** → reference `TEST-001`,
   product, lead source, and a made-up conversation of at least 20
   characters → **Submit Case**. The case shows **Under review**.
2. **Founder:** **Submitted cases** shows `TEST-001` with the business name.
   Open it: the conversation appears exactly as pasted.
3. **Client:** open `https://revenue-recovery-v0.pages.dev/app/founder/case/<id>`,
   with the case ID from the founder's address bar → **Not authorised**.
4. Run the client view check again (Step 1.4). Direct counts stay 0 and
   `via_client_function` is at least 1.
5. Sign-out, sign-in, onboarding (create business, link client) still work.

## Rollback

- **Site:** Cloudflare → Workers & Pages → `revenue-recovery-v0` →
  **Deployments** → the previous deployment → **⋯ → Rollback to this deployment**.
- **Database** (only if the policy change itself causes a problem): run
  `stage2a4b_rollback.sql`, then `stage2a1_verify.sql` (must be OVERALL PASS).
  This **re-opens the client exposure**. It touches no data. A second run is
  refused ("Stage 2A-4b is not applied").

Neither rollback touches sign-in, the founder account, businesses, members or
cases.

## What was tested, and where

Locally on PostgreSQL 16 with a Supabase emulation; not on Supabase itself:

- deploy;
- re-run refusal;
- SQL-Editor single-query mode;
- injected failures and truncated copies roll back completely;
- the preflight refuses unexpected or partial states;
- verification detects weaknesses;
- rollback restores the exact 2A-1 policies;
- re-deploying after a rollback;
- running alongside Supabase's `rls_auto_enable` helper;
- the client view check.

Browser tests use a mocked Supabase. Real-staging proof comes from Step 1
(verify and client view check) and the Step 3 phone checks.

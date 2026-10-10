# Deploying Stage 2A-1 to the Supabase staging project

Project: `https://aqwdwswpmbnzmkvyuqil.supabase.co` (staging, synthetic data only).
Status: **prepared and tested locally — not deployed.** Deploy only after founder approval.

## Files

- Deployment: `recovery-prototype/supabase/deploy/stage2a1_deploy.sql`
- Verification: `recovery-prototype/supabase/deploy/stage2a1_verify.sql`

## What the deployment does and does not do

- Runs the three Stage 2A-1 migrations, unchanged, inside **one transaction**:
  everything is created or nothing is.
- **Refuses to run** (and changes nothing) if Stage 2A-1 is already installed,
  if schema `public` already contains other tables/functions/types, or if the
  database is missing Supabase's `auth` schema or API roles.
- **Tolerates exactly one pre-existing object**: Supabase's auto-RLS helper
  `public.rls_auto_enable()` with its event trigger `ensure_rls`, and only if it
  matches the founder-verified definition in
  `supabase/deploy/known/rls_auto_enable.verified.sql` on every property
  (body, return type, language, owner, SECURITY DEFINER, `search_path`, single
  `ensure_rls` trigger on `ddl_command_end`, no other callers or dependents).
  It is **never modified**: the migrations skip it when tightening function
  privileges, and the self-check aborts the deployment if its definition,
  owner, privileges or event trigger changed during deployment.
- **Self-checks before committing**: if row level security, privileges,
  function permissions or the immutability triggers are not as designed, the
  whole deployment is rolled back.
- Records one `SCHEMA_DEPLOYED` row (with the migrations' SHA-256 hashes) in the
  audit log.
- Creates **no users, no founder, no businesses, no data**; contains **no
  credentials**; never disables row level security or triggers.

## Running it on Android (Chrome)

Use Chrome rather than the GitHub app; switch to **Desktop site** (⋮ menu) if
the pages below look cramped.

1. **Copy the deployment file.** On github.com (signed in), open the repository
   `INVESTOR-bnb/conversation-intelligence-engine`, switch to branch
   `claude/revenue-recovery-engine-stage-1-8xg8vf`, and open
   `recovery-prototype/supabase/deploy/stage2a1_deploy.sql`. Tap the
   **Copy raw file** icon (two overlapping squares) in the file header.
   If that icon is not shown, tap **Raw**, then long-press → **Select all** → **Copy**.
2. **Open the SQL Editor.** In another tab go to supabase.com → your project
   (`aqwdwswpmbnzmkvyuqil`) → **SQL Editor** → **New query**.
3. **Paste** into the empty editor (long-press → Paste).
4. **Check the copy is complete** before running:
   - the first line starts with `-- ====` and the next says
     `REVENUE RECOVERY ENGINE — STAGE 2A-1 DEPLOYMENT`;
   - the **last line** reads
     `-- END OF DEPLOYMENT FILE — if this line is missing, the copy is incomplete: do not run.`
   If the last line is missing, clear the editor and copy again. (A truncated
   copy cannot commit anything, but there is no reason to run it.)
5. **Run once.** Tap **Run**. If Supabase shows a warning about potentially
   destructive operations, that is caused by words such as `on delete cascade`
   and `before truncate` in the definitions; the file contains no DROP, DELETE
   or TRUNCATE statements. Confirm to run.
6. **Expected result:** "Success. No rows returned" (the confirmation notices,
   including "Verified pre-existing Supabase function public.rls_auto_enable()
   … left unchanged", may not be displayed). Any error means **nothing was changed**: take a
   screenshot of the message and stop — do not run it again or edit it.
7. **Verify.** **New query** → copy and paste
   `recovery-prototype/supabase/deploy/stage2a1_verify.sql` the same way → **Run**.
   The first row must be **OVERALL | PASS** with **0 fail**. On the staging
   project expect "17 pass, 0 fail, 3 info" or "16 pass, 0 fail, 4 info"
   (row 16 may be INFO on Supabase because its internal admin role has its own
   default grants). **Row 20** must be **PASS**: Supabase's `rls_auto_enable`
   helper is unchanged since deployment.
   Take a screenshot of the whole result.
8. **Manual check:** **Project Settings → Data API** (or **API**): the exposed
   schemas must be `public` and `graphql_public` only — **not** `private`.
9. Do **not** run anything under `supabase/tests/`. Send the screenshots back
   before any further step (founder bootstrap, test users, remote tests).

## Compatibility with real Supabase — what local tests cannot prove

Local tests ran on PostgreSQL 16 with a minimal emulation of Supabase's `auth`
schema and API roles. They prove the SQL logic, the transaction/rollback
behaviour and the authorization rules **as modelled**. They cannot prove:

| Area | Risk | How it will be caught |
|---|---|---|
| SQL Editor execution model | Not verified whether the editor sends the file as one query message or splits it. Both modes were tested locally and both are all-or-nothing; a different model is the main unknown. | Verification step 7; the audit entry exists only if the transaction committed |
| Hosted `postgres` role privileges | It is not a superuser on Supabase. The deployment needs CREATE on the database, REFERENCES on `auth.users` (standard Supabase pattern) and ownership of what it creates. | A missing privilege makes the deployment fail and roll back |
| PostgreSQL version | New Supabase projects may run PostgreSQL 17; tested on 16 only. The SQL uses no version-specific features. | Preflight requires ≥ 15; any incompatibility fails and rolls back |
| Supabase event triggers / auto-RLS | Supabase's own DDL hooks (e.g. API schema reload) run during deployment. Not expected to conflict. | Deployment error → rollback |
| Default grants of Supabase's internal roles | Objects created later in `public` by Supabase's admin role could receive API grants. Our tables are unaffected. | Verification row 16 (INFO) |
| Data API (PostgREST), GraphQL (pg_graphql), Auth JWT claims | Real request-time behaviour of roles and claims (e.g. `service_role` claim for `internal_complete_analysis`) is emulated, not exercised. | Remote API tests with synthetic users (next step) |
| Deleting auth users later | Deleting a user who has **approved** a recommendation is blocked: the foreign key tries to null `approvals.founder_id`, which the immutability trigger forbids. Intentional (approver identity is kept) but surprising in the dashboard. | Known limitation; erasure procedure due in 2A-2 |
| Supabase CLI migration history | The SQL Editor does not record migrations in `supabase_migrations.schema_migrations`. If the CLI is used later, mark these three versions as applied (`supabase migration repair --status applied 20261009120000 20261009120100 20261009120200`) before `db push`. | Documented here |

## Change log

**2026-10-10 — pre-existing `public.rls_auto_enable()`.** The first live run
was refused (correctly) because the staging project contains Supabase's
auto-RLS helper. After founder verification of its definition and metadata:
the guard accepts that exact object only; the two blanket `REVOKE ... ON ALL
FUNCTIONS IN SCHEMA public` statements in the migrations now skip it (so its
privileges are not altered); the post-install self-check and the verification
script exempt it from the "no function callable by anon" rule (an
event-trigger function cannot be called directly — tested) and check it is
unchanged; regression tests cover the verified function and 15 tampered or
unexpected variants. Two latent guard bugs were found and fixed at the same
time: plain-text failure messages raised "malformed array literal" instead of
the intended explanation (deployment still aborted safely), and the helper
fingerprint compared privilege lists in their stored order rather than
canonically.


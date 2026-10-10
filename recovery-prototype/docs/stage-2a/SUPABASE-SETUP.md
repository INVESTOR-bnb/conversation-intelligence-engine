# Stage 2A-1 — Supabase setup runbook (staging, synthetic data only)

Nothing in this runbook has been executed against Supabase from the
development environment: its network policy blocks `supabase.com` /
`supabase.co`. All results so far come from the local test harness.

## A. What the founder does (dashboard)

1. **Confirm Auth settings** (done 2026-10-09): public sign-ups off, anonymous
   sign-ins off, manual linking off, email confirmation on.
2. **Apply the migrations** — use the single-transaction file and steps in `DEPLOY-STAGE-2A-1.md` (preferred). Legacy option: apply them in order, in *SQL editor* (or `supabase db push`
   / `psql` with the connection string):
   1. `supabase/migrations/20261009120000_stage2a1_schema.sql`
   2. `supabase/migrations/20261009120100_stage2a1_security.sql`
   3. `supabase/migrations/20261009120200_stage2a1_functions.sql`
   Do **not** apply anything under `supabase/tests/local/` — that is a local
   emulation of Supabase for testing only.
3. **Founder account:** follow `STAGING-AUTH-DEPLOY.md` Steps 1–5 (site first,
   then URL configuration, then a fresh invite, then
   `supabase/admin/bootstrap_founder.sql` with your email **and** User ID).
4. **Synthetic clients:** invite two test addresses you control
   (e.g. plus-addresses). Then, signed in as founder through the app/API:
   `founder_create_business('Synthetic Autos A')`, `founder_add_member(...)`.
   Until linked, an invited user has role `NONE` and can read nothing.
5. **Never** paste the service-role key or database password into chat, the
   repository, or frontend environment variables.

## B. What the development environment needs

| Need | Why | Status |
|---|---|---|
| Network: allow `supabase.com`, `supabase.co` | API, auth and database access | **Blocked** |
| Project URL + anon (public) key | frontend live mode and remote API tests | Not provided |
| Migration access: (a) founder applies, or (b) staging DB connection string, rotated afterwards | apply migrations, run SQL tests remotely | Not decided |

## C. Remote verification (to do once B is resolved)

1. Apply migrations (A.2).
2. Run the SQL authorization suite on staging inside rolled-back transactions:
   load `supabase/tests/local/01_test_helpers.sql`, run each
   `supabase/tests/*.test.sql`, then `drop schema tests cascade;`.
   Unverified assumption: Supabase's `postgres` role may not be allowed to
   insert synthetic rows into `auth.users`; if so, the seed step must use
   invited synthetic users instead.
3. Repeat the isolation checks through the real API with real JWTs
   (two client users + founder + anon) — proves PostgREST/GoTrue behaviour that
   the local emulation cannot.
4. Record results in the 2A-1 report. Until then, 2A-1 is **verified locally only**.

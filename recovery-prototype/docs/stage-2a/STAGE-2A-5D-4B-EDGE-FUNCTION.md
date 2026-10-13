# Stage 2A-5d-4b — `analyze-case` Edge Function (implemented and tested locally; NOT deployed)

**Status.** Code and local tests only.
- Nothing is deployed.
- No database change: no migration, no change to RLS or the contract.
- No AI provider and no API key.
- The only provider is a **fake** that writes clearly labelled pipeline-test
  records, and only on the staging project.

## Files

| File | Role |
|---|---|
| `supabase/functions/analyze-case/index.ts` | Deno entry point: `Deno.serve(createAnalyzeCaseHandler(...))` |
| `supabase/functions/_shared/edge/handler.ts` | Request handling: CORS, method, auth, body, the pipeline run, sanitised responses |
| `supabase/functions/_shared/edge/auth.ts` | Caller verification: JWT via Supabase Auth, then founder role via `whoami` |
| `supabase/functions/_shared/edge/supabaseRest.ts` | `FounderDb` / `ServiceDb` adapters over PostgREST, Storage and Auth (plain `fetch`) |
| `supabase/functions/_shared/edge/config.ts` | Environment parsing; fails closed |
| `supabase/functions/_shared/edge/fakeProvider.ts` | The labelled fake provider |
| `supabase/functions/_shared/analysis-pipeline/` | Stage 2A-5d-4a core, unchanged |

## The four security questions (from Supabase's documentation, read 2026-10-13; behaviour on our project still unverified)

**1. Does our service-role check work with the new secret keys? Not verified; it needs a probe.**
- `internal_complete_analysis` requires `auth.jwt() ->> 'role' = 'service_role'`.
- The docs say a secret key runs as the **`service_role` Postgres role**. They
  also say secret keys "are short strings, not JWTs" and go on the `apikey`
  header, not `Authorization: Bearer`.
  ([API keys](https://supabase.com/docs/guides/api/api-keys))
- They don't say what JWT claims PostgREST sees for a secret-key request.
- A recent single-user report describes the API gateway minting a short-lived
  `service_role` JWT for secret keys (and failing to on one project).
  ([supabase#50801](https://github.com/supabase/supabase/issues/50801))
- So it may work, and it may differ by project. The legacy `service_role` JWT
  carries the claim by construction.
- **What the code does:**
  - A `sb_secret_` key is sent on `apikey` only; a legacy JWT goes on both
    headers.
  - If the claim is missing, completion raises `FORBIDDEN`. The pipeline then
    records nothing and releases the lock through `founder_abandon_analysis`.
    This is tested ("UNVERIFIED-CASE REHEARSAL").
  - It fails safe but won't work until resolved. See the probe below.

**2. How the function gets and validates the founder's JWT.**
- **The platform check doesn't authenticate.** `verify_jwt` (on by default) also
  accepts publishable and secret keys on either header, "for migration
  compatibility". The docs say passing that check "doesn't authenticate the
  caller". ([Authorization headers](https://supabase.com/docs/guides/functions/auth-headers))
  So the handler authenticates in code:
  1. It requires `Authorization: Bearer <JWT-shaped token>` and refuses API keys
     there.
  2. It validates the token with **Supabase Auth** (`GET /auth/v1/user`). This
     works for legacy HS256 and new asymmetric signing keys, and rejects revoked
     sessions.
  3. It calls `rpc whoami` **as the caller**. Only `FOUNDER` passes, and the user
     ids must match. The founder role lives in `public.founders`, not in token
     metadata.
- **Every later read uses that JWT, so RLS applies.** `founder_start_analysis`
  checks the founder again.
- **Keep `verify_jwt` at its default (on)** as an outer filter. There is no
  `config.toml` change.

**3. Execution limits.** From [Limits](https://supabase.com/docs/guides/functions/limits):
- **Wall clock:** 150 s on the Free plan (400 s paid).
- **Request idle timeout:** 150 s (504 after that).
- **CPU:** 2 s per request, excluding async I/O.
- **Memory:** 256 MB.
- **Log events:** 100 per 10 s.
- **How we fit:**
  - The handler's deadline defaults to **110 s**, clamped to 30–130 s.
  - The pipeline keeps 15 s back to record the result, and calls time out at
    45 s. A run stays under the 150 s kill.
  - If the host kills it anyway, the analysis stays PENDING. Recover with
    `founder_abandon_analysis` (see 2A-5d-4a).
- **Unmeasured risk: CPU and memory with large screenshots.** Up to 10 files of
  5 MB each are hashed and base64-encoded (about 50 MB of bytes, plus about
  67 MB of base64). That may exceed 2 s of CPU or 256 MB of memory. Measure it
  in the probe with real files, before any real provider.

**4. Deploying through GitHub Actions without exposing secrets.**
- **What's possible:** the documented path is `supabase/setup-cli` plus
  `supabase functions deploy` with a `SUPABASE_ACCESS_TOKEN` secret.
  ([Deploy](https://supabase.com/docs/guides/functions/deploy)) GitHub masks
  secrets in logs, and the function's own secrets live in Supabase, not in
  GitHub.
- **The catches:**
  1. A personal access token can manage **every project the account can reach**,
     not only staging. Revoke it after use, or keep staging in its own
     organisation.
  2. A `workflow_dispatch` workflow must exist on the **default branch (`main`)**
     to be runnable. Our site workflow is there; a new one would need merging to
     `main`, which isn't authorised.
- **So no workflow file is added in this stage.** A ready template is below.

## Configuration (Edge Function secrets, staging only)

**The platform provides these automatically:**
- `SUPABASE_URL`;
- `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` (JSON, key `default`);
- the legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`.

The secret key takes precedence; the legacy service key is the fallback.

**You set these** (Dashboard → Edge Functions → Secrets). Names must not start
with `SUPABASE_`.

| Name | Value | Effect if missing or wrong |
|---|---|---|
| `ANALYSIS_PROVIDER` | `fake` | 503 `PROVIDER_NOT_CONFIGURED`, nothing started |
| `ALLOW_FAKE_PROVIDER` | `staging-only` | 503 `FAKE_PROVIDER_NOT_ALLOWED` |
| `ANALYZE_ALLOWED_ORIGINS` | optional; defaults to `https://revenue-recovery-v0.pages.dev` | other browser origins get 403 |
| `ANALYZE_DEADLINE_MS` | optional; defaults to 110000 | clamped to 30000–130000 |

**The fake provider runs only when** `SUPABASE_URL` is the staging project
(`https://aqwdwswpmbnzmkvyuqil.supabase.co`) or a local host. On any other
project it refuses.

**What it writes:**
- an `INSUFFICIENT_EVIDENCE` record whose every text starts
  `[FAKE PROVIDER — pipeline test, NOT an AI analysis]`;
- no hypotheses, no classification, no contact recommendation, no message;
- model `analyst:FAKE-PROVIDER-NOT-AI|reviewer:FAKE-PROVIDER-NOT-AI`.

The founder workspace shows "Pipeline test output from the fake provider — no AI
read this case".

**To switch the function off**, delete `ANALYSIS_PROVIDER`. Every call then gets
503 before any database access.

## Request and response

- **Request:** `POST`, `Content-Type: application/json`, body exactly
  `{"case_id": "<uuid>"}` (≤ 1 KiB), with `Authorization: Bearer <founder session JWT>`.
  `supabase.functions.invoke('analyze-case', { body: { case_id } })` sends this.
- **Response:** JSON `{outcome, code, analysis_id}` only. Codes are listed in
  `handler.ts`.
  - **200:** the run started; the outcome is COMPLETED, FAILED or REJECTED.
  - **4xx:** refusals.
  - **503:** configuration or availability problems, or `LOCK_HELD`.
  - **500:** `INTERNAL_ERROR`.
- **Logs:** one JSON line per event, containing only names, codes, ids and
  counts.

## Android-compatible deployment (when approved; not done)

> **Superseded by `DEPLOY-STAGE-2A-5D-4C.md`.** Use its guarded deploy script and live check
> (`supabase/scripts/deploy-analyze-case-staging.sh`, `analyze-case-live-check.sh`). The
> steps below are kept for reference only.

**Option A — recommended for the first, one-off staging deploy: a GitHub Codespace.**
No long-lived token is stored anywhere.
1. Open the repository on GitHub (Chrome on Android) → **Code** → **Codespaces**
   → create one on `claude/revenue-recovery-engine-stage-1-8xg8vf`. Open the
   terminal and run `bash`, then `set +o history`.
2. `cd recovery-prototype && npm ci`.
3. In Supabase → Account → Access Tokens, create a token named `codespace-once`.
4. In the terminal: `read -rs SUPABASE_ACCESS_TOKEN && export SUPABASE_ACCESS_TOKEN`.
   Paste the token; it isn't displayed. Use Gboard incognito.
5. `npx --yes supabase@2.117.0 functions deploy analyze-case --project-ref aqwdwswpmbnzmkvyuqil`.
6. `unset SUPABASE_ACCESS_TOKEN`. In Supabase, **revoke** the `codespace-once`
   token, then delete the Codespace.
7. Set the Edge Function secrets in the Dashboard (table above).

**Option B — repeatable: a manual GitHub Actions workflow.** It needs this file
merged to `main`, a GitHub secret `SUPABASE_ACCESS_TOKEN` (token risk above), and
your approval. Template, not added to the repository:

```yaml
name: Deploy analyze-case (Supabase staging)
on: { workflow_dispatch: {} }
permissions: { contents: read }
concurrency: { group: supabase-functions-staging, cancel-in-progress: false }
jobs:
  deploy:
    if: github.ref == 'refs/heads/claude/revenue-recovery-engine-stage-1-8xg8vf'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults: { run: { working-directory: recovery-prototype } }
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - uses: supabase/setup-cli@v1
        with: { version: 2.117.0 }
      - name: Deploy (staging project only)
        env: { SUPABASE_ACCESS_TOKEN: '${{ secrets.SUPABASE_ACCESS_TOKEN }}' }
        run: supabase functions deploy analyze-case --project-ref aqwdwswpmbnzmkvyuqil
```

**Unverified:**
- whether the CLI needs a `supabase/config.toml` for `functions deploy` (none
  exists here);
- whether it bundles locally (Docker) or through the API.

The first deploy will show both.

**Rollback:**
- unset `ANALYSIS_PROVIDER` (instant refusal);
- or `supabase functions delete analyze-case --project-ref aqwdwswpmbnzmkvyuqil`,
  or Dashboard → Edge Functions → analyze-case → Delete.

Neither changes the database.

## Tests (local only)

`supabase/scripts/test-pipeline-db.sh` (also part of `npm run test:db`):
- `deno check` of the entry point (Deno 2.1.4 via npx).
- `tests/pipeline/edge-function.spec.ts` (28): the handler over HTTP against a
  local fake of Supabase's Auth, PostgREST and Storage APIs, executing in the
  real local database as the caller's role. It covers:
  - credentials: unauthenticated callers, API keys sent as Bearer, forged tokens,
    business and unassigned users, cross-tenant reads;
  - malformed requests and CORS;
  - configuration that fails closed (fake provider refused off staging);
  - evidence: screenshots deleted before and during the run, files removed or
    replaced in Storage, a crafted cross-case path;
  - failure recovery: the secret-key-without-claim rehearsal, `LOCK_HELD` and
    manual recovery, concurrent runs, restricted cases;
  - that the service credential is used for exactly one call;
  - that responses and logs are sanitised.
- `tests/pipeline/edge-deno.spec.ts` (1): the same handler under the real Deno
  runtime.
- `tests/pipeline/pipeline-db.spec.ts` (17, from 2A-5d-4a).
- 18 security mutation tests on the edge layer, all detected.

**Not covered locally:**
- real Supabase Auth, PostgREST, the gateway's treatment of secret keys,
  Storage, and the Edge runtime's limits;
- the fake server mirrors only the calls we make.

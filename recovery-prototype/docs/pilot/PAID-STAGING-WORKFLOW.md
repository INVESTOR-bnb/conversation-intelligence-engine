# Paid staging workflow — owner setup and security

The founder runs paid analyses from the dashboard (**Run paid analysis** → confirm). This
workflow configures that once; it never calls Kimi and never starts an analysis.

Where: GitHub → Actions → **Deploy recovery prototype** → Run workflow →
branch `claude/revenue-recovery-engine-stage-1-8xg8vf`, **target** = `paid-readiness` |
`paid-activate` | `paid-deactivate` | `paid-deactivate-and-remove-key`,
**expected_sha** = the full 40-character commit hash to run (the branch's latest commit).

## One-time owner setup (GitHub → Settings → Environments → `staging-paid`)
The workflow's gate job **refuses to run** until all of these are true (it reads them itself):

1. **Required reviewers:** `INVESTOR-bnb`. Leave **"Prevent self-review" unticked** (you start
   the run and approve it).
2. **Allow administrators to bypass configured protection rules:** **unticked**.
3. **Deployment branches and tags:** **Selected branches and tags**, with exactly one rule:
   `claude/revenue-recovery-engine-stage-1-8xg8vf`.
4. **Environment secrets** (environment, not repository, secrets):
   - `SUPABASE_ACCESS_TOKEN` — a Supabase **scoped** access token (below).
   - `KIMI_API_KEY` — the Kimi (Moonshot) API key.

Never paste either value anywhere else (chat, issues, commits).

## Supabase scoped access token — minimum permissions
Create at supabase.com → Account → Access Tokens, as a **scoped** token (never an all-access /
legacy token):
- **Project:** the staging project `aqwdwswpmbnzmkvyuqil` only.
- **Database:** read-write.
- **Edge Functions:** read-write.
- **Edge Function Secrets:** read-write.
- **Nothing else** (no API keys, Auth, Storage, organisation, billing).
- **Expiry:** 30 days (renew by replacing the environment secret).

Why exactly these (every Management API call the workflow makes):

| Call | Used by | Permission |
|---|---|---|
| `POST /v1/projects/{ref}/database/query` (fixed, tagged statements: schema/state reads, the atomic activation/deactivation `DO` blocks, the synthetic case, the access checks) | `paid-staging.mjs` | Database read-write |
| `GET /v1/projects/{ref}/functions/analyze-case`, `GET …/functions/analyze-case/body` | `paid-staging.mjs` (deployed version and source check) | Edge Functions read |
| Function deploy (`supabase functions deploy analyze-case --use-api`, CLI 2.117.0) | `deploy-analyze-case-2a6d.sh` (activate only) | Edge Functions write |
| `GET /v1/projects/{ref}/secrets` (names and SHA-256 digests only) | both | Edge Function Secrets read |
| `POST /v1/projects/{ref}/secrets`, `DELETE …/secrets` | activate, deactivate-and-remove-key | Edge Function Secrets write |

A token missing any of these makes the run stop with "the access token lacks a permission for
…" before or without changing anything else. The workflow never asks for broader access.

## Gate (job `paid-gate`: no environment, no secret)
Refuses unless: the repository is `INVESTOR-bnb/conversation-intelligence-engine`; the run is a
manual dispatch of the authorised branch; the target is one of the four paid targets;
`expected_sha` is a full 40-character hash equal to the commit the run checked out and on the
branch; and the environment protection above is in place. Then typecheck and the workflow,
gate and deploy-script tests run (install scripts disabled). Only after that can job
`paid-staging` start; it waits for your approval and only then receives the two secrets.

## Secret safety
- Secrets reach only three steps, as environment variables (never a command line); GitHub masks
  them and the tool redacts them again in every line and in the step summary. Only SHA-256
  digests (one-way) are compared; they are never printed.
- No third-party action runs in the paid jobs (plain `git` and the runner's Node); checkout
  uses no credential (public repository) so none can persist; no artifact, no cache, no shell
  tracing; no package is installed in the job that holds the secrets.
- The deploy script passes the token only in the CLI's environment, in a throwaway directory
  removed on exit; it never logs in or stores the token.
- Pull requests, pushes, forks and schedules cannot start these jobs, and the environment only
  deploys from the authorised branch.
- One paid-staging operation at a time (`paid-staging-supabase-…` concurrency group); a started
  one is never cancelled (a newer queued request replaces an older queued one, never a running one).

## Stop paid analysis
Target `paid-deactivate` (spending off, kimi-k3 inactive, key kept), or
`paid-deactivate-and-remove-key` (also deletes the paid settings).

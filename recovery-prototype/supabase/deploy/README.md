# Stage 2A-1 deployment files

| File | Purpose |
|---|---|
| `stage2a1_deploy.sql` | **Generated.** The three migrations, byte-for-byte, in one transaction with a preflight guard and a post-install self-check. Rebuild with `supabase/scripts/build-deploy.sh`; never edit by hand. |
| `stage2a1_verify.sql` | Read-only verification (one SELECT). Safe to run any time. |
| `parts/` | Guard and self-check fragments used by the generator. |

Tests: `npm run test:db` (includes `supabase/scripts/test-deploy.sh`).
Step-by-step instructions: `docs/stage-2a/DEPLOY-STAGE-2A-1.md`.

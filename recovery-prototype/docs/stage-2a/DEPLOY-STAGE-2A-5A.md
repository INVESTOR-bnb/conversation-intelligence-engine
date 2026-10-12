# Stage 2A-5a — analysis output contract (staging only)

**What changes**
- **Database only:** one migration, `20261014120000_stage2a5a_analysis_contract.sql`.
  - Seven private functions (the contract).
  - A new body for `internal_complete_analysis`, which now stores an analysis
    only if it meets [`rre-analysis/1`](ANALYSIS-CONTRACT-V1.md).
- **No AI is connected.**
- No table, policy, grant or data changes. Analyses stay founder-only.
- **Nothing changes for users.** No website change, so no site deployment is
  needed. No analysis is produced yet.

## Deploy (Supabase SQL Editor, staging, after Stage 2A-4c-1)

Files are in `recovery-prototype/supabase/deploy/`. Open each on GitHub →
**Raw** → copy → paste as one query → **Run**.

1. `stage2a5a_deploy.sql` — expected: "Success. No rows returned". All or
   nothing.
   - **Refuses**, changing nothing, if Stage 2A-4c is missing, if 2A-5a is
     already applied, or if your role cannot bypass RLS.
   - **Aborts** and undoes everything if:
     - a contract function is callable by an API role;
     - `internal_complete_analysis` would not enforce the contract;
     - the contract does not reject an empty analysis;
     - `analyses` is not founder-only.
2. `stage2a5a_verify.sql` — expected **PASS (8 pass, 0 fail, 1 info)**. Row 9
   (INFO) counts analyses stored before the contract; expected 0 on staging.
3. `stage2a4c1_verify.sql`, `stage2a4c_verify.sql`, `stage2a4b_verify.sql`,
   `stage2a1_verify.sql` — all **OVERALL PASS**.

If anything says FAIL, REFUSED or ABORTED, stop and send the output.

## Rollback
`stage2a5a_rollback.sql`:
- restores `internal_complete_analysis` exactly as Stage 2A-1 defined it;
- drops the seven functions;
- keeps every analysis, restriction and audit entry, and is audited;
- a second run is refused.

Afterwards analyses are stored unchecked again, so do not connect any analysis
producer without the contract.

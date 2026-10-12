# Stage 2A-5b — evidence integrity (staging only)

**What changes**
- **Database only:** one migration, `20261015120000_stage2a5b_evidence_integrity.sql`.
- **No AI is connected.**
- No table, policy, grant or data changes. Analyses and restrictions stay
  founder-only.
- **Nothing changes for users.** No website change, so no site deployment is
  needed.

| Before | After |
|---|---|
| A screenshot deleted under retention still counted as evidence | Excluded from the evidence an analysis starts from, and listed separately for the founder |
| An analysis could start with no usable evidence | Refused (`INSUFFICIENT_EVIDENCE`); nothing is created or changed |
| Deleting or editing evidence did not make an analysis stale | It raises the case's evidence version: an analysis in progress fails as STALE, and one in review can't be approved until it is re-run |
| A rejected, failed or stale analysis lost the opt-outs it detected | They are recorded anyway (`AI_DETECTED`, active, audited) and keep blocking contact |

New pieces: three private functions, four triggers, and new bodies for
`founder_start_analysis` and `internal_complete_analysis`. The 2A-5a contract
is kept.

## Deploy (Supabase SQL Editor, staging, after Stage 2A-5a)

Files are in `recovery-prototype/supabase/deploy/`. Open each on GitHub →
**Raw** → copy → paste as one query → **Run**.

1. `stage2a5b_deploy.sql` — expected: "Success. No rows returned". All or
   nothing.
   - **Refuses**, changing nothing, if 2A-5a is missing, if 2A-5b is already
     applied, or if your role cannot bypass RLS.
   - **Aborts** and undoes everything if:
     - a new function is callable by an API role;
     - a trigger is not exactly as reviewed;
     - either function lost the contract or restriction preservation;
     - analyses or restrictions are not founder-only.
2. `stage2a5b_verify.sql` — expected **PASS (8 pass, 0 fail, 2 info)**.
   - Row 9: analyses still in progress that started before 2A-5b. Expected 0;
     abandon any you find.
   - Row 10: cases waiting for analysis with no usable evidence. They can't be
     analysed.
3. `stage2a5a_verify.sql`, `stage2a4c1_verify.sql`, `stage2a4c_verify.sql`,
   `stage2a4b_verify.sql`, `stage2a1_verify.sql` — all **OVERALL PASS**.

If anything says FAIL, REFUSED or ABORTED, stop and send the output.

**After deploying, expect two new behaviours:**
- Running the retention runbook (`admin/screenshot_mark_deleted.sql`) on a case
  that is under review makes its analysis stale. Request a re-analysis.
- Starting an analysis on a case whose every file was deleted shows
  `INSUFFICIENT_EVIDENCE: no usable evidence …`.

## Rollback
`stage2a5b_rollback.sql`:
- drops the triggers and functions;
- restores `founder_start_analysis` (as 2A-1) and `internal_complete_analysis`
  (as 2A-5a, contract included);
- keeps every analysis, recorded restriction, audit entry and evidence version,
  and is audited;
- a second run is refused.

Rollback order: `stage2a5a_rollback.sql` refuses to run while 2A-5b is
installed, so roll back 2A-5b first.

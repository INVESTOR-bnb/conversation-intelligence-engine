# Stage 2A-5d-1 — restricted cases cannot get contact recommendations (staging only)

**What changes**
- **Database only:** one migration,
  `20261016120000_stage2a5d1_restriction_contract.sql`.
- It replaces the body of one private function,
  `private.analysis_output_problems` (the analysis contract). The signature,
  owner and privileges stay the same.
- No table, column, policy, privilege, trigger or data changes.
- **No AI is connected.** Analyses and restrictions stay founder-only.
- **Nothing changes for users.** No website change, so no site deployment.

## The gap it closes

When an analysis starts, `founder_start_analysis` records the case's contact
restrictions in the analysis's evidence snapshot:
`analyses.evidence_manifest -> 'restrictions'`, as `[{id, kind, source, status}]`,
where `status` is `ACTIVE` or `DISMISSED_AS_MISREAD`.

The 2A-5a contract did not read this list. It forced DO_NOT_PURSUE only when the
analysis itself reported a restriction. So for a case the founder or client had
already restricted, or one with an opt-out kept from a rejected analysis, an
output saying PURSUE / GREEN with a draft message was **accepted**. The founder
could not approve it (`founder_approve` refuses with CONTACT_RESTRICTED), but
the recommendation was stored as a valid analysis.

| Before | After |
|---|---|
| A restricted case could get an accepted PURSUE / GREEN / YELLOW analysis with a message | Rejected: stored as ERROR (`REJECTED by analysis contract …`), no findings, no message, and the case goes back to its prior state |
| …or an accepted "ask a diagnostic question" / "wait" (UNKNOWN) analysis | Rejected the same way |
| — | Accepted only: DO_NOT_PURSUE, classification RED, STOP_CONTACT, no proposed message, for COMPLETE and INSUFFICIENT_EVIDENCE |

**What counts as restricted** (fail closed):
- any snapshot entry whose `status` is not `DISMISSED_AS_MISREAD` (a missing or
  unknown status counts as active);
- or an ACTIVE restriction on the case right now;
- a snapshot with no restriction list is rejected outright.

A restriction dismissed as a misreading *before* the analysis started does not
block. One dismissed *during* an analysis still blocks that analysis, because
the snapshot says ACTIVE. Re-run the analysis.

**Other changes:**
- The snapshot restriction satisfies "DO_NOT_PURSUE needs a restriction or a
  reason".
- INSUFFICIENT_EVIDENCE may carry RED only in this restricted case, and must
  there.
- Every other rule of `rre-analysis/1` is unchanged.

## Deploy (Supabase SQL Editor, staging, after Stage 2A-5b)

Files are in `recovery-prototype/supabase/deploy/`. Open each on GitHub →
**Raw** → copy → paste as one query → **Run**.

1. `stage2a5d1_deploy.sql` — expected: "Success. No rows returned". All or
   nothing.
   - **Refuses**, changing nothing, if:
     - 2A-5a or 2A-5b is missing;
     - 2A-5d-1 is already applied;
     - the contract is not byte-for-byte the reviewed 2A-5a version;
     - your role cannot bypass RLS.
   - **Aborts** and undoes everything if:
     - the contract is callable by an API role or lost its pinned search_path;
     - the rule does not reject a synthetic in-memory restricted case;
     - the rule blocks a dismissed one;
     - completion no longer enforces the contract;
     - analyses or restrictions are not founder-only.
2. `stage2a5d1_verify.sql` — expected **PASS (7 pass, 0 fail, 2 info)**.
   - Row 8: accepted analyses of a restricted snapshot that recommend contact
     (accepted before this stage). Expected 0.
   - Row 9: analyses in progress. The new rule judges them when they complete.
3. `stage2a5b_verify.sql`, `stage2a5a_verify.sql`, `stage2a4c1_verify.sql`,
   `stage2a4c_verify.sql`, `stage2a4b_verify.sql`, `stage2a1_verify.sql` — all
   **OVERALL PASS**.

If anything says FAIL, REFUSED or ABORTED, stop and send the output.

## Rollback
`stage2a5d1_rollback.sql`:
- restores `private.analysis_output_problems` exactly as 2A-5a (its self-check
  compares the body's md5);
- keeps every analysis, restriction, audit entry and evidence version, and is
  audited;
- a second run is refused.

Afterwards the gap is back: `founder_approve` still blocks GREEN/YELLOW, but a
contact-recommending analysis can again be stored. Rollback order is strict:
`stage2a5b_rollback.sql` refuses while 2A-5d-1 is installed.

## Tests
- `supabase/tests/14_restriction_contract.test.sql` (48 assertions), plus
  updated 11 and 12 (both had accepted GREEN analyses on restricted cases).
- `supabase/scripts/test-deploy-2a5d1.sh` (49 checks):
  - a control that reproduces the gap on a 2A-5b database;
  - deploy, verify, refusals, injected weaknesses;
  - rollback, then re-deploy.

# Stage 2A-5d-2 — contract rre-analysis/2: independent adversarial review (staging only)

**What changes**
- **Database:** one migration, `20261017120000_stage2a5d2_adversarial_review.sql`.
  - It replaces the body of `private.analysis_output_problems` (the contract);
    signature, owner and privileges are unchanged.
  - No table, column, policy, privilege, trigger, view or data changes.
  - `internal_complete_analysis` is untouched.
- **No AI is connected.**
- **Founder workspace (website):** shows an "Independent review" card for
  `rre-analysis/2` analyses: the verdict, then challenges ordered by severity,
  each with its target and verified evidence.
  - For `rre-analysis/1` analyses it says there is no independent review.
  - A draft message is withheld if the review rejected the recommendation.
  - The card is founder-only, like the rest of the analysis.
- The rules are in `ANALYSIS-CONTRACT-V1.md`, section "Contract `rre-analysis/2`".

| Before | After |
|---|---|
| No adversarial review could be stored (any `rre-analysis/2` output was rejected) | `rre-analysis/2` = v1 + a required, validated `adversarial_review` |
| — | A fabricated citation in the review (quote not in the message; a message from another case, business or later than the snapshot; a deleted screenshot) rejects the whole analysis |
| — | A review that rejects the recommendation forces: not PURSUE, no SEND_MESSAGE or question, no proposed message. No contact message is stored |
| `rre-analysis/1` accepted | Still accepted, unchanged; stored analyses untouched |

## Deploy (only after founder approval)

**1. Database (Supabase SQL Editor, staging, after Stage 2A-5d-1).** Files are
in `recovery-prototype/supabase/deploy/`. For each: open on GitHub → **Raw** →
copy → paste as one query → **Run**.

1. `stage2a5d2_deploy.sql` — expected: "Success. No rows returned". All or
   nothing.
   - **Refuses**, changing nothing, if:
     - 2A-5d-1 is missing;
     - the contract is not byte-for-byte the reviewed 2A-5d-1 version;
     - 2A-5d-2 is already applied;
     - your role cannot bypass RLS.
   - **Aborts** and undoes everything if:
     - the contract is callable by an API role or lost its search_path;
     - the in-memory self-tests fail (fabricated citation rejected; rejecting
       review blocks messages; v2 needs a review; v1 still accepted;
       restriction rule holds for v2);
     - completion lost the contract;
     - analyses are not founder-only;
     - a view exposes analyses.
2. `stage2a5d2_verify.sql` — expected **PASS (9 pass, 0 fail, 2 info)**.
   - Row 10 counts stored analyses by contract version.
   - Row 11 must read 0.
3. Re-run the earlier verify files: `stage2a5d1_verify.sql`, `stage2a5b_verify.sql`,
   `stage2a5a_verify.sql`, `stage2a4c1_verify.sql`, `stage2a4c_verify.sql`,
   `stage2a4b_verify.sql`, `stage2a1_verify.sql`. All must show **OVERALL PASS**.

**2. Website (only after the database step passes).** Use the existing manual
GitHub Actions workflow. It is the same procedure as for 2A-5c.

If anything says FAIL, REFUSED or ABORTED, stop and send the output.

## Rollback
1. `stage2a5d2_rollback.sql`:
   - restores the contract exactly as 2A-5d-1 (its self-check compares the
     md5);
   - keeps all data, including stored `rre-analysis/2` analyses, which the
     website still displays;
   - is audited; a second run is refused.
   - Afterwards new `rre-analysis/2` outputs are rejected again.
2. `stage2a5d1_rollback.sql` refuses while 2A-5d-2 is installed. Order is strict.
3. The website change is safe with or without the database change. You can
   redeploy the previous commit if you want it gone.

## Tests
- `supabase/tests/15_adversarial_review.test.sql` (68 assertions); test 11
  updated (it used `rre-analysis/2` as an example of an invalid version).
- `supabase/scripts/test-deploy-2a5d2.sh` (53 checks).
- Unit (5 new) and browser (5 new) tests for the workspace.

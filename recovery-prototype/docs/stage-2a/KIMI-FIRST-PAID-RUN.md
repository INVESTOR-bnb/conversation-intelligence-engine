# Stage 2A-6e — the first Kimi-powered synthetic analysis

One founder-approved paid analysis of a **synthetic** WhatsApp-style conversation with `kimi-k3`
(analyst and adversarial reviewer), on **staging** only. Every step is a separate approval.
Nothing below has been run yet.

## What is already in place (offline-tested)

- **Kimi adapter:**
  - `kimi-k3`, `reasoning_effort: low`;
  - `max_completion_tokens: 8000` per call;
  - strict structured output;
  - no retries;
  - `reasoning_content` never read.
- **Price:**
  - input USD 3 (regular and cache-write), applied to **all** prompt tokens; no cached discount;
  - output USD 15 (reasoning included);
  - code (`KIMI_MODELS`) and database row (Stage 2A-6e) must match exactly, or the run is refused.
- **Reservation:**
  - both calls, at their full caps: about USD 0.34 + 6 × (conversation bytes) / 1e6;
  - the synthetic case is about 800 bytes, so about USD 0.37;
  - inside the USD 1 per-analysis limit up to about 18 KB of text.
- **Price row:** `kimi-k3` is INACTIVE. The database refuses to reserve it until the paid run activates it for that run only.

## Steps (each needs its own approval)

1. **Price row (database).** Supabase SQL Editor (staging):
   - run `supabase/deploy/stage2a6e_deploy.sql`;
   - then run `supabase/deploy/stage2a6e_verify.sql`. Expected: `PASS (4 pass, 0 fail, 1 info)`.
   - Undo: `stage2a6e_rollback.sql`.
2. **Function code.** Redeploy `analyze-case` from the pushed commit that contains this stage:
   - run `bash supabase/scripts/deploy-analyze-case-2a6d.sh` (fake settings; it refuses any Anthropic **or Kimi** setting present);
   - then run `bash supabase/scripts/analyze-case-live-check.sh`.
3. **Kimi account (founder, Kimi console; the script cannot see it):**
   - keep the prepaid credit small (for example USD 5);
   - create **one** API key for this run.
4. **The paid run.** In the Codespace:
   ```bash
   bash
   set +o history
   cd recovery-prototype
   git pull --ff-only
   bash supabase/scripts/paid-pipeline-e2e.sh
   ```
   - **Prompts:**
     - provider `kimi`;
     - the Kimi key (hidden);
     - the credit on that account (USD, at most 15);
     - the run budget (at most 3).
   - **Audit:** the script refuses, changing nothing, unless all of these hold:
     - spending is off;
     - only the fake is active;
     - the `kimi-k3` row is exactly 3 / 15 / 8000 and inactive;
     - nothing is unsettled;
     - the deployed function contains the Kimi adapter;
     - no paid setting is present.
   - **The window:**
     - it writes `ANALYSIS_PROVIDER=kimi`, `ALLOW_PAID_PROVIDER=staging-only` and `KIMI_API_KEY`;
     - it activates `kimi-k3` and enables spending (one guarded statement);
     - it makes **one** founder call;
     - then it immediately turns everything off and deletes the key setting.
   - **Verification:**
     - the analysis was made by `analyst:kimi-k3|reviewer:kimi-k3`;
     - one ledger row, settled from reported usage (or HELD, to reconcile against the Kimi console);
     - no overrun;
     - client A, client B and anonymous see nothing.
5. **Read the analysis** in the founder workspace. Check by hand:
   - evidence quotes;
   - psychological uncertainty;
   - alternative hypotheses;
   - the adversarial verdict;
   - the recommendation.
6. **Afterwards:**
   - compare the ledger's `actual_usd` with the Kimi console;
   - revoke the Kimi key and the Supabase token.

**Recovery at any time:** `bash supabase/scripts/paid-pipeline-e2e.sh --paid-off`. It also removes `KIMI_API_KEY` and deactivates `kimi-k3`.

## Not verified until the first live run

- That kimi-k3 echoes the exact model id (`kimi-k3`). If it does not, the call is HELD as a mismatch and nothing is settled at USD 0.
- That strict mode accepts our schema (optional fields sent as required-and-nullable). If it does not, the analysis fails closed. The schema is never weakened.
- The provider's error and request-id formats.

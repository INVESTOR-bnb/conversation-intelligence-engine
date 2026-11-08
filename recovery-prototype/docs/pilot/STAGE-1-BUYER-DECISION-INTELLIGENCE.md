# Stage 1 — Buyer Decision Intelligence (design for founder review; NOT implemented)

Status: proposal, 8 Nov 2026. Nothing here is built, migrated or deployed. Every item that changes the
database, the analysis contract, spending or customer messaging needs separate founder approval.

## 1. What Stage 1 is, and is not
RRE does not read minds. Stage 1 turns each analysis into a **testable prediction** about an unresolved buyer
decision, records what actually happened, and measures whether RRE's recommended move does better than the
follow-up the business would have sent anyway.

- A *barrier hypothesis* is a guess about what is holding the decision, grounded in quoted evidence, with
  competing explanations and stated uncertainty (the analysis already produces these: `hypotheses[]`).
- A *diagnostic next move* is the one message (or verification step) most likely to **resolve or reveal**
  that barrier. A good move is useful even if the hypothesis is wrong: the reply tells us which one was right.
- The founder approves every message. Nothing is sent automatically.

## 2. What already exists (reused, not rebuilt)
| Need | Existing source |
|---|---|
| Evidence, quotes, observations, hypotheses, confidence, uncertainty | `analyses.output` (rre-analysis/2, contract-checked) |
| Independent challenge of the reasoning | `adversarial_review` in the same output |
| The draft vs what the founder actually approved | `approvals.ai_proposed_message`, `approved_message`, `approval_type` (UNCHANGED / EDITED / MARKED_RED) |
| What was sent and what the buyer said back | `case_messages` kinds `RECOVERY_SENT`, `PROSPECT_RESPONSE` (timestamped) |
| Final result | `outcomes` (WON / LOST / PAUSED / DISQUALIFIED, deal value, amount paid) |
| Opt-outs | `contact_restrictions` |

What is missing: (a) which hypothesis the move was betting on, written as a checkable prediction;
(b) a short-horizon result (did the buyer reply, and what did the reply reveal); (c) which message arm the
case was in (RRE vs baseline); (d) the founder's after-the-fact judgement of which hypothesis was right.

## 3. The prediction record (one per approved recommendation)
Written by the founder at approval time, pre-filled from the analysis; ~30 seconds.
| Field | Meaning |
|---|---|
| `target_hypothesis` | The H-id the move is designed to test (e.g. H2), or `NONE` for a pure verification/wait move |
| `expected_signal` | One of: REPLY_ADDRESSING_BARRIER, BOOKS_NEXT_STEP, REVEALS_OTHER_BARRIER, DECLINES |
| `horizon_days` | When to judge (default 7) |
| `arm` | `RRE` or `BASELINE` (section 5) |
| `verify_first` | The fact the seller had to confirm before sending, if any |

## 4. Outcome recording
Two horizons, because final sales are rare and slow.
1. **Short horizon (primary, at `horizon_days`)** — recorded by the founder from the existing
   `PROSPECT_RESPONSE` messages: `NO_REPLY`, `REPLIED_ADDRESSED_BARRIER`, `REPLIED_OTHER_BARRIER`,
   `NEXT_STEP_BOOKED` (viewing, call, payment link requested), `DECLINED`, `OPTED_OUT`; plus
   `hypothesis_verdict`: SUPPORTED / CONTRADICTED / UNCLEAR / NEW_BARRIER (free text ≤ 200 chars).
2. **Long horizon** — the existing `outcomes` row (WON / LOST / PAUSED / DISQUALIFIED, amount paid).

Rules: silence is recorded as `NO_REPLY`, never as a hypothesis verdict; outcomes are recorded for both arms;
nothing is inferred about a person beyond what they wrote.

## 5. Evaluation against a baseline
**Baseline** = the follow-up the business would normally send (their own wording, or the generic
"Hello, are you still interested?" check-in when they have none). Both arms are messages a reasonable business
would send; the founder approves both; no deception, no pressure.

**Assignment** — per eligible case (PURSUE, no restriction, founder willing to send either), alternate or
randomise by a fixed rule recorded *before* the message is written (e.g. case number parity), so the founder
cannot pick the "easy" cases for RRE. A founder override is allowed but recorded and reported.

**Metrics** (pre-registered before the first case):
| Metric | Type |
|---|---|
| Reply within 7 days | primary |
| Next step booked within 14 days | secondary |
| WON rate, amount paid within 60 days | secondary (low power at pilot scale) |
| Opt-outs / complaints after the message | harm — must not be higher in the RRE arm |
| Founder edit rate and MARKED_RED rate on RRE drafts | quality |
| Unverified-claim incidents caught at review | safety — target 0 sent |
| Hypothesis calibration: share SUPPORTED by stated confidence (LOW / MEDIUM) | prediction quality |

**Honest power estimate** — to detect a reply-rate lift from 20% to 35% with 80% power needs roughly 140
cases per arm. A 1–3 business pilot will not reach that. Stage 1 therefore reports **effect estimates with
95% confidence intervals and the raw counts**, not "proof"; a decision to scale needs either more cases or a
consistent direction across businesses plus zero harm signals.

## 6. Minimal build when approved (proposal only)
- **Phase 0 — no schema change (recommended first, ~20 cases):** a founder-kept log (one row per approved
  case: case reference, arm, target hypothesis, expected signal, short-horizon result, verdict). Measures
  whether the fields are usable before anything is built.
- **Phase 1 — one migration:** table `case_predictions` (fields of sections 3–4, founder-only RLS like
  `founder_notes`, append-only corrections), two founder RPCs (record prediction at approval; record result),
  and a CSV export. No change to `analyses`, the contract, spending, or client screens.
- **Not in Stage 1:** automatic sending, automatic hypothesis scoring by AI, extra AI calls, buyer profiling,
  dashboards beyond the export.

## 7. Guardrails
Founder approves every message; opt-outs stop both arms; no personal traits inferred; prospect data stays in
the existing tables under existing RLS; the evaluation never changes what a buyer is told about who is
writing to them; any business taking part agrees to the A/B approach in writing.

## 8. What would show Stage 1 is not working
- RRE arm reply rate not above baseline after 40+ cases per arm with overlapping intervals and no
  consistent direction across businesses.
- Hypotheses marked SUPPORTED no more often at MEDIUM than at LOW confidence (no calibration).
- Founder edits most drafts substantially, or any unverified claim reaches a buyer.

## 9. Decisions needed from the founder
1. Baseline definition per business (their wording vs the generic check-in).
2. Assignment rule (parity vs random) and whether overrides are allowed.
3. Phase 0 only, or Phase 0 then Phase 1 migration.
4. Horizons (7 / 14 / 60 days) and the primary metric.

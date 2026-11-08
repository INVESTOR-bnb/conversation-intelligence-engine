# Stage 1 — Buyer Decision Intelligence (design for founder review; NOT implemented)

Status: proposal, revision 2, 8 Nov 2026. Nothing here is built, migrated or deployed. Any change to the
database, the analysis contract, spending, the frontend or customer messaging needs separate founder approval.

## 1. Purpose and limits
Stage 1 tests one question: **do RRE's recommendations lead to better results than the business's genuine
usual follow-up, without more harm?** It does this by writing down, before anything happens, what RRE expects,
and comparing that with what actually happens.

RRE does not read minds and does not claim to. It never states a buyer's private thoughts, never assigns a
numeric probability it cannot justify (confidence stays the existing LOW / MEDIUM / HIGH / UNKNOWN labels),
and never promises that a message will influence a particular buyer.

## 2. Three things kept separate
| Layer | What it is | Example | Source |
|---|---|---|---|
| **A. Barrier hypothesis** | An evidence-grounded guess about what is holding the decision, with competing guesses and uncertainty | H2 "needs partner and bank agreement" (stated by prospect) vs H3 "price above budget" (hypothesis, LOW) | existing `analyses.output.hypotheses` |
| **B. Predicted buyer response** | What should happen *if* the targeted hypothesis is right and the recommended move is sent, within a set time | "Replies with a viewing time or a partner/bank update within 7 days" | new prediction record (§4) |
| **C. Sales outcome** | What eventually happened commercially | WON with amount paid; LOST; PAUSED; DISQUALIFIED | existing `outcomes` |

A good B can be judged in days; C takes weeks and is affected by many things RRE does not control. A failed
C does not by itself refute A or B, and a WON does not prove A was right.

## 3. Evidence that supports or contradicts a prediction
Judged only from what the buyer later writes or does (existing `PROSPECT_RESPONSE` messages, recorded actions):
| Verdict on the targeted hypothesis | Counts as evidence |
|---|---|
| SUPPORTED | The buyer's reply addresses the targeted barrier (e.g. mentions partner/bank, asks about the point raised) or takes the predicted step |
| CONTRADICTED | The buyer states a different reason, or the predicted step happens without the barrier ever being relevant |
| NEW_BARRIER | The reply reveals a reason none of the hypotheses named |
| UNRESOLVED | No reply, or a reply that says nothing about the reason |

Rules: silence is UNRESOLVED, never support or contradiction. Verdicts quote the buyer's words. The founder
records the verdict; the AI does not grade itself.

## 4. Pre-registration: predictions are fixed before outcomes are seen
At the moment of approval (before the message is sent), one prediction record is written and never edited:
| Field | Meaning |
|---|---|
| case reference, analysis id, prompt version | links the prediction to the exact analysis |
| `target_hypothesis` | the H-id the move tests, or NONE (pure verification or wait) |
| `predicted_response` | one of REPLIES_ON_BARRIER, TAKES_NEXT_STEP (named), REVEALS_OTHER_REASON, DECLINES |
| `horizon_days` | default 7 (reply), 14 (next step), 60 (sale) |
| `arm` and allocation number | §6 |
| `verify_first` | the fact the seller had to confirm, if any |
| `recorded_at` | timestamp; Phase 0 uses a dated, append-only log |

Corrections are appended as new rows with a reason; the original stays. A later re-analysis creates a new
prediction; it never replaces the earlier one. This is what stops the explanation being rewritten afterwards.

## 5. Was the recommendation actually used?
Recorded per case, because a recommendation that was never sent cannot be credited or blamed:
| Field | Values |
|---|---|
| `founder_decision` | UNCHANGED / EDITED / MARKED_RED (existing `approvals.approval_type`) |
| `verified_before_send` | YES / NO / NOT_NEEDED (when VERIFY FIRST applied) |
| `sent` | YES (existing `RECOVERY_SENT`, "I sent it") / NO / UNKNOWN |
| `sent_as_approved` | YES / CHANGED_BY_SELLER / UNKNOWN |
| `days_to_send` | from release to "I sent it" |

Analysis is by allocation (intention to treat) and, separately, among cases actually sent as approved.

## 6. Baseline and allocation
**Baseline (preferred):** the follow-up this business would genuinely have sent, written by the business
*before* seeing RRE's draft (or taken from their real past follow-ups for historical cases). The generic
"are you still interested?" is used only if that is genuinely what the business sends, and is labelled so.

**Eligibility (documented per case):** PURSUE recommendation; no contact restriction; consent in place (§8);
the business is willing to send either message; the founder judges both messages acceptable to send.

**Allocation:** preassigned random order per business (a sealed list generated before the first case, e.g.
blocks of four, two RRE / two BASELINE), applied in order of eligibility. Overrides allowed only for safety or
business reasons, recorded with the reason, and reported. Where randomisation is impractical (very few cases),
strict alternation by case number, declared in advance.

## 7. Measures (reported separately, never merged into one score)
| Measure | Definition | Window |
|---|---|---|
| Reply | any buyer reply | 7 days |
| Meaningful next step | viewing/call booked, documents requested, payment details requested — confirmed by the business | 14 days |
| Verified sale | `outcomes` WON with amount paid and payment date | 60 days |
| Opt-out / complaint | contact restriction or complaint after the message | any time |
| Draft quality | founder edit rate, MARKED_RED rate, unverified claims caught before release | at approval |
| Hypothesis accuracy | SUPPORTED / CONTRADICTED / NEW_BARRIER / UNRESOLVED counts by confidence label | at horizon |

Results are reported as counts and rates per arm with 95% confidence intervals. With pilot-scale numbers the
intervals will be wide; Stage 1 reports estimates and direction, not proof. (Illustration only, not a
forecast: telling a 20% reply rate apart from 35% with conventional power needs roughly 140 cases per arm.)

## 8. Privacy, consent, retention, access
- **Consent:** each participating business agrees in writing to (a) RRE storing the conversations it submits,
  (b) the random allocation between its own follow-up and RRE's, (c) recording replies and outcomes. Only
  conversations the business is entitled to share are used; buyers who opted out are excluded.
- **Data minimisation:** prediction and outcome records hold codes, dates, ids and short quotes needed for a
  verdict; no new personal data, no inferred personal traits.
- **Access:** founder only (as `founder_notes` today); a business sees only its own approved messages and
  outcomes, never predictions or hypotheses. No export leaves the founder's control.
- **Retention:** prediction/outcome records follow the case's retention; deleted with the case; Phase 0 log
  deleted or anonymised (case reference only) within 90 days of the Phase 0 report.
- Applicable law (e.g. Nigeria's NDPA 2023 for Nigerian businesses) is to be confirmed by the founder;
  this design does not constitute legal advice.

## 9. Phase 0 — about 20 authorised cases, no migration, no extra AI spending
**Goal:** check that the records are practical and the verdicts can be judged consistently, before any build.

| Step | What | Who |
|---|---|---|
| 0 | Written consent from 1–3 businesses (§8); allocation list generated and stored before case 1 | Founder |
| 1 | Select ~20 cases: (a) **historical** — already-analysed or past stalled chats where the business's real follow-up and the buyer's response are known (for verdict practice and draft comparison only; no allocation), and/or (b) **prospective** — new eligible cases allocated per §6 | Founder |
| 2 | For each case, at approval: fill the prediction row (§4) and usage fields (§5) in a dated spreadsheet; append-only | Founder |
| 3 | At 7 / 14 / 60 days: record reply, next step, sale, opt-out, and hypothesis verdict with the buyer's quote | Founder (business supplies replies) |
| 4 | Second look: for 5 cases, a second person (or the founder a week later, blind to the first verdict) re-judges verdicts to test consistency | Founder |
| 5 | Phase 0 report: completeness of records, verdict agreement, edit/RED rates, any unverified claim reaching a buyer, per-arm counts with intervals, recommendation on Phase 1 | Claude drafts, founder decides |

Spending: no extra AI calls — only analyses the founder would run anyway, within the existing $1 cap and
allowance. Historical cases use analyses already paid for, or none.

**Phase 0 stops early if:** any unverified claim reaches a buyer; an opt-out follows an RRE message; or
records cannot be completed for more than a quarter of cases.

## 10. Phase 1 (not to be built until Phase 0 is reviewed)
One founder-only table for §4–5 records, two founder RPCs (record prediction at approval; append outcome or
correction), a CSV export, and pre-filling the approval form's Next step from VERIFY FIRST. No change to the
analysis contract, spending, or what businesses see.

## 11. Decisions for the founder
1. Which businesses, and their consent wording.
2. Historical, prospective, or both for Phase 0.
3. Allocation: random blocks (recommended) or alternation.
4. Horizons (7 / 14 / 60 days) and who confirms next steps and sales.

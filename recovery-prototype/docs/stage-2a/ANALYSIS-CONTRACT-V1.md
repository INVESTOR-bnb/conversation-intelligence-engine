# Analysis output contract `rre-analysis/1` (Stage 2A-5a)

**Who can see it.** Every analysis is **founder-only**: `public.analyses` can be
read only by the founder. Business users see nothing of it.
- They never see the observations, psychological hypotheses, strategy,
  rationale or restrictions.
- Their case list shows "Under review" until the founder approves a
  recommendation. Only that approved, client-safe recommendation is ever shown
  to them.

**Where it is enforced.** In the database.
- `public.internal_complete_analysis` stores an analysis as `COMPLETE` or
  `INSUFFICIENT_EVIDENCE` only if `private.analysis_output_problems` finds no
  problem.
- Anything else is stored as `ERROR` ("REJECTED by analysis contract …")
  - without its output, classification or message. Since Stage 2A-5b, any
    contact restrictions it detected **are still recorded** (active, audited),
    so a known opt-out is never lost;
  - the case returns to its previous state;
  - the rejection is audited (never shown to the client).
- Any future producer (the AI function in phase C, a script, anything) is held
  to the same rules.

**What it does not do.**
- It does not judge whether an interpretation is psychologically *right*.
  That is the founder's review.
- It cannot read screenshot images (no OCR), so a quote from a screenshot is
  **model-reported**, not verified.
- It does not re-check analyses stored before it was deployed (verify row 9).

## Structure

| Section | Content | Rules |
|---|---|---|
| `evidence_assessment` | `sufficiency` (SUFFICIENT / PARTIAL / INSUFFICIENT), `summary`, `missing_evidence[]` | PARTIAL needs at least one unknown |
| `observations[]` — **observed buyer (and seller) behaviour** | `id` (O1…), `actor` (PROSPECT / SELLER / UNCLEAR), `behavior`, `evidence[]` (1–10 references) | Facts only; every one cites evidence. A PROSPECT observation cannot cite the seller's recovery messages, and the reverse. |
| `hypotheses[]` — **psychological interpretation** | `id` (H1…), `category`, `statement`, `basis`, `supporting_observations[]`, `contradicting_observations[]`, `competing_hypotheses[]`, `confidence`, `uncertainty` | See below |
| `unknowns[]` | `question`, `why_it_matters` | What is not known and should not be guessed |
| `recommendation` | `pursue` (PURSUE / DO_NOT_PURSUE / UNKNOWN), `strategy`, `psychological_rationale` (each may be `UNKNOWN`), `based_on_hypotheses[]`, `next_action` {`type`: SEND_MESSAGE / ASK_DIAGNOSTIC_QUESTION / WAIT / STOP_CONTACT, `text`} | See below |
| `contact_restrictions[]` | `kind` (EXPLICIT_OPT_OUT / PROHIBITED_CONTACT / OTHER), `reason`, `evidence[]` (1+) | Must be exactly the restrictions recorded with the analysis |
| `reasons_not_to_pursue[]` | `reason`, `evidence[]` | Needed for DO_NOT_PURSUE when there is no restriction |

Hypothesis `category` covers the requested intelligence:
- `EMOTIONAL_BARRIER`: hypothesised emotional barriers;
- `TRUST_AND_RISK`: trust and perceived risk;
- `BUYING_MOTIVATION`: buying motivations;
- `DECISION_FRICTION`: decision friction;
- `SELLER_CREATED_RESISTANCE`: seller-created resistance.

**Evidence reference:**
- `{"type": "MESSAGE", "message_id": …, "quote": …}`: the quote must appear
  verbatim in that message (spacing ignored).
- `{"type": "SCREENSHOT", "position": 1-10, "quote"?: …}`: the screenshot must
  still be stored (not deleted under retention) and unchanged since the
  analysis started. Its quote cannot be verified.

A reference must be part of **this analysis's** evidence snapshot
(`evidence_manifest`). Messages from other cases or businesses, and invented
message IDs, are rejected.

## Rules for psychological claims

1. A hypothesis must rest on at least one observation. If nothing supports it,
   it belongs in `unknowns`.
2. `basis` is `STATED_BY_PROSPECT` only when a supporting **PROSPECT**
   observation **quotes** the evidence. Everything else must be labelled
   `HYPOTHESIS`.
3. A `HYPOTHESIS` must name at least one **competing hypothesis** (another H),
   and can never be `HIGH` confidence.
4. `HIGH` confidence is impossible while any observation **contradicts** it.
5. `confidence` may be `UNKNOWN`. `uncertainty` (what would change the view) is
   always required.

## Rules for recommendations

- **PURSUE** needs:
  - a strategy, a psychological rationale and the hypotheses they rest on;
  - a next action of SEND_MESSAGE or ASK_DIAGNOSTIC_QUESTION;
  - classification GREEN or YELLOW.
- **DO_NOT_PURSUE** needs STOP_CONTACT, classification RED, and a restriction
  or a reason not to pursue.
- **UNKNOWN** needs ASK_DIAGNOSTIC_QUESTION or WAIT, and no classification.
- **Any contact restriction forces DO_NOT_PURSUE.**
- **Active restrictions already on the case (Stage 2A-5d-1).** If the analysis's
  evidence snapshot (`analyses.evidence_manifest.restrictions`, items
  `{id, kind, source, status}`) lists any restriction not `DISMISSED_AS_MISREAD`,
  or the case has an ACTIVE restriction now, only this is accepted:
  - DO_NOT_PURSUE;
  - classification RED;
  - STOP_CONTACT;
  - no proposed message.

  This applies to both COMPLETE and INSUFFICIENT_EVIDENCE, whatever the model
  says. The snapshot restriction counts as the reason not to pursue. A snapshot
  without a restriction list is rejected. See `DEPLOY-STAGE-2A-5D-1.md`.
- A proposed message exists only for SEND_MESSAGE and must equal its text.
  (The existing rule still removes any message for RED or any restriction.)

## Insufficient or deleted evidence: no invented findings

- `INSUFFICIENT_EVIDENCE` ⇔ sufficiency `INSUFFICIENT`.
- It carries **no hypotheses, no classification (RED only under an active
  contact restriction, where RED is required), no proposed message**, and a
  strategy of `UNKNOWN`. It must say what is missing (`missing_evidence` and
  `unknowns`), and cannot recommend PURSUE.
- If no usable evidence remains (none recorded, or every screenshot deleted),
  only `INSUFFICIENT_EVIDENCE` is accepted.
- `COMPLETE` needs at least one observation.

## Shape and limits

- Every section is required. No other keys are allowed at any level, so there
  are no unvalidated free-text verdicts.
- At most 200 kB, 60 items per list, and 10 references per item; text fields
  have fixed maximum lengths.
- Malformed input never crashes the check: it is reported, or rejected as a
  whole ("could not be validated").

## Evidence the contract is checked against (Stage 2A-5b)

- An analysis starts from evidence manifest **v2**:
  - it lists only screenshots whose file is still stored;
  - files deleted under retention appear under `excluded_screenshots` and can
    never be cited;
  - each message carries a `body_sha256` of its text.
- `founder_start_analysis` refuses with `INSUFFICIENT_EVIDENCE` when no message
  and no stored screenshot remain.
- Any change to, or deletion of, a submitted case's messages or screenshots
  (including a retention deletion) raises the case's evidence version:
  - an analysis in progress then fails as **STALE**;
  - an analysis waiting for review can no longer be approved
    (`STALE_ANALYSIS`) until it is re-run on the current evidence.

## Contract `rre-analysis/2`: independent adversarial review (Stage 2A-5d-2)

`rre-analysis/2` is `rre-analysis/1` with one more **required** section,
`adversarial_review`.
- **v1 is unchanged.** Outputs with `contract_version` `rre-analysis/1` are
  still accepted and may not carry a review (it would be unvalidated).
- **Every v1 rule applies to v2,** including the Stage 2A-5d-1 restriction rule:
  a review can never override an active restriction.

| Field | Content |
|---|---|
| `challenges[]` (≤ 30) | `id` (C1…), `target` (OBSERVATION / HYPOTHESIS / RECOMMENDATION), `target_id` (an existing O… or H…; none for RECOMMENDATION), `severity` (HIGH / MEDIUM / LOW), `challenge` (text), `evidence[]` (0–10 references) |
| `verdict` | UPHOLD / UPHOLD_WITH_CONCERNS / REJECT_RECOMMENDATION |
| `verdict_rationale` | text |

**Evidence references in the review** are checked exactly like the analysis's
own, against this analysis's evidence snapshot:
- the message must be in the snapshot, so not another business's, another
  case's, or one added later;
- the quote must appear in the message;
- a deleted screenshot cannot be cited.

One fabricated citation rejects the whole analysis.

**Verdict rules:**
- UPHOLD has no HIGH challenge.
- UPHOLD_WITH_CONCERNS has at least one challenge.
- REJECT_RECOMMENDATION has at least one HIGH challenge.

**A rejected recommendation stores no contact message.** With
REJECT_RECOMMENDATION:
- `pursue` cannot be PURSUE;
- `next_action` cannot be SEND_MESSAGE or ASK_DIAGNOSTIC_QUESTION;
- there is no proposed message.

So no message to the prospect exists in any stored column or in the output.
An output that breaks this is rejected whole, not stored with the message
stripped.

**What the database cannot prove.** It cannot prove the review was *independent*,
i.e. produced by a separate pass that did not just agree with the analyst. That
is the job of the analysis pipeline (Stage 2A-5d-4). The database guarantees only
that the review is well-formed, grounded in real evidence and consistent with
what is stored.

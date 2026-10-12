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
- A proposed message exists only for SEND_MESSAGE and must equal its text.
  (The existing rule still removes any message for RED or any restriction.)

## Insufficient or deleted evidence: no invented findings

- `INSUFFICIENT_EVIDENCE` ⇔ sufficiency `INSUFFICIENT`.
- It carries **no hypotheses, no classification, no proposed message**, and a
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

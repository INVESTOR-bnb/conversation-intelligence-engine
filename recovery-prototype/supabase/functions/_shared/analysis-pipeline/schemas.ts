// Stage 2A-5d-4a — JSON schemas sent with each call (for a provider's structured
// output). They describe the SHAPE only. The database contract
// (private.analysis_output_problems, rre-analysis/2) remains the authority on
// every rule: citations, consistency, restrictions, the review verdict.
// Whether a given provider accepts every keyword here is checked in Stage
// 2A-5d-4b, before any real call.

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;
const ref = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['MESSAGE', 'SCREENSHOT'] },
    message_id: str,
    position: { type: 'integer' },
    quote: str,
  },
  required: ['type'],
} as const;
const refs = { type: 'array', items: ref } as const;
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });

/** The analyst's answer: an rre-analysis/1 body plus its status and classification (removed before storage). */
export const ANALYST_SCHEMA = obj({
  analysis_status: { type: 'string', enum: ['COMPLETE', 'INSUFFICIENT_EVIDENCE'] },
  classification: { type: ['string', 'null'], enum: ['GREEN', 'YELLOW', 'RED', null] },
  evidence_assessment: obj({
    sufficiency: { type: 'string', enum: ['SUFFICIENT', 'PARTIAL', 'INSUFFICIENT'] },
    summary: str,
    missing_evidence: strArr,
  }),
  observations: { type: 'array', items: obj({
    id: str, actor: { type: 'string', enum: ['PROSPECT', 'SELLER', 'UNCLEAR'] }, behavior: str, evidence: refs,
  }) },
  hypotheses: { type: 'array', items: obj({
    id: str,
    category: { type: 'string', enum: ['EMOTIONAL_BARRIER', 'TRUST_AND_RISK', 'BUYING_MOTIVATION', 'DECISION_FRICTION', 'SELLER_CREATED_RESISTANCE'] },
    statement: str,
    basis: { type: 'string', enum: ['STATED_BY_PROSPECT', 'HYPOTHESIS'] },
    supporting_observations: strArr,
    contradicting_observations: strArr,
    competing_hypotheses: strArr,
    confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
    uncertainty: str,
  }) },
  unknowns: { type: 'array', items: obj({ question: str, why_it_matters: str }) },
  recommendation: obj({
    pursue: { type: 'string', enum: ['PURSUE', 'DO_NOT_PURSUE', 'UNKNOWN'] },
    strategy: str,
    psychological_rationale: str,
    based_on_hypotheses: strArr,
    next_action: obj({ type: { type: 'string', enum: ['SEND_MESSAGE', 'ASK_DIAGNOSTIC_QUESTION', 'WAIT', 'STOP_CONTACT'] }, text: str }),
  }),
  contact_restrictions: { type: 'array', items: obj({
    kind: { type: 'string', enum: ['EXPLICIT_OPT_OUT', 'PROHIBITED_CONTACT', 'OTHER'] }, reason: str, evidence: refs,
  }) },
  reasons_not_to_pursue: { type: 'array', items: obj({ reason: str, evidence: refs }) },
});

/** The reviewer's answer: exactly the adversarial_review section of rre-analysis/2. */
export const REVIEWER_SCHEMA = obj({
  challenges: { type: 'array', items: obj({
    id: str,
    target: { type: 'string', enum: ['OBSERVATION', 'HYPOTHESIS', 'RECOMMENDATION'] },
    target_id: { type: ['string', 'null'] },
    severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    challenge: str,
    evidence: refs,
  }) },
  verdict: { type: 'string', enum: ['UPHOLD', 'UPHOLD_WITH_CONCERNS', 'REJECT_RECOMMENDATION'] },
  verdict_rationale: str,
});

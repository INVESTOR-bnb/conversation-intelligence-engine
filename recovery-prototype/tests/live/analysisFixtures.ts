// Synthetic rre-analysis/1 outputs and analysis rows for the founder workspace
// tests. All content is invented. The quotes match mock case P-101's synthetic
// conversation ("Prospect: Is the Camry available?\nBusiness: Yes, synthetic.").

export const MSG = 'Would Saturday at 10 suit you to see the Camry?';

export function richOutput(messageId: string) {
  const ref = (quote: string) => [{ type: 'MESSAGE', message_id: messageId, quote }];
  return {
    contract_version: 'rre-analysis/1',
    evidence_assessment: { sufficiency: 'PARTIAL', summary: 'One short synthetic exchange.', missing_evidence: ['What the prospect compared it with'] },
    observations: [
      { id: 'O1', actor: 'PROSPECT', behavior: 'Asked whether the Camry is available.', evidence: ref('Is the Camry available?') },
      { id: 'O2', actor: 'SELLER', behavior: 'Answered with two words and no next step.', evidence: ref('Yes, synthetic.') },
    ],
    hypotheses: [
      { id: 'H1', category: 'BUYING_MOTIVATION', statement: 'Interested in this specific car.', basis: 'STATED_BY_PROSPECT',
        supporting_observations: ['O1'], contradicting_observations: [], competing_hypotheses: ['H4'], confidence: 'MEDIUM', uncertainty: 'Availability questions can also be casual.' },
      { id: 'H2', category: 'TRUST_AND_RISK', statement: 'Unsure whether the listing is genuine.', basis: 'HYPOTHESIS',
        supporting_observations: ['O1'], contradicting_observations: [], competing_hypotheses: ['H1'], confidence: 'LOW', uncertainty: 'Nothing names a trust concern directly.' },
      { id: 'H3', category: 'SELLER_CREATED_RESISTANCE', statement: 'The short reply gave no reason to continue.', basis: 'HYPOTHESIS',
        supporting_observations: ['O2'], contradicting_observations: [], competing_hypotheses: ['H2'], confidence: 'MEDIUM', uncertainty: 'Tone is hard to judge from text.' },
      { id: 'H4', category: 'DECISION_FRICTION', statement: 'Comparing several dealers.', basis: 'HYPOTHESIS',
        supporting_observations: ['O1'], contradicting_observations: ['O2'], competing_hypotheses: ['H1'], confidence: 'LOW', uncertainty: 'No other dealer is mentioned.' },
    ],
    unknowns: [{ question: 'Is the prospect still looking?', why_it_matters: 'Decides whether a message is welcome.' }],
    recommendation: {
      pursue: 'PURSUE', strategy: 'Offer a specific viewing time with no pressure.', psychological_rationale: 'Turns stated interest into a low-effort next step.',
      based_on_hypotheses: ['H1', 'H3'], next_action: { type: 'SEND_MESSAGE', text: MSG },
    },
    contact_restrictions: [],
    reasons_not_to_pursue: [],
  };
}

/** An rre-analysis/2 output: the rich output plus an independent adversarial review. */
export function reviewedOutput(messageId: string, verdict: 'UPHOLD' | 'UPHOLD_WITH_CONCERNS' | 'REJECT_RECOMMENDATION' = 'UPHOLD_WITH_CONCERNS') {
  const base = richOutput(messageId);
  const rejected = verdict === 'REJECT_RECOMMENDATION';
  return {
    ...base,
    contract_version: 'rre-analysis/2',
    // A rejected recommendation carries no message (the database contract enforces this).
    recommendation: rejected
      ? { pursue: 'UNKNOWN', strategy: 'UNKNOWN', psychological_rationale: 'UNKNOWN', based_on_hypotheses: [], next_action: { type: 'WAIT', text: 'Wait for the prospect.' } }
      : base.recommendation,
    adversarial_review: {
      challenges: [
        { id: 'C1', target: 'HYPOTHESIS', target_id: 'H1', severity: 'MEDIUM', challenge: 'Availability questions are often casual browsing.',
          evidence: [{ type: 'MESSAGE', message_id: messageId, quote: 'Is the Camry available?' }] },
        { id: 'C2', target: 'RECOMMENDATION', severity: rejected ? 'HIGH' : 'LOW', challenge: 'A fixed viewing time may feel like pressure.', evidence: [] },
      ],
      verdict,
      verdict_rationale: rejected ? 'Interest is not established; a pitch now is premature.' : 'The recommendation holds, with caveats.',
    },
  };
}

export function insufficientOutput() {
  return {
    contract_version: 'rre-analysis/1',
    evidence_assessment: { sufficiency: 'INSUFFICIENT', summary: 'Too little to analyse.', missing_evidence: ['The rest of the conversation'] },
    observations: [], hypotheses: [],
    unknowns: [{ question: 'What happened after the price was given?', why_it_matters: 'Any reading without it would be invented.' }],
    recommendation: { pursue: 'UNKNOWN', strategy: 'UNKNOWN', psychological_rationale: 'UNKNOWN', based_on_hypotheses: [],
      next_action: { type: 'ASK_DIAGNOSTIC_QUESTION', text: 'Ask the business for the full conversation.' } },
    contact_restrictions: [], reasons_not_to_pursue: [],
  };
}

let n = 0;
export function analysisRow(caseId: string, over: Record<string, unknown> = {}) {
  n += 1;
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, case_id: caseId, version: 1, status: 'COMPLETE', evidence_version: 1,
    evidence_manifest: { manifest_version: 2, screenshots: [], excluded_screenshots: [], messages: [] },
    output: null, ai_classification: 'GREEN', ai_proposed_message: MSG, error: null, model: 'synthetic-model', prompt_version: 'v1',
    created_at: '2026-10-12T10:00:00Z', completed_at: '2026-10-12T10:01:00Z', ...over,
  };
}

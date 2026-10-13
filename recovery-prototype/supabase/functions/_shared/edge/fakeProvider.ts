// Stage 2A-5d-4b — the only provider in this stage: a FAKE that can never be
// mistaken for an AI analysis.
//
// It ignores the evidence and always answers with an INSUFFICIENT_EVIDENCE
// analysis whose every text says it is a pipeline test, with no hypotheses, no
// classification, no recommendation to contact anyone and no draft message,
// reviewed (UPHOLD_WITH_CONCERNS) with a single challenge saying the same. The
// stored model is "analyst:FAKE-PROVIDER-NOT-AI|reviewer:FAKE-PROVIDER-NOT-AI" and
// the founder workspace labels such analyses. It costs nothing (it reports 0 tokens).
// config.ts only enables it with ALLOW_FAKE_PROVIDER=staging-only on the staging
// project (or a local test host).

import type { AnalysisProvider, ModelConfig, ProviderRequest, ProviderResponse } from '../analysis-pipeline/index.ts';

export const FAKE_MODEL = 'FAKE-PROVIDER-NOT-AI';
export const FAKE_MARK = '[FAKE PROVIDER — pipeline test, NOT an AI analysis]';

// Priced in private.ai_model_prices at 0/0 with an output cap of 1 (Stage 2A-5d-3a seed): it reserves USD 0, but still
// needs spending enabled, a reservation and a dispatch record like any provider.
export const FAKE_MODEL_CONFIG: ModelConfig = { model: FAKE_MODEL, inputPerMTok: 0, outputPerMTok: 0 };

export function fakeAnalystAnswer() {
  return {
    analysis_status: 'INSUFFICIENT_EVIDENCE',
    classification: null,
    evidence_assessment: {
      sufficiency: 'INSUFFICIENT',
      summary: `${FAKE_MARK} No AI read this case. This record only proves the pipeline ran end to end.`,
      missing_evidence: [`${FAKE_MARK} A real AI analysis (no AI provider is connected).`],
    },
    observations: [],
    hypotheses: [],
    unknowns: [{ question: `${FAKE_MARK} What would a real analysis find?`, why_it_matters: `${FAKE_MARK} Nothing here is a finding.` }],
    recommendation: {
      pursue: 'UNKNOWN', strategy: 'UNKNOWN', psychological_rationale: 'UNKNOWN', based_on_hypotheses: [],
      next_action: { type: 'WAIT', text: `${FAKE_MARK} No recommendation. Do not act on this record.` },
    },
    contact_restrictions: [],
    reasons_not_to_pursue: [],
  };
}

export function fakeReviewAnswer() {
  return {
    challenges: [{ id: 'C1', target: 'RECOMMENDATION', target_id: null, severity: 'LOW', evidence: [],
      challenge: `${FAKE_MARK} There is no real analysis to review.` }],
    verdict: 'UPHOLD_WITH_CONCERNS',
    verdict_rationale: `${FAKE_MARK} Pipeline test only.`,
  };
}

export class FakeAnalysisProvider implements AnalysisProvider {
  readonly maxRetries = 0 as const;
  call(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.signal.aborted) return Promise.reject(new Error('aborted'));
    const answer = request.role === 'ANALYST' ? fakeAnalystAnswer() : fakeReviewAnswer();
    return Promise.resolve({ text: JSON.stringify(answer), stopReason: 'end_turn', inputTokens: 0, outputTokens: 0 });
  }
}

// Stage 2A-5d-4a — test doubles for the analysis pipeline core. Synthetic data only.
// FakeDb mimics the founder-scoped reads, the lock, and internal_complete_analysis's
// observable effects (it does NOT judge the contract; the database tests do that).

import {
  DbError, sha256Hex, type AnalysisProvider, type AnalysisRecord, type CompletionParams, type FounderDb, type MessageRow,
  type PipelineConfig, type PipelineLogger, type ProviderRequest, type ProviderResponse, type ScreenshotFile, type ServiceDb,
} from '../../supabase/functions/_shared/analysis-pipeline/index.ts';

export const CASE = 'c0000000-0000-4000-8000-000000000001';
export const M1 = 'a0000000-0000-4000-8000-000000000001';
export const M2 = 'a0000000-0000-4000-8000-000000000002';
export const M_OUTSIDE = 'a0000000-0000-4000-8000-0000000000ff';
export const S1 = 'b0000000-0000-4000-8000-000000000001';
export const BODY1 = 'Prospect: I like the car but the price feels high. Business: It is our best price.';
export const BODY2 = 'Prospect: Can I see it on Saturday?';
export const BODY_OUTSIDE = 'SECRET-OUTSIDE-SNAPSHOT: a message added after the analysis started.';
export const SHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
export const DRAFT = 'SYNTHETIC-DRAFT: Would Saturday at 10 suit you for a viewing?';

export async function manifest(over: Record<string, unknown> = {}) {
  return {
    manifest_version: 2, evidence_version: 1,
    messages: [
      { id: M1, kind: 'PASTED_CONVERSATION', created_at: '2026-10-01T10:00:00Z', body_sha256: await sha256Hex(BODY1) },
      { id: M2, kind: 'PROSPECT_RESPONSE', created_at: '2026-10-02T10:00:00Z', body_sha256: await sha256Hex(BODY2) },
    ],
    screenshots: [{ id: S1, position: 1, sha256: await sha256Hex(SHOT) }],
    excluded_screenshots: [],
    restrictions: [],
    ...over,
  };
}

export class FakeDb implements FounderDb, ServiceDb {
  restrictions = 0;
  analysis: AnalysisRecord | null = null;
  messages: MessageRow[] = [
    { id: M1, kind: 'PASTED_CONVERSATION', body: BODY1 },
    { id: M2, kind: 'PROSPECT_RESPONSE', body: BODY2 },
    { id: M_OUTSIDE, kind: 'PROSPECT_RESPONSE', body: BODY_OUTSIDE },
  ];
  files = new Map<string, ScreenshotFile>([[S1, { position: 1, mimeType: 'image/png', bytes: SHOT }]]);
  manifestValue: unknown;
  startError: Error | null = null;
  /** What internal_complete_analysis does with a successful output: COMPLETE, a contract rejection, or STALE. */
  onComplete: 'ACCEPT' | 'REJECT' | 'STALE' = 'ACCEPT';
  completeThrows: ('SUCCESS' | 'ERROR')[] = [];
  /** The success call commits, then the connection fails (the caller sees an error). */
  commitThenThrow = false;
  abandonThrows = false;
  getAnalysisThrowsAfterCompletion = false;
  calls: string[] = [];
  completions: CompletionParams[] = [];
  messageIdsRequested: string[][] = [];

  constructor(manifestValue: unknown) { this.manifestValue = manifestValue; }

  async activeRestrictionCount(caseId: string) { this.calls.push(`restrictions:${caseId}`); return this.restrictions; }
  async startAnalysis(caseId: string) {
    this.calls.push(`start:${caseId}`);
    if (this.startError) throw this.startError;
    if (this.analysis?.status === 'PENDING') throw new DbError('INVALID_STATE', 'INVALID_STATE: case is not waiting for analysis');
    this.analysis = { id: 'e0000000-0000-4000-8000-000000000001', caseId, status: 'PENDING', evidenceVersion: 1, evidenceManifest: this.manifestValue, error: null };
    return this.analysis.id;
  }
  async getAnalysis(id: string) {
    this.calls.push('getAnalysis');
    if (this.getAnalysisThrowsAfterCompletion && this.completions.length > 0) throw new Error('connection reset');
    return this.analysis && this.analysis.id === id ? { ...this.analysis } : null;
  }
  async getMessages(caseId: string, ids: string[]) {
    this.messageIdsRequested.push([...ids]);
    return caseId === this.analysis?.caseId ? this.messages.filter((m) => ids.includes(m.id)) : [];
  }
  async getScreenshotFile(caseId: string, id: string) {
    return caseId === this.analysis?.caseId ? this.files.get(id) ?? null : null;
  }
  async abandonAnalysis(id: string) {
    this.calls.push('abandon');
    if (this.abandonThrows) throw new Error('network down');
    if (this.analysis?.id !== id || this.analysis.status !== 'PENDING') throw new DbError('INVALID_STATE');
    this.analysis.status = 'ERROR';
    this.analysis.error = 'Abandoned by founder';
  }
  async completeAnalysis(p: CompletionParams) {
    this.calls.push(`complete:${p.status}`);
    const kind = p.status === 'ERROR' ? 'ERROR' : 'SUCCESS';
    const i = this.completeThrows.indexOf(kind);
    if (i >= 0) { this.completeThrows.splice(i, 1); throw new Error('network down: SYNTHETIC-SECRET sb_secret_FAKE'); }
    if (!this.analysis || this.analysis.id !== p.analysisId || this.analysis.status !== 'PENDING') throw new DbError('INVALID_STATE');
    this.completions.push(structuredClone(p));
    if (p.status === 'ERROR') { this.analysis.status = 'ERROR'; this.analysis.error = p.error; }
    else if (this.onComplete === 'REJECT') { this.analysis.status = 'ERROR'; this.analysis.error = 'REJECTED by analysis contract rre-analysis/1: synthetic'; }
    else if (this.onComplete === 'STALE') { this.analysis.status = 'ERROR'; this.analysis.error = 'STALE: evidence changed during analysis'; }
    else { this.analysis.status = p.status; }
    if (this.commitThenThrow) { this.commitThenThrow = false; throw new Error('connection reset after commit'); }
  }
}

type Reply = ProviderResponse | Error | 'HANG' | ((r: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>);
export class FakeProvider implements AnalysisProvider {
  requests: ProviderRequest[] = [];
  constructor(public replies: Partial<Record<'ANALYST' | 'REVIEWER', Reply>>) {}
  async call(r: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(r);
    const reply = this.replies[r.role];
    if (!reply) throw new Error(`no scripted reply for ${r.role}`);
    if (reply === 'HANG') return new Promise(() => {});
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(r) : reply;
  }
}

export const ok = (value: unknown, inputTokens = 1000, outputTokens = 500): ProviderResponse =>
  ({ text: JSON.stringify(value), stopReason: 'end_turn', inputTokens, outputTokens });

export class MemoryLogger implements PipelineLogger {
  events: { name: string; fields?: Record<string, unknown> }[] = [];
  event(name: string, fields?: Record<string, string | number | boolean | null>) { this.events.push({ name, fields }); }
}

export const CONFIG: PipelineConfig = {
  analyst: { model: 'fake-analyst', maxOutputTokens: 8000, inputPerMTok: 2, outputPerMTok: 10 },
  reviewer: { model: 'fake-reviewer', maxOutputTokens: 4000, inputPerMTok: 4, outputPerMTok: 20 },
  callTimeoutMs: 200, deadlineMs: 5000, completionReserveMs: 500, maxScreenshotBytes: 1024,
};

// ---------------------------------------------------------------- synthetic model answers

/** A contract-valid analyst answer for the synthetic evidence (message ids are parameters so the DB test can reuse it). */
export function analystAnswer(m1 = M1, m2 = M2, over: Record<string, unknown> = {}) {
  return {
    analysis_status: 'COMPLETE',
    classification: 'GREEN',
    evidence_assessment: { sufficiency: 'PARTIAL', summary: 'A pasted conversation and one later reply.', missing_evidence: ['Who else decides'] },
    observations: [
      { id: 'O1', actor: 'PROSPECT', behavior: 'Said the price feels high.', evidence: [{ type: 'MESSAGE', message_id: m1, quote: 'the price feels high' }] },
      { id: 'O2', actor: 'PROSPECT', behavior: 'Asked to see the car on Saturday.', evidence: [{ type: 'MESSAGE', message_id: m2, quote: 'Can I see it on Saturday' }] },
    ],
    hypotheses: [
      { id: 'H1', category: 'BUYING_MOTIVATION', statement: 'Still interested in this car.', basis: 'STATED_BY_PROSPECT',
        supporting_observations: ['O2'], contradicting_observations: [], competing_hypotheses: ['H2'], confidence: 'MEDIUM',
        uncertainty: 'A viewing request can also be casual.' },
      { id: 'H2', category: 'TRUST_AND_RISK', statement: 'The price feels high for the value seen.', basis: 'HYPOTHESIS',
        supporting_observations: ['O1'], contradicting_observations: [], competing_hypotheses: ['H1'], confidence: 'LOW',
        uncertainty: 'No target price was given.' },
    ],
    unknowns: [{ question: 'Who else decides?', why_it_matters: 'Changes who the message should address.' }],
    recommendation: {
      pursue: 'PURSUE', strategy: 'Offer the Saturday viewing with no pressure.', psychological_rationale: 'Turns stated interest into a small next step.',
      based_on_hypotheses: ['H1'], next_action: { type: 'SEND_MESSAGE', text: DRAFT },
    },
    contact_restrictions: [],
    reasons_not_to_pursue: [],
    ...over,
  };
}

export function reviewAnswer(verdict: 'UPHOLD' | 'UPHOLD_WITH_CONCERNS' | 'REJECT_RECOMMENDATION', m1 = M1, over: Record<string, unknown> = {}) {
  const challenges = verdict === 'UPHOLD' ? [] : [
    { id: 'C1', target: 'HYPOTHESIS', target_id: 'H1', severity: 'MEDIUM', challenge: 'SYNTHETIC-REVIEW: interest may be casual.',
      evidence: [{ type: 'MESSAGE', message_id: m1, quote: 'the price feels high' }] },
    ...(verdict === 'REJECT_RECOMMENDATION'
      ? [{ id: 'C2', target: 'RECOMMENDATION', target_id: null, severity: 'HIGH', challenge: 'SYNTHETIC-REVIEW: a fixed time is premature.', evidence: [] }]
      : []),
  ];
  return { challenges, verdict, verdict_rationale: `SYNTHETIC-REVIEW rationale for ${verdict}.`, ...over };
}

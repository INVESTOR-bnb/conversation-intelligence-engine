// Stage 2A-5c — founder-only analysis workspace: pure logic (no React, no network).
//
// FOUNDER ONLY. Analyses are readable only by the founder: public.analyses and
// public.contact_restrictions have founder-only RLS (Stage 2A-1), so a business
// user's request returns no rows whatever the UI does. This module only shapes
// data the database already allowed the founder to read. It never sends
// anything to a prospect: there is no send path anywhere in this workspace.
//
// The stored output has already passed the database contract rre-analysis/1
// (Stage 2A-5a). It is parsed defensively again here: unknown fields are
// ignored and malformed values are dropped, never rendered as HTML.

export const CONTRACT_VERSION = 'rre-analysis/1';

export type HypothesisCategory =
  | 'EMOTIONAL_BARRIER' | 'TRUST_AND_RISK' | 'BUYING_MOTIVATION' | 'DECISION_FRICTION' | 'SELLER_CREATED_RESISTANCE';
export const CATEGORY_ORDER: HypothesisCategory[] =
  ['EMOTIONAL_BARRIER', 'TRUST_AND_RISK', 'BUYING_MOTIVATION', 'DECISION_FRICTION', 'SELLER_CREATED_RESISTANCE'];
export const CATEGORY_LABELS: Record<HypothesisCategory, string> = {
  EMOTIONAL_BARRIER: 'Emotional barriers',
  TRUST_AND_RISK: 'Trust and perceived risk',
  BUYING_MOTIVATION: 'Buying motivations',
  DECISION_FRICTION: 'Decision friction',
  SELLER_CREATED_RESISTANCE: 'Seller-created resistance',
};

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type EvidenceRef =
  | { type: 'MESSAGE'; messageId: string; quote: string }
  | { type: 'SCREENSHOT'; position: number; quote: string | null };
export interface Observation { id: string; actor: 'PROSPECT' | 'SELLER' | 'UNCLEAR'; behavior: string; evidence: EvidenceRef[] }
export interface Hypothesis {
  id: string; category: HypothesisCategory; statement: string; basis: 'STATED_BY_PROSPECT' | 'HYPOTHESIS';
  supporting: string[]; contradicting: string[]; competing: string[]; confidence: Confidence; uncertainty: string;
}
export interface Unknown { question: string; whyItMatters: string }
export interface Recommendation {
  pursue: 'PURSUE' | 'DO_NOT_PURSUE' | 'UNKNOWN';
  strategy: string; rationale: string; basedOn: string[];
  nextAction: { type: 'SEND_MESSAGE' | 'ASK_DIAGNOSTIC_QUESTION' | 'WAIT' | 'STOP_CONTACT'; text: string } | null;
}
export interface AnalysisOutput {
  sufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT';
  summary: string; missingEvidence: string[];
  observations: Observation[]; hypotheses: Hypothesis[]; unknowns: Unknown[];
  recommendation: Recommendation;
  contactRestrictions: { kind: string; reason: string; evidence: EvidenceRef[] }[];
  reasonsNotToPursue: { reason: string; evidence: EvidenceRef[] }[];
}

const str = (v: unknown, max = 5000): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);
const ids = (v: unknown) => arr(v).filter((x): x is string => typeof x === 'string');
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function parseRef(v: unknown): EvidenceRef | null {
  const o = obj(v);
  if (!o) return null;
  if (o.type === 'MESSAGE' && str(o.message_id) && str(o.quote)) return { type: 'MESSAGE', messageId: o.message_id as string, quote: str(o.quote, 500)! };
  if (o.type === 'SCREENSHOT' && Number.isInteger(o.position) && (o.position as number) >= 1 && (o.position as number) <= 10) {
    return { type: 'SCREENSHOT', position: o.position as number, quote: str(o.quote, 500) };
  }
  return null;
}
const refs = (v: unknown) => arr(v).map(parseRef).filter((r): r is EvidenceRef => r !== null);

/** Parses a stored rre-analysis/1 output. Returns null if it is not one (nothing is shown then). */
export function parseAnalysisOutput(value: unknown): AnalysisOutput | null {
  const o = obj(value);
  if (!o || o.contract_version !== CONTRACT_VERSION) return null;
  const ea = obj(o.evidence_assessment);
  const rec = obj(o.recommendation);
  const sufficiency = oneOf(ea?.sufficiency, ['SUFFICIENT', 'PARTIAL', 'INSUFFICIENT'] as const);
  const pursue = oneOf(rec?.pursue, ['PURSUE', 'DO_NOT_PURSUE', 'UNKNOWN'] as const);
  if (!ea || !rec || !sufficiency || !pursue) return null;
  const na = obj(rec.next_action);
  const naType = oneOf(na?.type, ['SEND_MESSAGE', 'ASK_DIAGNOSTIC_QUESTION', 'WAIT', 'STOP_CONTACT'] as const);
  return {
    sufficiency,
    summary: str(ea.summary, 1000) ?? '',
    missingEvidence: arr(ea.missing_evidence).map((x) => str(x, 500)).filter((x): x is string => !!x),
    observations: arr(o.observations).flatMap((x) => {
      const ob = obj(x);
      const actor = oneOf(ob?.actor, ['PROSPECT', 'SELLER', 'UNCLEAR'] as const);
      const behavior = str(ob?.behavior, 1000);
      return ob && str(ob.id) && actor && behavior ? [{ id: ob.id as string, actor, behavior, evidence: refs(ob.evidence) }] : [];
    }),
    hypotheses: arr(o.hypotheses).flatMap((x) => {
      const h = obj(x);
      const category = oneOf(h?.category, CATEGORY_ORDER);
      const basis = oneOf(h?.basis, ['STATED_BY_PROSPECT', 'HYPOTHESIS'] as const);
      const statement = str(h?.statement, 1000);
      if (!h || !str(h.id) || !category || !basis || !statement) return [];
      return [{
        id: h.id as string, category, statement, basis,
        supporting: ids(h.supporting_observations), contradicting: ids(h.contradicting_observations), competing: ids(h.competing_hypotheses),
        confidence: oneOf(h.confidence, ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const) ?? 'UNKNOWN',
        uncertainty: str(h.uncertainty, 1000) ?? '',
      }];
    }),
    unknowns: arr(o.unknowns).flatMap((x) => {
      const u = obj(x);
      const question = str(u?.question, 500);
      return question ? [{ question, whyItMatters: str(u?.why_it_matters, 500) ?? '' }] : [];
    }),
    recommendation: {
      pursue,
      strategy: str(rec.strategy, 1500) ?? 'UNKNOWN',
      rationale: str(rec.psychological_rationale, 1500) ?? 'UNKNOWN',
      basedOn: ids(rec.based_on_hypotheses),
      nextAction: naType && str(na?.text) ? { type: naType, text: str(na?.text, 2000)! } : null,
    },
    contactRestrictions: arr(o.contact_restrictions).flatMap((x) => {
      const c = obj(x);
      return c && str(c.kind) ? [{ kind: c.kind as string, reason: str(c.reason, 1000) ?? '', evidence: refs(c.evidence) }] : [];
    }),
    reasonsNotToPursue: arr(o.reasons_not_to_pursue).flatMap((x) => {
      const r = obj(x);
      return r && str(r.reason) ? [{ reason: str(r.reason, 1000)!, evidence: refs(r.evidence) }] : [];
    }),
  };
}

// ---------------------------------------------------------------- the analysis row and its state

export interface AnalysisRow {
  id: string; version: number; status: 'PENDING' | 'COMPLETE' | 'INSUFFICIENT_EVIDENCE' | 'ERROR';
  evidence_version: number; evidence_manifest: unknown; output: unknown;
  ai_classification: 'GREEN' | 'YELLOW' | 'RED' | null; ai_proposed_message: string | null;
  error: string | null; model: string | null; prompt_version: string | null; created_at: string; completed_at: string | null;
}
export interface RestrictionRow { id: string; kind: string; source: string; status: string; note: string | null; created_at: string }

export type AnalysisState = 'NONE' | 'IN_PROGRESS' | 'READY' | 'INSUFFICIENT' | 'STALE' | 'REJECTED' | 'FAILED';

/**
 * State of the latest analysis for a case. `analyses` is every analysis of the
 * case (any order). STALE = the evidence changed since the analysis (it cannot
 * be approved; the database refuses with STALE_ANALYSIS).
 */
export function analysisState(analyses: AnalysisRow[], caseEvidenceVersion: number): { state: AnalysisState; latest: AnalysisRow | null } {
  if (analyses.length === 0) return { state: 'NONE', latest: null };
  const latest = [...analyses].sort((a, b) => b.version - a.version)[0];
  if (latest.status === 'PENDING') return { state: 'IN_PROGRESS', latest };
  if (latest.status === 'ERROR') {
    const e = latest.error ?? '';
    if (e.startsWith('REJECTED')) return { state: 'REJECTED', latest };
    if (e.startsWith('STALE')) return { state: 'STALE', latest };
    return { state: 'FAILED', latest };
  }
  if (latest.evidence_version !== caseEvidenceVersion) return { state: 'STALE', latest };
  return { state: latest.status === 'INSUFFICIENT_EVIDENCE' ? 'INSUFFICIENT' : 'READY', latest };
}

export const STATE_TEXT: Record<AnalysisState, { title: string; body: string; tone: 'info' | 'warn' | 'private' }> = {
  NONE: { title: 'No analysis yet', body: 'No analysis has been run for this case.', tone: 'info' },
  IN_PROGRESS: { title: 'Analysis in progress', body: 'An analysis was started and has not finished. Nothing is shown until it is complete and has passed the analysis contract.', tone: 'info' },
  READY: { title: 'Analysis ready for review', body: 'Based on the current evidence. Review it before any decision; nothing is sent from this page.', tone: 'private' },
  INSUFFICIENT: { title: 'Insufficient evidence', body: 'The analysis found too little evidence for findings. Only what is missing is shown; no hypotheses or recommendation were made.', tone: 'warn' },
  STALE: { title: 'Stale — evidence changed', body: 'The evidence changed after this analysis (for example a screenshot was deleted or a reply was added). It cannot be approved. Request a re-analysis.', tone: 'warn' },
  REJECTED: { title: 'Analysis rejected', body: 'The analysis did not pass the analysis contract (for example a quote that is not in the evidence) and was discarded. No findings are kept.', tone: 'warn' },
  FAILED: { title: 'Analysis failed', body: 'The analysis did not complete. No findings are kept.', tone: 'warn' },
};

/** Findings are shown only for an analysis that passed the contract and is not in progress. */
export function showsFindings(state: AnalysisState) {
  return state === 'READY' || state === 'INSUFFICIENT' || state === 'STALE';
}

/**
 * The proposed message, only when it may be shown as a draft: a current, accepted
 * analysis recommending SEND_MESSAGE, with no active contact restriction and not
 * RED. Even then it is only text for the founder to review; nothing sends it.
 */
export function proposedMessage(state: AnalysisState, row: AnalysisRow | null, output: AnalysisOutput | null, restrictions: RestrictionRow[]):
  { text: string | null; withheld: string | null } {
  if (!row || !output || !row.ai_proposed_message) return { text: null, withheld: null };
  if (restrictions.some((r) => r.status === 'ACTIVE')) return { text: null, withheld: 'Withheld: this case has an active contact restriction. Do not contact the prospect.' };
  if (state !== 'READY') return { text: null, withheld: 'Withheld: this analysis is not current. Request a re-analysis.' };
  if (row.ai_classification === 'RED' || output.recommendation.nextAction?.type !== 'SEND_MESSAGE') return { text: null, withheld: null };
  return { text: row.ai_proposed_message, withheld: null };
}

// ---------------------------------------------------------------- adversarial challenges

export interface Challenge { kind: 'CONTRADICTION' | 'COMPETING' | 'LOW_CONFIDENCE' | 'REASON_NOT_TO_PURSUE' | 'UNKNOWN' | 'RESTRICTION'; text: string }

/**
 * Challenges to the analysis and its recommendation, drawn only from what the
 * analysis itself recorded (rre-analysis/1 has no separate challenger pass):
 * evidence that contradicts a hypothesis, competing explanations, weak or
 * unknown confidence behind the recommendation, reasons not to pursue, open
 * unknowns and contact restrictions.
 */
export function challenges(output: AnalysisOutput, restrictions: RestrictionRow[] = []): Challenge[] {
  const out: Challenge[] = [];
  const obs = new Map(output.observations.map((o) => [o.id, o]));
  const hyp = new Map(output.hypotheses.map((h) => [h.id, h]));
  for (const r of restrictions.filter((x) => x.status === 'ACTIVE')) {
    out.push({ kind: 'RESTRICTION', text: `Active contact restriction (${r.kind}, ${r.source}): any recommendation to contact is overridden.` });
  }
  for (const h of output.hypotheses) {
    for (const id of h.contradicting) {
      const o = obs.get(id);
      out.push({ kind: 'CONTRADICTION', text: `${h.id} (“${h.statement}”) is contradicted by ${id}${o ? `: ${o.behavior}` : ''}` });
    }
    for (const id of h.competing) {
      const c = hyp.get(id);
      out.push({ kind: 'COMPETING', text: `${h.id} competes with ${id}${c ? ` (“${c.statement}”)` : ''}` });
    }
  }
  for (const id of output.recommendation.basedOn) {
    const h = hyp.get(id);
    if (h && (h.confidence === 'LOW' || h.confidence === 'UNKNOWN')) {
      out.push({ kind: 'LOW_CONFIDENCE', text: `The recommendation rests on ${id}, which has ${h.confidence} confidence: ${h.uncertainty}` });
    }
  }
  for (const r of output.reasonsNotToPursue) out.push({ kind: 'REASON_NOT_TO_PURSUE', text: r.reason });
  for (const u of output.unknowns) out.push({ kind: 'UNKNOWN', text: `${u.question}${u.whyItMatters ? ` — ${u.whyItMatters}` : ''}` });
  return out;
}

/** Excluded (deleted) screenshots listed in a v2 evidence manifest. */
export function excludedScreenshots(manifest: unknown): number[] {
  return arr(obj(manifest)?.excluded_screenshots).map((x) => obj(x)?.position).filter((p): p is number => Number.isInteger(p));
}

export function describeRef(ref: EvidenceRef, messageKinds: Record<string, string> = {}): string {
  if (ref.type === 'SCREENSHOT') {
    return `Screenshot ${ref.position}${ref.quote ? `: “${ref.quote}” (model-reported, not verified)` : ''}`;
  }
  const kind = messageKinds[ref.messageId];
  const label = kind === 'PROSPECT_RESPONSE' ? 'Prospect reply' : kind === 'RECOVERY_SENT' ? 'Sent recovery message' : 'Pasted conversation';
  return `${label}: “${ref.quote}”`;
}

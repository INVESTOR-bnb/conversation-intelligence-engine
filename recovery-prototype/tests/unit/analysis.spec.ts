// Stage 2A-5c — founder analysis workspace logic (src/live/analysis.ts).
// Synthetic data only.

import { expect, test } from '@playwright/test';
import {
  analysisState, challenges, describeRef, excludedScreenshots, parseAnalysisOutput, proposedMessage, showsFindings, type AnalysisRow, type RestrictionRow,
} from '../../src/live/analysis';
import { analysisRow, insufficientOutput, MSG, richOutput } from '../live/analysisFixtures';

const MID = 'b0000000-0000-4000-8000-000000000101';
const row = (over: Record<string, unknown> = {}) => analysisRow('c', { output: richOutput(MID), ...over }) as unknown as AnalysisRow;
const restriction = (status = 'ACTIVE'): RestrictionRow => ({ id: 'r1', kind: 'EXPLICIT_OPT_OUT', source: 'AI_DETECTED', status, note: 'synthetic', created_at: '' });

test('parses a contract output, keeping observations and hypotheses separate', () => {
  const o = parseAnalysisOutput(richOutput(MID))!;
  expect(o.observations.map((x) => x.id)).toEqual(['O1', 'O2']);
  expect(o.hypotheses.map((h) => [h.id, h.basis])).toEqual([['H1', 'STATED_BY_PROSPECT'], ['H2', 'HYPOTHESIS'], ['H3', 'HYPOTHESIS'], ['H4', 'HYPOTHESIS']]);
  expect(o.observations[0].evidence).toEqual([{ type: 'MESSAGE', messageId: MID, quote: 'Is the Camry available?' }]);
  expect(o.recommendation.nextAction).toEqual({ type: 'SEND_MESSAGE', text: MSG });
});

test('anything that is not a rre-analysis/1 output is not shown', () => {
  for (const bad of [null, 'text', [], {}, { verdict: 'buy' }, { ...richOutput(MID), contract_version: 'rre-analysis/2' },
    { ...richOutput(MID), recommendation: { pursue: 'MAYBE' } }]) {
    expect(parseAnalysisOutput(bad)).toBeNull();
  }
});

test('malformed items are dropped and unknown fields ignored, never passed through', () => {
  const raw = richOutput(MID) as Record<string, unknown>;
  const o = parseAnalysisOutput({
    ...raw, extra_secret: 'x',
    observations: [{ id: 'O1', actor: 'ROBOT', behavior: 'x', evidence: [] }, 42, { id: 'O2', actor: 'PROSPECT', behavior: 'ok', evidence: [{ type: 'URL', url: 'http://x' }] }],
    hypotheses: [{ id: 'H1', category: 'MIND_READING', basis: 'HYPOTHESIS', statement: 'x' }],
  })!;
  expect(o.observations).toEqual([{ id: 'O2', actor: 'PROSPECT', behavior: 'ok', evidence: [] }]);
  expect(o.hypotheses).toEqual([]);
  expect(JSON.stringify(o)).not.toContain('extra_secret');
});

test('state: none, in progress, ready, insufficient', () => {
  expect(analysisState([], 1).state).toBe('NONE');
  expect(analysisState([row({ status: 'PENDING', output: null })], 1).state).toBe('IN_PROGRESS');
  expect(analysisState([row()], 1).state).toBe('READY');
  expect(analysisState([row({ status: 'INSUFFICIENT_EVIDENCE', output: insufficientOutput() })], 1).state).toBe('INSUFFICIENT');
});

test('state: stale when the evidence changed after the analysis', () => {
  expect(analysisState([row({ evidence_version: 1 })], 2).state).toBe('STALE');
  expect(analysisState([row({ status: 'ERROR', error: 'STALE: evidence changed during analysis', output: null })], 1).state).toBe('STALE');
});

test('state: rejected and failed analyses; the latest version decides', () => {
  expect(analysisState([row({ status: 'ERROR', error: 'REJECTED by analysis contract rre-analysis/1: x', output: null })], 1).state).toBe('REJECTED');
  expect(analysisState([row({ status: 'ERROR', error: 'upstream timeout', output: null })], 1).state).toBe('FAILED');
  const older = row({ version: 1 });
  const newer = row({ version: 2, status: 'ERROR', error: 'REJECTED by analysis contract rre-analysis/1: x', output: null });
  expect(analysisState([older, newer], 1)).toEqual({ state: 'REJECTED', latest: newer });
});

test('findings are shown only for analyses that passed the contract', () => {
  expect(['READY', 'INSUFFICIENT', 'STALE'].every((s) => showsFindings(s as never))).toBe(true);
  expect(['NONE', 'IN_PROGRESS', 'REJECTED', 'FAILED'].some((s) => showsFindings(s as never))).toBe(false);
});

test('the proposed message is shown only as a draft for a current, unrestricted SEND_MESSAGE analysis', () => {
  const r = row();
  const o = parseAnalysisOutput(r.output)!;
  expect(proposedMessage('READY', r, o, [])).toEqual({ text: MSG, withheld: null });
  expect(proposedMessage('READY', r, o, [restriction()]).text).toBeNull();
  expect(proposedMessage('READY', r, o, [restriction()]).withheld).toContain('active contact restriction');
  expect(proposedMessage('READY', r, o, [restriction('DISMISSED_AS_MISREAD')]).text).toBe(MSG);
  expect(proposedMessage('STALE', r, o, []).text).toBeNull();
  expect(proposedMessage('STALE', r, o, []).withheld).toContain('not current');
  expect(proposedMessage('READY', { ...r, ai_classification: 'RED' }, o, []).text).toBeNull();
  expect(proposedMessage('READY', { ...r, ai_proposed_message: null }, o, [])).toEqual({ text: null, withheld: null });
});

test('adversarial challenges come from contradictions, competing explanations, weak support, unknowns and restrictions', () => {
  const list = challenges(parseAnalysisOutput(richOutput(MID))!, [restriction()]);
  const kinds = list.map((c) => c.kind);
  expect(kinds[0]).toBe('RESTRICTION');
  expect(list.find((c) => c.kind === 'CONTRADICTION')!.text).toContain('H4');
  expect(list.find((c) => c.kind === 'CONTRADICTION')!.text).toContain('O2');
  expect(kinds.filter((k) => k === 'COMPETING')).toHaveLength(4);
  expect(kinds).toContain('UNKNOWN');
  // The recommendation rests on H1 (MEDIUM) and H3 (MEDIUM): no weak-support challenge.
  expect(kinds).not.toContain('LOW_CONFIDENCE');
  const weak = { ...richOutput(MID), recommendation: { ...richOutput(MID).recommendation, based_on_hypotheses: ['H2'] } };
  expect(challenges(parseAnalysisOutput(weak)!).some((c) => c.kind === 'LOW_CONFIDENCE' && c.text.includes('H2'))).toBe(true);
});

test('evidence references say where they come from; screenshot quotes are marked unverified', () => {
  expect(describeRef({ type: 'MESSAGE', messageId: 'm', quote: 'hi' })).toBe('Pasted conversation: “hi”');
  expect(describeRef({ type: 'MESSAGE', messageId: 'm', quote: 'hi' }, { m: 'PROSPECT_RESPONSE' })).toBe('Prospect reply: “hi”');
  expect(describeRef({ type: 'SCREENSHOT', position: 2, quote: 'ok' })).toBe('Screenshot 2: “ok” (model-reported, not verified)');
});

test('excluded (deleted) screenshots are read from the v2 manifest', () => {
  expect(excludedScreenshots({ excluded_screenshots: [{ position: 2 }, { position: 5 }] })).toEqual([2, 5]);
  expect(excludedScreenshots(null)).toEqual([]);
  expect(excludedScreenshots({ manifest_version: 1 })).toEqual([]);
});

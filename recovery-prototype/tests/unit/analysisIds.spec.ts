// Stage 2A-6f — identifiers. The first genuine Kimi run was rejected by the database contract:
// "observation ids must be unique and look like O1, O2, ...". The schema let ids be any string and
// the analyst prompt never stated the rule. Now the schemas enumerate the contract's id formats
// (a provider grammar cannot produce another), and both prompts state uniqueness and references.
// Synthetic values only; no provider is called.

import { expect, test } from '@playwright/test';
import {
  ANALYST_SCHEMA, REVIEWER_SCHEMA, schemaProblems, validateOutput,
} from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { ID_LIMIT } from '../../supabase/functions/_shared/analysis-pipeline/schemas.ts';
import { ANALYST_SYSTEM, PROMPT_VERSION, REVIEWER_SYSTEM } from '../../supabase/functions/_shared/analysis-pipeline/prompts.ts';
import { merge } from '../../supabase/functions/_shared/analysis-pipeline/pipeline.ts';
import { strictSchema } from '../../supabase/functions/_shared/edge/kimiProvider.ts';
import { analystAnswer, reviewAnswer } from '../pipeline/fakes';

const CONTRACT = { O: /^O[0-9]{1,3}$/, H: /^H[0-9]{1,3}$/, C: /^C[0-9]{1,3}$/ };
type S = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const A = ANALYST_SCHEMA as S;
const R = REVIEWER_SCHEMA as S;

test('every id the schemas allow matches the database contract format, and only those', () => {
  const obs = A.properties.observations.items.properties.id.enum as string[];
  const hyp = A.properties.hypotheses.items.properties.id.enum as string[];
  const ch = R.properties.challenges.items.properties.id.enum as string[];
  expect(obs).toHaveLength(ID_LIMIT);
  expect(obs.every((i) => CONTRACT.O.test(i)) && hyp.every((i) => CONTRACT.H.test(i)) && ch.every((i) => CONTRACT.C.test(i))).toBe(true);
  expect(new Set(obs).size).toBe(obs.length);
  // references may only name ids of the right kind
  const h = A.properties.hypotheses.items.properties;
  expect(h.supporting_observations.items.enum).toEqual(obs);
  expect(h.contradicting_observations.items.enum).toEqual(obs);
  expect(h.competing_hypotheses.items.enum).toEqual(hyp);
  expect(A.properties.recommendation.properties.based_on_hypotheses.items.enum).toEqual(hyp);
  expect(R.properties.challenges.items.properties.target_id.enum).toEqual([...obs, ...hyp, null]);
});

test('the answer check refuses malformed ids before anything is stored', () => {
  const ok = analystAnswer('m1', 'm2');
  expect(validateOutput(ok, ANALYST_SCHEMA)).toBeNull();
  for (const bad of ['OBS1', 'o1', 'O-1', '1', `O${ID_LIMIT + 1}`, 'H1']) {
    const a = structuredClone(ok);
    a.observations[0].id = bad;
    expect(validateOutput(a, ANALYST_SCHEMA), bad).toMatch(/observations\[0\]\.id: not an allowed value/);
  }
  const ref = structuredClone(ok);
  ref.hypotheses[0].supporting_observations = ['obs-2'];
  expect(validateOutput(ref, ANALYST_SCHEMA)).toMatch(/supporting_observations\[0\]: not an allowed value/);
  const review = reviewAnswer('UPHOLD_WITH_CONCERNS', 'm1');
  expect(validateOutput(review, REVIEWER_SCHEMA)).toBeNull();
  const badTarget = structuredClone(review);
  (badTarget.challenges[0] as S).target_id = 'Hyp1';
  expect(validateOutput(badTarget, REVIEWER_SCHEMA)).toMatch(/target_id: not an allowed value/);
});

test('both schemas stay inside the structured-output limits, as sent to Anthropic and (strict) to Kimi', () => {
  for (const s of [ANALYST_SCHEMA, REVIEWER_SCHEMA]) {
    expect(schemaProblems(s)).toEqual([]);
    expect(schemaProblems(strictSchema(s as S))).toEqual([]);
  }
  // strict mode keeps the id enums intact (ids are required, so no null is added to them)
  expect((strictSchema(A) as S).properties.observations.items.properties.id.enum).toEqual(A.properties.observations.items.properties.id.enum);
});

test('the prompts state the id rules the grammar cannot enforce (uniqueness, existing references), and the version changed', () => {
  for (const rule of ['O1, O2, O3', 'H1, H2, H3', 'Every id is used exactly once', 'never give two', 'ids of observations in your answer',
    'ids of OTHER', 'never competes with itself', 'Never refer to an id you did not write']) {
    expect(ANALYST_SYSTEM, rule).toContain(rule);
  }
  for (const rule of ['C1, C2, C3', 'each id used once', 'an id that exists in the analysis under review', 'target_id null']) expect(REVIEWER_SYSTEM, rule).toContain(rule);
  expect(PROMPT_VERSION).toBe('rre-6l-analyst-v8.1+reviewer-v7.1');
  expect(PROMPT_VERSION.length).toBeLessThanOrEqual(50);
});

test('merging analyst and review never renames, adds or removes an observation or hypothesis (ids pass through for the contract to judge)', () => {
  const analyst = analystAnswer('m1', 'm2');
  const dup = structuredClone(analyst);
  dup.observations[1].id = 'O1'; // a defective answer: the merge must not hide it by renumbering
  for (const a of [analyst, dup]) {
    const { analysis_status: _s, classification, ...body } = a;
    const { output } = merge({ body, classification, status: 'COMPLETE' } as never, reviewAnswer('UPHOLD_WITH_CONCERNS', 'm1'));
    expect(output.observations).toEqual(a.observations);
    expect(output.hypotheses).toEqual(a.hypotheses);
    expect(output.contract_version).toBe('rre-analysis/2');
  }
});

const flat = (t: string) => t.replace(/\s+/g, ' ');

test('strategic next move: one move from the prospect\'s own words, in the existing fields; no generic check-ins; reviewer checks it', () => {
  for (const rule of ['ONE strategic next move', 'only from what the prospect wrote and did', 'BUYER SIGNAL:', 'NEXT MOVE:', 'WHY THIS MOVE:',
    'One move, never a list of options', 'INSUFFICIENT_EVIDENCE keeps strategy exactly UNKNOWN', 'ask at most ONE',
    'answer it with facts the seller stated', '"Are you still', 'interested?"', 'silence alone', 'For WAIT or STOP_CONTACT', 'I need to talk to my wife',
    'Never invent facts, prices or offers', 'No pressure tactics']) {
    expect(flat(ANALYST_SYSTEM), rule).toContain(flat(rule));
  }
  expect(flat(REVIEWER_SYSTEM)).toContain('is it ONE specific move grounded in the prospect\'s words');
  // the prompts stay small (~4 characters per token; both prompts are sent once each per analysis)
  expect(ANALYST_SYSTEM.length + REVIEWER_SYSTEM.length).toBeLessThan(14_500); // v8: 13,684 (time and prediction rules)
});

test('no unverified operational claims; seller mistakes are observations, the cause of silence stays a hypothesis; verify first', () => {
  for (const rule of ['a draft never asserts availability or stock', '"still here"', 'a price, discount, terms, a delivery or viewing date or time',
    'unless the SELLER stated it in the evidence', 'may have changed, so present it as something to confirm',
    'Do not propose a specific day or time the seller has not', 'VERIFY FIRST: <fact>', 'true either way (no placeholders, no claim)',
    'these are facts about what the', 'WHY the prospect went quiet is a separate, unproven question', 'explanations that do not blame the seller',
    'the cause of the silence is unknown', 'never present one hypothesis as the cause', 'if the answer is not in the evidence, VERIFY FIRST instead of answering',
    'never "The car is still here"', 'only if the seller has them']) {
    expect(flat(ANALYST_SYSTEM), rule).toContain(flat(rule));
  }
  expect(ANALYST_SYSTEM).not.toContain('answer it instead of asking'); // the instruction that invited unverified answers is gone
  for (const rule of ['operational fact the seller did not state in the evidence? That is a HIGH challenge on the RECOMMENDATION',
    'presented as the cause, or with more confidence than the evidence allows']) expect(flat(REVIEWER_SYSTEM), rule).toContain(flat(rule));
});

test('v6: every hypothesis rests on evidence; unsupported possibilities go to unknowns; no forced or invented competitors', () => {
  for (const rule of ['Every hypothesis, each competing one included, lists at least one supporting observation',
    'one observation may support two competing readings', 'Never write an observation just to support a hypothesis',
    'A possibility that no observation supports is not a hypothesis: put it in unknowns',
    'If no evidence-supported competing reading exists, record the interpretation in unknowns',
    'make one a competing hypothesis only where an observation supports it', 'put unsupported ones (bought elsewhere, no longer needs it) in unknowns']) {
    expect(flat(ANALYST_SYSTEM), rule).toContain(flat(rule));
  }
  // the v5 wording that listed evidence-free competitors as if required is gone
  expect(flat(ANALYST_SYSTEM)).not.toContain('with competing hypotheses that do not blame the seller (busy, deciding with someone else, price, bought elsewhere');
  // VERIFY FIRST and the single next move are untouched
  for (const kept of ['VERIFY FIRST: <fact>', 'One move, never a list of options', 'WHY THIS MOVE:']) expect(ANALYST_SYSTEM).toContain(kept);
});

test('v7: a testable decision hypothesis in the existing fields; observed signals, not intentions; silence proves nothing; reviewer must reject on a HIGH recommendation challenge', () => {
  for (const rule of ['what the ORDER of their statements and actions suggests about where they are in deciding',
    'which explanation has the strongest supporting evidence', 'what uncertainty could change the recommendation',
    'the ONE useful action that addresses their concern and would reveal more about their decision',
    'the reply or action you would expect if that explanation is right', 'the reply or action that would challenge it',
    'no probabilities or percentages', 'silence alone shows nothing about intent and never confirms or challenges a hypothesis',
    'the most important OBSERVED signal, quoting the prospect, not an inferred intention',
    'DECISION HYPOTHESIS:', 'IF RIGHT, EXPECT:', 'as a possibility, never a promise', 'WOULD CHALLENGE IT:',
    'The H-id is one you wrote and list in based_on_hypotheses', 'at most four short sentences']) {
    expect(flat(ANALYST_SYSTEM), rule).toContain(flat(rule));
  }
  for (const kept of ['VERIFY FIRST: <fact>', 'One move, never a list of options', 'a draft never asserts availability or stock',
    'Never write an observation just to support a hypothesis', 'ask at most ONE']) expect(flat(ANALYST_SYSTEM), kept).toContain(flat(kept));
  expect(flat(REVIEWER_SYSTEM)).toContain('give the verdict REJECT_RECOMMENDATION, never UPHOLD_WITH_CONCERNS, when you raise one');
});

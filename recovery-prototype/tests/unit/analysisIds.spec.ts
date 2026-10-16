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
  expect(PROMPT_VERSION).toBe('rre-6f-analyst-v3+reviewer-v3');
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

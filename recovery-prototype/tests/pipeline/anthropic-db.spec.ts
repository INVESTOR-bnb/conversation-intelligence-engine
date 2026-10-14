// Stage 2A-6b — the Anthropic adapter (scripted messages client: no network, no key) through the
// pipeline against the REAL local database: the real reservation, reservation terms, dispatch
// record, usage report and settlement. Synthetic data only.
// The two allowlisted models are priced in the LOCAL TEST DATABASE only (staging has no such
// rows: adding them is a separate founder decision); every test restores them.

import { expect, test } from '@playwright/test';
import { PROMPT_VERSION, runAnalysisPipeline, type PipelineConfig } from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { AnthropicProvider, anthropicModelConfig } from '../../supabase/functions/_shared/edge/anthropicProvider.ts';
import { message, ScriptedClient, type Script } from '../unit/fixtures/anthropicMessages';
import { analystAnswer, BODY1, BODY2, MemoryLogger, reviewAnswer } from './fakes';
import { BIZ_A, CLIENT_A, enableTestSpending, makeRoomForCase, one, PsqlFounderDb, PsqlServiceDb, spend, sql } from './psqlDb';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const service = new PsqlServiceDb();
let n = 0;

function priceModels(opus: [number, number] = [4, 20], sonnet: [number, number] = [2, 10]) {
  sql(`insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note)
       values (:'o', :'oi', :'oo', 12000, true, 'LOCAL TEST ONLY'), (:'s', :'si', :'so', 8000, true, 'LOCAL TEST ONLY')
       on conflict (model) do update set input_usd_per_mtok = excluded.input_usd_per_mtok, output_usd_per_mtok = excluded.output_usd_per_mtok,
         max_output_tokens = excluded.max_output_tokens, active = true`,
  { o: OPUS, oi: String(opus[0]), oo: String(opus[1]), s: SONNET, si: String(sonnet[0]), so: String(sonnet[1]) });
}

test.beforeAll(() => { sql('select tests.seed() where not exists (select 1 from public.founders)'); });
test.beforeEach(() => { enableTestSpending(); priceModels(); });
test.afterAll(() => { sql(`update private.ai_model_prices set active = false where model in (:'o', :'s')`, { o: OPUS, s: SONNET }); enableTestSpending(false); });

function textCase() {
  n += 1;
  makeRoomForCase();
  const c = one(`select public.client_create_case(gen_random_uuid(), :'ref', 'Synthetic car', 'Referral', 'TEXT', :'body')`,
    { ref: `AN-${n}`, body: BODY1 }, { role: 'authenticated', sub: CLIENT_A })!;
  sql(`select public.client_submit_case(:'c')`, { c }, { role: 'authenticated', sub: CLIENT_A });
  const m1 = one(`select id from public.case_messages where case_id = :'c' and kind = 'PASTED_CONVERSATION'`, { c })!;
  const m2 = one(`insert into public.case_messages (case_id, business_id, kind, body) values (:'c', :'b', 'PROSPECT_RESPONSE', :'body') returning id`,
    { c, b: BIZ_A, body: BODY2 })!;
  return { c, m1, m2 };
}

function run(caseId: string, create: Record<'ANALYST' | 'REVIEWER', Script>, count?: Record<'ANALYST' | 'REVIEWER', Script>) {
  const client = new ScriptedClient(create, count);
  const config: PipelineConfig = {
    analyst: anthropicModelConfig(OPUS)!, reviewer: anthropicModelConfig(SONNET)!, textOnly: true,
    callTimeoutMs: 1500, deadlineMs: 20000, completionReserveMs: 2000, maxScreenshotBytes: 1024,
  };
  const logger = new MemoryLogger();
  return { client, logger, result: runAnalysisPipeline(caseId, { founderDb: new PsqlFounderDb(new Map()), serviceDb: service, provider: new AnthropicProvider(client, 'medium'), logger, config }) };
}
const ledger = (a: string) => JSON.parse(one(`select row_to_json(l) from private.ai_spend_ledger l where analysis_id = :'a'`, { a })!);
const analysis = (a: string) => JSON.parse(one(`select row_to_json(x) from public.analyses x where id = :'a'`, { a })!);
const good = (m1: string, m2: string) => ({ ANALYST: message(analystAnswer(m1, m2)), REVIEWER: message(reviewAnswer('UPHOLD_WITH_CONCERNS', m1), { model: SONNET }) });

test('success: real reservation and terms; counted input within the bound; usage reported; settled at the real cost', async () => {
  const { c, m1, m2 } = textCase();
  const r = run(c, good(m1, m2));
  const res = await r.result;
  expect(res).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  const l = ledger(res.analysisId!);
  expect(l).toMatchObject({ status: 'SETTLED', settled_by: 'REPORTED_USAGE', analyst_model: OPUS, reviewer_model: SONNET,
    analyst_max_output: 12000, reviewer_max_output: 8000, analyst_input_tokens: 1200, analyst_output_tokens: 900, reviewer_input_tokens: 1200, reviewer_output_tokens: 900 });
  // 1200 x 4 + 900 x 20 + 1200 x 2 + 900 x 10 = 34200 micro-dollars -> 0.0342
  expect(Number(l.actual_usd)).toBe(0.0342);
  expect(Number(l.actual_usd)).toBeLessThan(Number(l.reserved_usd));
  // the request used the database's caps and the counts were of the exact requests
  expect(r.client.creates.map((x) => [x.body.model, x.body.max_tokens])).toEqual([[OPUS, 12000], [SONNET, 8000]]);
  const counted = r.logger.events.filter((e) => e.name === 'spend.input_counted').map((e) => e.fields);
  expect(counted.map((f) => [f?.inputBound, f?.ok])).toEqual([[l.analyst_input_bound, true], [l.reviewer_input_bound, true]]);
  expect(analysis(res.analysisId!)).toMatchObject({ status: 'COMPLETE', model: `analyst:${OPUS}|reviewer:${SONNET}`, prompt_version: PROMPT_VERSION });
});

test('refusal is billed: the refusal usage is reported and settled; the analysis is ERROR', async () => {
  const { c, m1, m2 } = textCase();
  const res = await run(c, { ...good(m1, m2), ANALYST: message('', { stop_reason: 'refusal', content: [] }, { input_tokens: 1000, output_tokens: 5 }) }).result;
  expect(res).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_REFUSED_ANALYST' });
  expect(ledger(res.analysisId!)).toMatchObject({ status: 'SETTLED', settled_by: 'REPORTED_USAGE', analyst_input_tokens: 1000, analyst_output_tokens: 5, reviewer_dispatched_at: null });
  expect(Number(ledger(res.analysisId!).actual_usd)).toBe(0.0041); // 1000 x 4 + 5 x 20 = 4100 micro-dollars
  expect(analysis(res.analysisId!)).toMatchObject({ status: 'ERROR', error: 'PIPELINE_ERROR: PROVIDER_REFUSED_ANALYST' });
});

test('timeout and HTTP error: dispatched, usage unknown -> HELD in the real ledger (never USD 0)', async () => {
  for (const [name, reviewer, code] of [
    ['timeout', 'HANG', 'PROVIDER_TIMEOUT_REVIEWER'],
    ['500', Object.assign(new Error('x'), { name: 'InternalServerError', status: 500 }), 'PROVIDER_ERROR_REVIEWER'],
    ['other model answered', message(reviewAnswer('UPHOLD'), { model: OPUS }), 'PROVIDER_ERROR_REVIEWER'],
  ] as [string, Script, string][]) {
    const { c, m1, m2 } = textCase();
    const res = await run(c, { ...good(m1, m2), REVIEWER: reviewer }).result;
    expect(res, name).toMatchObject({ outcome: 'FAILED', code });
    const l = ledger(res.analysisId!);
    expect(l, name).toMatchObject({ status: 'HELD', settled_by: 'UNKNOWN_USAGE', reviewer_input_tokens: null });
    expect(l.reviewer_dispatched_at, name).not.toBeNull();
    // only the analyst's reported part is known (1200 x 4 + 900 x 20); the whole reservation stays committed
    expect(Number(l.actual_usd), name).toBe(0.0228);
    expect(one(`select private.ai_committed_usd() >= reserved_usd from private.ai_spend_ledger where analysis_id = :'a'`, { a: res.analysisId! }), name).toBe('t');
  }
});

test('input over the reserved bound: nothing dispatched, the real ledger settles at USD 0 (NO_DISPATCH)', async () => {
  const { c, m1, m2 } = textCase();
  const r = run(c, good(m1, m2), { ANALYST: { input_tokens: 9_000_000 }, REVIEWER: { input_tokens: 1 } });
  const res = await r.result;
  expect(res).toMatchObject({ outcome: 'FAILED', code: 'INPUT_EXCEEDS_RESERVATION_ANALYST' });
  expect(r.client.creates).toHaveLength(0);
  expect(ledger(res.analysisId!)).toMatchObject({ status: 'SETTLED', settled_by: 'NO_DISPATCH', analyst_dispatched_at: null });
  expect(Number(ledger(res.analysisId!).actual_usd)).toBe(0);
});

test('a database price different from the verified price: refused before dispatch, USD 0', async () => {
  priceModels([5, 25]);
  const { c, m1, m2 } = textCase();
  const r = run(c, good(m1, m2));
  const res = await r.result;
  expect(res).toMatchObject({ outcome: 'FAILED', code: 'SPEND_TERMS_MISMATCH' });
  expect(r.logger.events.find((e) => e.name === 'spend.terms_mismatch')?.fields?.check).toBe('ANALYST_PRICE');
  expect(r.client.counts.length + r.client.creates.length).toBe(0);
  expect(spend(res.analysisId!)).toBe('SETTLED:NO_DISPATCH:0.0000');
});

test('an unpriced model is refused by the database: no reservation, no request', async () => {
  sql(`update private.ai_model_prices set active = false where model = :'s'`, { s: SONNET });
  const { c, m1, m2 } = textCase();
  const r = run(c, good(m1, m2));
  const res = await r.result;
  expect(res).toMatchObject({ outcome: 'FAILED', code: 'MODEL_NOT_PRICED' });
  expect(spend(res.analysisId!)).toBe('NONE');
  expect(r.client.counts.length + r.client.creates.length).toBe(0);
});

test('spending disabled: refused before any request', async () => {
  enableTestSpending(false);
  const { c, m1, m2 } = textCase();
  const r = run(c, good(m1, m2));
  expect(await r.result).toMatchObject({ outcome: 'FAILED', code: 'SPENDING_DISABLED' });
  expect(r.client.counts.length + r.client.creates.length).toBe(0);
});

test('a business user cannot read the analysis, its spending or its terms', async () => {
  const { c, m1, m2 } = textCase();
  const res = await run(c, good(m1, m2)).result;
  const a = res.analysisId!;
  expect(one(`select count(*) from public.analyses where id = :'a'`, { a }, { role: 'authenticated', sub: CLIENT_A })).toBe('0');
  for (const q of [`select public.internal_ai_reservation_terms(:'a')`, `select public.founder_ai_spend_summary()`]) {
    expect(() => sql(q, { a }, { role: 'authenticated', sub: CLIENT_A }), q).toThrow(/permission denied|FORBIDDEN/);
  }
});

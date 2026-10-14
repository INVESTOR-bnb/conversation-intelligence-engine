// Stage 2A-6b — the Anthropic adapter with a SCRIPTED messages client (no network, no key),
// and the pipeline's new pre-dispatch guards (reservation terms, input counting, schema).
// Synthetic data only. The real SDK against a local mock server: anthropicSdk.spec.ts.

import { expect, test } from '@playwright/test';
import {
  ANALYST_SCHEMA, parseAnalyst, ProviderCallError, REVIEWER_SCHEMA, runAnalysisPipeline, termsProblem, type PipelineConfig, type ProviderRequest,
  type ReservationTerms, type SpendReservation,
} from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { schemaProblems, validateOutput } from '../../supabase/functions/_shared/analysis-pipeline/structuredOutput.ts';
import {
  ANTHROPIC_MODELS, AnthropicProvider, anthropicModelConfig, classifyError, countBody, messagesBody, parseMessage,
} from '../../supabase/functions/_shared/edge/anthropicProvider.ts';
import { fakeAnalystAnswer, fakeReviewAnswer } from '../../supabase/functions/_shared/edge/fakeProvider.ts';
import { analystAnswer, CASE, FakeDb, manifest, MemoryLogger, reviewAnswer } from '../pipeline/fakes';
import { message, ScriptedClient, type Script } from './fixtures/anthropicMessages';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

const httpError = (status: number) => Object.assign(new Error(`${status} SYNTHETIC upstream text with evidence`), { name: 'InternalServerError', status, requestID: 'req_err01' });

/** The pipeline run with the real adapter over a scripted client, against the ledger-mirroring FakeDb. */
async function setup(create: Record<'ANALYST' | 'REVIEWER', Script>, opts: { count?: Record<'ANALYST' | 'REVIEWER', Script>; shots?: boolean; config?: Partial<PipelineConfig> } = {}) {
  const db = new FakeDb(await manifest(opts.shots ? {} : { screenshots: [] }));
  db.approved = { ANALYST: { model: OPUS, maxOutputTokens: 16000 }, REVIEWER: { model: SONNET, maxOutputTokens: 8000 } };
  db.prices = { ANALYST: [4, 20], REVIEWER: [2, 10] };
  db.inputBound = { ANALYST: 9000, REVIEWER: 30000 };
  // worst case: 9000x4 + 16000x20 + 30000x2 + 8000x10 = 36000 + 320000 + 60000 + 80000 = 496000 -> USD 0.4960
  db.reservedUsd = 0.496;
  const client = new ScriptedClient(create, opts.count);
  const provider = new AnthropicProvider(client, 'medium');
  const logger = new MemoryLogger();
  const config: PipelineConfig = {
    analyst: anthropicModelConfig(OPUS)!, reviewer: anthropicModelConfig(SONNET)!, textOnly: true,
    callTimeoutMs: 300, deadlineMs: 5000, completionReserveMs: 500, maxScreenshotBytes: 1024, ...opts.config,
  };
  const run = () => runAnalysisPipeline(CASE, { founderDb: db, serviceDb: db, provider, logger, config });
  return { db, client, logger, run };
}
const GOOD = { ANALYST: message(analystAnswer()), REVIEWER: message(reviewAnswer('UPHOLD_WITH_CONCERNS'), { model: SONNET }) };

// ---------------------------------------------------------------- the allowlist and the request

test('the model allowlist is exactly the two verified models, with their documented prices and output maximum; frozen', () => {
  expect(ANTHROPIC_MODELS).toEqual({
    'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, maxOutputTokens: 128000 },
    'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, maxOutputTokens: 128000 },
  });
  expect(Object.isFrozen(ANTHROPIC_MODELS) && Object.isFrozen(ANTHROPIC_MODELS[OPUS])).toBe(true);
  for (const m of ['claude-opus-4-8', 'claude-haiku-5-5', 'FAKE-PROVIDER-NOT-AI', 'toString', '__proto__', '']) expect(anthropicModelConfig(m), m).toBeNull();
});

test('request: approved model, DB-approved max_tokens, structured output, effort; no retries, fallback, tools, thinking, caching or streaming', async () => {
  const { client, run } = await setup(GOOD);
  expect(await run()).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  expect(client.creates).toHaveLength(2);
  const [a, r] = client.creates;
  expect(Object.keys(a.body).sort()).toEqual(['inference_geo', 'max_tokens', 'messages', 'model', 'output_config', 'service_tier', 'system']);
  expect(a.body).toMatchObject({ model: OPUS, max_tokens: 16000, service_tier: 'standard_only', inference_geo: 'global',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: ANALYST_SCHEMA } } });
  expect(r.body).toMatchObject({ model: SONNET, max_tokens: 8000, output_config: { effort: 'medium', format: { type: 'json_schema', schema: REVIEWER_SCHEMA } } });
  const msgs = a.body.messages as { role: string; content: { type: string }[] }[];
  expect(msgs).toHaveLength(1);
  expect(msgs[0].role).toBe('user');
  expect(msgs[0].content.every((b) => b.type === 'text')).toBe(true);
  const wire = JSON.stringify(client.creates.map((c) => c.body));
  expect(wire).not.toMatch(/"(thinking|fallbacks?|tools|tool_choice|cache_control|stream|betas|temperature|top_p|top_k|metadata|speed|container)"\s*:/);
  for (const c of [...client.creates, ...client.counts]) {
    expect(c.options.maxRetries).toBe(0);
    expect(c.options.signal).toBeInstanceOf(AbortSignal);
  }
  // the count is of the exact same input: same model, system, messages and output_config; nothing billed-only
  expect(client.counts.map((c) => Object.keys(c.body).sort())).toEqual([['messages', 'model', 'output_config', 'system'], ['messages', 'model', 'output_config', 'system']]);
  expect(client.counts[0].body).toEqual({ model: a.body.model, system: a.body.system, messages: a.body.messages, output_config: a.body.output_config });
  expect(client.counts[1].body).toEqual({ model: r.body.model, system: r.body.system, messages: r.body.messages, output_config: r.body.output_config });
  expect(countBody({ role: 'ANALYST', model: OPUS, system: 's', content: [], schema: {}, maxOutputTokens: 5 }, 'high'))
    .toEqual({ model: OPUS, system: 's', messages: [{ role: 'user', content: [] }], output_config: { effort: 'high', format: { type: 'json_schema', schema: {} } } });
});

test('request: images map to base64 image blocks (only if a caller ever allows them)', () => {
  const b = messagesBody({ role: 'ANALYST', model: OPUS, system: 's', schema: {}, maxOutputTokens: 10,
    content: [{ type: 'text', text: 't' }, { type: 'image', mimeType: 'image/png', base64: 'AAAA' }] }, 'low');
  expect((b.messages as { content: unknown[] }[])[0].content).toEqual([{ type: 'text', text: 't' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
});

test('the adapter refuses a client that may retry, an unknown effort, a model off the allowlist and a cap above the model maximum', async () => {
  const c = new ScriptedClient(GOOD);
  c.maxRetries = 2;
  expect(() => new AnthropicProvider(c, 'medium')).toThrow(/maxRetries 0/);
  expect(() => new AnthropicProvider(new ScriptedClient(GOOD), 'max' as never)).toThrow(/effort/);
  const p = new AnthropicProvider(new ScriptedClient(GOOD), 'high');
  const req = (model: string, maxOutputTokens: number): ProviderRequest => ({ role: 'ANALYST', model, system: 's', content: [], schema: {}, maxOutputTokens, signal: new AbortController().signal });
  await expect(p.call(req('claude-opus-4-8', 100))).rejects.toBeInstanceOf(ProviderCallError);
  await expect(p.call(req(OPUS, 128001))).rejects.toBeInstanceOf(ProviderCallError);
  await expect(p.countInputTokens(req(OPUS, 0))).rejects.toBeInstanceOf(ProviderCallError);
});

// ---------------------------------------------------------------- the response and usage

test('response: text blocks only (thinking ignored); usage from the response; request id kept', () => {
  const r = parseMessage(message({ a: 1 }), OPUS);
  expect(r).toEqual({ text: '{"a":1}', stopReason: 'end_turn', inputTokens: 1200, outputTokens: 900, requestId: 'req_synthetic01' });
  expect(parseMessage(message('x', { stop_reason: 'refusal', content: [] }), OPUS)).toMatchObject({ text: '', stopReason: 'refusal' });
});

test('usage is conservative: a cache write counts double, a cache read at the full price; absent cache fields count 0', () => {
  expect(parseMessage(message('{}', {}, { cache_creation_input_tokens: 100, cache_read_input_tokens: 50 }), OPUS).inputTokens).toBe(1200 + 200 + 50);
  expect(parseMessage(message('{}', {}, { cache_creation_input_tokens: undefined, cache_read_input_tokens: null }), OPUS).inputTokens).toBe(1200);
});

test('a response whose bill cannot be trusted is refused (usage unknown -> HELD): model, tier, geography, server tools, malformed usage', () => {
  const kind = (raw: unknown) => { try { parseMessage(raw, OPUS); return 'parsed'; } catch (e) { return (e as ProviderCallError).kind; } };
  expect(kind(message('{}', { model: SONNET }))).toBe('MODEL_MISMATCH');
  expect(kind(message('{}', { model: 'claude-opus-5-5-fallback' }))).toBe('MODEL_MISMATCH');
  expect(kind(message('{}', {}, { service_tier: 'priority' }))).toBe('PRICING_MISMATCH');
  expect(kind(message('{}', {}, { inference_geo: 'us' }))).toBe('PRICING_MISMATCH');
  expect(kind(message('{}', {}, { server_tool_use: { web_search_requests: 1 } }))).toBe('PRICING_MISMATCH');
  expect(kind(message('{}', {}, { inference_geo: 'not_available', service_tier: null, server_tool_use: { web_search_requests: 0 } }))).toBe('parsed');
  for (const u of [{ input_tokens: undefined }, { output_tokens: '900' }, { input_tokens: -1 }, { output_tokens: 1.5 }, { cache_read_input_tokens: -3 }]) {
    expect(kind(message('{}', {}, u)), JSON.stringify(u)).toBe('MALFORMED_RESPONSE');
  }
  expect(kind({ ...message('{}'), usage: undefined })).toBe('MALFORMED_RESPONSE');
  expect(kind({ type: 'error', error: { type: 'overloaded_error' } })).toBe('MALFORMED_RESPONSE');
  expect(kind(null)).toBe('MALFORMED_RESPONSE');
});

test('SDK errors become fixed kinds; their text (which may echo content) is dropped', () => {
  const c = (e: unknown, aborted = false) => {
    const ac = new AbortController(); if (aborted) ac.abort();
    const x = classifyError(e, ac.signal);
    return [x.kind, x.httpStatus, x.requestId, x.message.includes('SYNTHETIC')];
  };
  expect(c(httpError(500))).toEqual(['HTTP', 500, 'req_err01', false]);
  expect(c(Object.assign(new Error('rate limited SYNTHETIC'), { name: 'RateLimitError', status: 429, requestID: 'bad id with spaces' }))).toEqual(['HTTP', 429, null, false]);
  expect(c(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' }))).toEqual(['TIMEOUT', null, null, false]);
  expect(c(Object.assign(new Error('x'), { name: 'APIConnectionError' }))).toEqual(['CONNECTION', null, null, false]);
  expect(c(Object.assign(new Error('x'), { name: 'APIUserAbortError' }))).toEqual(['ABORTED', null, null, false]);
  expect(c(new Error('anything SYNTHETIC'), true)).toEqual(['ABORTED', null, null, false]);
  expect(c('weird')).toEqual(['OTHER', null, null, false]);
});

// ---------------------------------------------------------------- end to end through the pipeline (scripted provider, ledger-mirroring db)

test('success: count -> dispatch -> request -> usage per call; usage reported; settled from reported usage', async () => {
  const { db, client, logger, run } = await setup(GOOD);
  expect(await run()).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  expect(db.calls.filter((x) => /^(reserve|terms|dispatch|usage|complete)/.test(x))).toEqual([
    `reserve:${OPUS}:${SONNET}`, 'terms', 'dispatch:ANALYST', 'usage:ANALYST:1200:900', 'dispatch:REVIEWER', 'usage:REVIEWER:1200:900', 'complete:COMPLETE']);
  expect(client.counts).toHaveLength(2);
  expect(db.spend()).toBe('SETTLED:REPORTED_USAGE');
  expect(db.completions[0]).toMatchObject({ model: `analyst:${OPUS}|reviewer:${SONNET}`, inputTokens: 2400, outputTokens: 1800,
    estimatedCostUsd: Math.round(((1200 * 4 + 900 * 20) + (1200 * 2 + 900 * 10)) / 1e6 * 10000) / 10000 });
  const calls = logger.events.filter((e) => e.name === 'provider.call').map((e) => e.fields);
  expect(calls.map((f) => [f?.role, f?.ok, f?.requestId])).toEqual([['ANALYST', true, 'req_synthetic01'], ['REVIEWER', true, 'req_synthetic01']]);
  expect(logger.events.filter((e) => e.name === 'spend.input_counted').map((e) => [e.fields?.inputTokens, e.fields?.inputBound, e.fields?.ok]))
    .toEqual([[1500, 9000, true], [2500, 30000, true]]);
});

test('refusal (HTTP 200, billed): usage reported, no output stored, PROVIDER_REFUSED', async () => {
  const refusal = message('', { stop_reason: 'refusal', content: [] }, { input_tokens: 1100, output_tokens: 3 });
  const { db, client, run } = await setup({ ...GOOD, ANALYST: refusal });
  expect(await run()).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_REFUSED_ANALYST' });
  expect(client.creates).toHaveLength(1);
  expect(db.calls).toContain('usage:ANALYST:1100:3');
  expect(db.spend()).toBe('SETTLED:REPORTED_USAGE');
  expect(db.completions[0]).toMatchObject({ status: 'ERROR', output: null, error: 'PIPELINE_ERROR: PROVIDER_REFUSED_ANALYST' });
});

test('timeout: the request is aborted, nothing is reported, the reservation is HELD (never USD 0); exactly one request', async () => {
  const { db, client, logger, run } = await setup({ ...GOOD, REVIEWER: 'HANG' });
  expect(await run()).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_TIMEOUT_REVIEWER' });
  expect(client.creates).toHaveLength(2);
  expect(client.creates[1].options.signal.aborted).toBe(true);
  expect(db.calls.filter((x) => x.startsWith('usage:'))).toEqual(['usage:ANALYST:1200:900']);
  expect(db.spend()).toBe('HELD:UNKNOWN_USAGE');
  expect(logger.events.find((e) => e.name === 'provider.call' && e.fields?.ok === false)?.fields).toMatchObject({ usageKnown: false, errorKind: 'TIMEOUT' });
});

test('HTTP errors (500, 429, 529, 400): one request, no retry, no fallback model, usage unknown -> HELD', async () => {
  for (const status of [500, 429, 529, 400]) {
    const { db, client, logger, run } = await setup({ ...GOOD, ANALYST: httpError(status) });
    expect(await run(), String(status)).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_ERROR_ANALYST' });
    expect(client.creates.map((c) => c.body.model), String(status)).toEqual([OPUS]);
    expect(db.spend(), String(status)).toBe('HELD:UNKNOWN_USAGE');
    const f = logger.events.find((e) => e.name === 'provider.call')?.fields;
    expect(f, String(status)).toMatchObject({ ok: false, usageKnown: false, errorKind: 'HTTP', httpStatus: status, requestId: 'req_err01' });
    expect(JSON.stringify(logger.events)).not.toContain('SYNTHETIC upstream');
  }
});

test('uncertain usage: a different model, a non-standard tier or missing usage in the answer -> HELD, never reported', async () => {
  for (const [name, raw] of [
    ['other model', message(analystAnswer(), { model: SONNET })],
    ['priority tier', message(analystAnswer(), {}, { service_tier: 'priority' })],
    ['US-only inference', message(analystAnswer(), {}, { inference_geo: 'us' })],
    ['no usage', { ...message(analystAnswer()), usage: null }],
    ['not a message', { type: 'error' }],
  ] as [string, unknown][]) {
    const { db, run } = await setup({ ...GOOD, ANALYST: raw });
    expect(await run(), name).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_ERROR_ANALYST' });
    expect(db.calls.some((x) => x.startsWith('usage:')), name).toBe(false);
    expect(db.spend(), name).toBe('HELD:UNKNOWN_USAGE');
  }
});

test('malformed output: prose, broken JSON, outside the schema, max_tokens — usage still reported (billed), nothing stored', async () => {
  for (const [name, raw, code] of [
    ['prose', message('Here is the analysis you asked for.'), 'INVALID_JSON_ANALYST'],
    ['broken JSON', message('{"analysis_status": "COMPLETE", '), 'INVALID_JSON_ANALYST'],
    ['outside the schema', message({ ...analystAnswer(), secret_note: 'x' }), 'SCHEMA_INVALID_ANALYST'],
    ['wrong enum', message(analystAnswer(undefined, undefined, { classification: 'PURPLE' })), 'SCHEMA_INVALID_ANALYST'],
    ['cut off', message('{"analysis_status": "COMP', { stop_reason: 'max_tokens' }, { output_tokens: 16000 }), 'PROVIDER_INCOMPLETE_ANALYST'],
  ] as [string, unknown, string][]) {
    const { db, run } = await setup({ ...GOOD, ANALYST: raw });
    expect(await run(), name).toMatchObject({ outcome: 'FAILED', code });
    expect(db.calls.filter((x) => x.startsWith('usage:ANALYST')), name).toHaveLength(1);
    expect(db.spend(), name).toBe('SETTLED:REPORTED_USAGE');
    expect(db.completions[0].output, name).toBeNull();
  }
});

test('token limits: more output than the cap, or more input than the reserved bound, is reported in full and fails the run', async () => {
  let s = await setup({ ...GOOD, ANALYST: message(analystAnswer(), {}, { output_tokens: 16001 }) });
  expect(await s.run()).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_LIMIT_EXCEEDED_ANALYST' });
  expect(s.db.calls).toContain('usage:ANALYST:1200:16001');
  s = await setup({ ...GOOD, ANALYST: message(analystAnswer(), {}, { input_tokens: 9001 }) });
  expect(await s.run()).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_INPUT_EXCEEDED_ANALYST' });
  expect(s.db.calls).toContain('usage:ANALYST:9001:900');
  expect(s.db.spend()).toBe('SETTLED:REPORTED_USAGE');
});

test('input above the reserved bound (with the 10% margin) is never sent: no dispatch record, USD 0', async () => {
  for (const [name, count, code, creates] of [
    ['analyst over', { ANALYST: { input_tokens: 8182 }, REVIEWER: { input_tokens: 1 } }, 'INPUT_EXCEEDS_RESERVATION_ANALYST', 0], // ceil(8182 x 1.1) = 9001
    ['reviewer over', { ANALYST: { input_tokens: 8181 }, REVIEWER: { input_tokens: 27273 } }, 'INPUT_EXCEEDS_RESERVATION_REVIEWER', 1], // 8181 x 1.1 = 8999.1 ok
  ] as [string, Record<'ANALYST' | 'REVIEWER', Script>, string, number][]) {
    const { db, client, run } = await setup(GOOD, { count });
    expect(await run(), name).toMatchObject({ outcome: 'FAILED', code });
    expect(client.creates, name).toHaveLength(creates);
    expect(db.calls.filter((x) => x.startsWith('dispatch:')), name).toHaveLength(creates);
    expect(db.spend(), name).toBe(creates === 0 ? 'SETTLED:NO_DISPATCH' : 'SETTLED:REPORTED_USAGE');
  }
});

test('a call that cannot be counted is not sent: count error, malformed count, hung count', async () => {
  for (const [name, count] of [
    ['error', httpError(429)], ['malformed', { tokens: 5 }], ['negative', { input_tokens: -1 }], ['hung', 'HANG'],
  ] as [string, Script][]) {
    const { db, client, run } = await setup(GOOD, { count: { ANALYST: count, REVIEWER: { input_tokens: 1 } }, config: { deadlineMs: 2000 } });
    expect(await run(), name).toMatchObject({ outcome: 'FAILED', code: 'TOKEN_COUNT_FAILED_ANALYST' });
    expect(client.creates, name).toHaveLength(0);
    expect(db.calls.some((x) => x.startsWith('dispatch:')), name).toBe(false);
    expect(db.spend(), name).toBe('SETTLED:NO_DISPATCH');
  }
});

test('reservation terms that do not match this run refuse it before any dispatch (USD 0)', async () => {
  for (const [name, edit, check] of [
    ['analyst price differs', (db: FakeDb) => { db.prices.ANALYST = [3, 15]; }, 'ANALYST_PRICE'],
    ['reviewer output price differs', (db: FakeDb) => { db.prices.REVIEWER = [2, 12]; }, 'REVIEWER_PRICE'],
    ['free price for a paid model', (db: FakeDb) => { db.prices.ANALYST = [0, 0]; }, 'ANALYST_PRICE'],
    ['cap differs from the reservation', (db: FakeDb) => { db.termsOver.ANALYST = { maxOutputTokens: 15999 }; }, 'ANALYST_OUTPUT_CAP'],
    ['cap above the model maximum', (db: FakeDb) => { db.approved.REVIEWER.maxOutputTokens = 128001; db.reservedUsd = 2; }, 'REVIEWER_CAP_ABOVE_MODEL_MAXIMUM'],
    ['model differs', (db: FakeDb) => { db.termsOver.REVIEWER = { model: OPUS }; }, 'REVIEWER_MODEL'],
    ['not covered by the reserved amount', (db: FakeDb) => { db.reservedUsd = 0.4959; }, 'NOT_COVERED'],
    ['no input bound', (db: FakeDb) => { db.inputBound.ANALYST = 0; }, 'ANALYST_INPUT_BOUND'],
  ] as [string, (db: FakeDb) => void, string][]) {
    const { db, client, logger, run } = await setup(GOOD);
    edit(db);
    expect(await run(), name).toMatchObject({ outcome: 'FAILED', code: 'SPEND_TERMS_MISMATCH' });
    expect(logger.events.find((e) => e.name === 'spend.terms_mismatch')?.fields?.check, name).toBe(check);
    expect(client.counts.length + client.creates.length, name).toBe(0);
    expect(db.spend(), name).toBe('SETTLED:NO_DISPATCH');
  }
  const { db, client, run } = await setup(GOOD);
  db.termsError = new Error('network down');
  expect(await run()).toMatchObject({ outcome: 'FAILED', code: 'SPEND_TERMS_UNAVAILABLE' });
  expect(client.creates).toHaveLength(0);
  expect(db.spend()).toBe('SETTLED:NO_DISPATCH');
});

test('termsProblem: status, analysis id and reserved amount must match; prices exactly', () => {
  const r: SpendReservation = { reservedUsd: 0.2204, analyst: { model: 'a', maxOutputTokens: 1000 }, reviewer: { model: 'b', maxOutputTokens: 2000 } };
  const t: ReservationTerms = { analysisId: 'x', status: 'RESERVED', reservedUsd: 0.2204,
    analyst: { model: 'a', maxOutputTokens: 1000, inputBound: 8664, inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
    reviewer: { model: 'b', maxOutputTokens: 2000, inputBound: 10664, inputUsdPerMTok: 10, outputUsdPerMTok: 50 } };
  const cfg = { analyst: { model: 'a', inputPerMTok: 1, outputPerMTok: 5 }, reviewer: { model: 'b', inputPerMTok: 10, outputPerMTok: 50 } };
  expect(termsProblem(t, 'x', r, cfg)).toBeNull(); // the 2A-6a test reservation: exactly covered
  expect(termsProblem({ ...t, status: 'HELD' }, 'x', r, cfg)).toBe('STATUS');
  expect(termsProblem(t, 'y', r, cfg)).toBe('ANALYSIS');
  expect(termsProblem({ ...t, reservedUsd: 0.2203 }, 'x', { ...r, reservedUsd: 0.2203 }, cfg)).toBe('NOT_COVERED');
  expect(termsProblem(t, 'x', { ...r, reservedUsd: 0.3 }, cfg)).toBe('RESERVED_USD');
  expect(termsProblem({ ...t, analyst: { ...t.analyst, inputUsdPerMTok: 1.000001 } }, 'x', r, cfg)).toBe('ANALYST_PRICE');
  expect(termsProblem({ ...t, analyst: { ...t.analyst, inputUsdPerMTok: Number.NaN } }, 'x', r, cfg)).toBe('ANALYST_PRICE_INVALID');
  expect(termsProblem(null, 'x', r, cfg)).toBe('MISSING');
});

test('paid provider is text only: a case with screenshots is refused before any reservation', async () => {
  const { db, client, run } = await setup(GOOD, { shots: true });
  expect(await run()).toMatchObject({ outcome: 'FAILED', code: 'PAID_PROVIDER_TEXT_ONLY' });
  expect(db.calls.some((x) => x.startsWith('reserve'))).toBe(false);
  expect(client.counts.length + client.creates.length).toBe(0);
  expect(db.spend()).toBe('NONE');
});

test('an adversarial reviewer verdict still removes the recommendation (Anthropic path)', async () => {
  const { db, run } = await setup({ ...GOOD, REVIEWER: message(reviewAnswer('REJECT_RECOMMENDATION'), { model: SONNET }) });
  expect(await run()).toMatchObject({ outcome: 'COMPLETED', code: 'RECOMMENDATION_REJECTED_BY_REVIEW' });
  expect(db.completions[0]).toMatchObject({ proposedMessage: null, classification: null });
});

test('the logs carry no evidence, output, provider text or key', async () => {
  const { logger, run } = await setup({ ...GOOD, REVIEWER: httpError(500) });
  await run();
  const all = JSON.stringify(logger.events);
  expect(all).not.toMatch(/Prospect:|SYNTHETIC|Saturday|price feels high|sk-ant/);
});

// ---------------------------------------------------------------- the schemas

test('both schemas are inside the documented structured-output limits', () => {
  expect(schemaProblems(ANALYST_SCHEMA)).toEqual([]);
  expect(schemaProblems(REVIEWER_SCHEMA)).toEqual([]);
});

test('schemaProblems catches what the provider would reject', () => {
  const o = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties), ...extra });
  expect(schemaProblems(o({ a: { type: 'string', minLength: 1 } }))).toEqual(['$.a: unsupported keyword minLength']);
  expect(schemaProblems(o({ a: { type: 'integer', minimum: 0 } }))).toEqual(['$.a: unsupported keyword minimum']);
  expect(schemaProblems({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toEqual(['$: additionalProperties must be false']);
  expect(schemaProblems(o({ a: { $ref: '#' } }))).toContain('$.a: unsupported keyword $ref');
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: 'string' }]));
  expect(schemaProblems(o(many, { required: [] }))).toEqual(['$: 25 optional properties (limit 24)']);
  const unions = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`u${i}`, { type: ['string', 'null'] }]));
  expect(schemaProblems(o(unions))).toEqual(['$: 17 union-typed parameters (limit 16)']);
  expect(schemaProblems(o({ a: { type: 'array', items: { type: 'string' }, minItems: 2 } }))).toEqual(['$.a: unsupported keyword minItems']);
});

test('validateOutput accepts every known-good answer and rejects the rest with a path only', () => {
  for (const v of [analystAnswer(), fakeAnalystAnswer()]) expect(validateOutput(v, ANALYST_SCHEMA)).toBeNull();
  for (const v of [reviewAnswer('UPHOLD'), reviewAnswer('UPHOLD_WITH_CONCERNS'), reviewAnswer('REJECT_RECOMMENDATION'), fakeReviewAnswer()]) {
    expect(validateOutput(v, REVIEWER_SCHEMA)).toBeNull();
  }
  expect(validateOutput({ ...reviewAnswer('UPHOLD'), verdict: 'MAYBE SECRET-TEXT' }, REVIEWER_SCHEMA)).toBe('$.verdict: not an allowed value');
  expect(validateOutput(analystAnswer(undefined, undefined, { observations: [{ id: 'O1', actor: 'PROSPECT', behavior: 'x', evidence: [{ type: 'MESSAGE', quote: 1 }] }] }), ANALYST_SCHEMA))
    .toBe('$.observations[0].evidence[0].quote: wrong type');
  // the existing parser still guards what the schema allows but the merge needs
  expect(() => parseAnalyst({ ...analystAnswer(), recommendation: null })).toThrow();
});

test('a priced call from a provider that cannot count its input is never sent (TOKEN_COUNT_UNAVAILABLE)', async () => {
  const { db, client } = await setup(GOOD);
  const inner = new AnthropicProvider(client, 'medium');
  const noCount = { maxRetries: 0 as const, call: (r: ProviderRequest) => inner.call(r) };
  const config: PipelineConfig = { analyst: anthropicModelConfig('claude-opus-5-5')!, reviewer: anthropicModelConfig('claude-sonnet-5-5')!, textOnly: true,
    callTimeoutMs: 300, deadlineMs: 5000, completionReserveMs: 500, maxScreenshotBytes: 1024 };
  const r = await runAnalysisPipeline(CASE, { founderDb: db, serviceDb: db, provider: noCount, logger: new MemoryLogger(), config });
  expect(r).toMatchObject({ outcome: 'FAILED', code: 'TOKEN_COUNT_UNAVAILABLE_ANALYST' });
  expect(client.creates).toHaveLength(0);
  expect(db.spend()).toBe('SETTLED:NO_DISPATCH');
});

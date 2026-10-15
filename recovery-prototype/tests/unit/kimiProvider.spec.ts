// Kimi adapter — OFFLINE tests. A local mock of the two Moonshot endpoints (real fetch, 127.0.0.1
// only), the real pipeline over the ledger-mirroring FakeDb, configuration and the source guard.
// No request leaves the machine; the key is a synthetic string; all conversations are synthetic.
// Prices: kimi-k3's configured 3 / 15 per million (Stage 2A-6e); no real request is ever made.

import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import {
  ANALYST_SCHEMA, DbError, REVIEWER_SCHEMA, runAnalysisPipeline, schemaProblems, validateOutput, type ModelConfig, type PipelineConfig, type ProviderRequest,
} from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { readConfig, STAGING_URL } from '../../supabase/functions/_shared/edge/config.ts';
import { createAnalyzeCaseHandler } from '../../supabase/functions/_shared/edge/handler.ts';
import {
  chatBody, estimateBody, KIMI_MODEL, KIMI_MODELS, KimiProvider, kimiModelConfig, parseCompletion, strictSchema, stripOptionalNulls,
} from '../../supabase/functions/_shared/edge/kimiProvider.ts';
import { readFileSync } from 'node:fs';
import { readTree, sourceProblems } from '../../supabase/scripts/function-source-guard.mjs';
import { analystAnswer, CASE, FakeDb, manifest, MemoryLogger, reviewAnswer } from '../pipeline/fakes';

const KEY = 'sk-TESTONLY0synthetic0not0a0real0key000000';
const REASONING = 'SYNTHETIC-REASONING-CONTENT-must-never-leave-the-adapter';
const MODEL: ModelConfig = kimiModelConfig(KIMI_MODEL)!;

/** A chat-completions response as the adapter expects it (reasoning_content included, to prove it is ignored). */
function completion(value: unknown, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}, choice: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-synthetic01', object: 'chat.completion', created: 1, model: KIMI_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value), reasoning_content: REASONING },
      finish_reason: 'stop', ...choice }],
    usage: { prompt_tokens: 1200, completion_tokens: 900, total_tokens: 2100, ...usage },
    ...over,
  };
}

// ---------------------------------------------------------------- the local mock of the Moonshot API
type Reply = { status: number; body?: unknown; raw?: string } | 'HANG';
interface Seen { method: string; path: string; auth: string | undefined; type: string | undefined; body: Record<string, unknown> }
let server: Server;
let base = '';
let seen: Seen[] = [];
let script: { chat: Record<'ANALYST' | 'REVIEWER', Reply[]>; count: Reply[] };
const hung: { destroy: () => void }[] = [];
const roleOf = (b: Record<string, unknown>) => ((b.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name === 'rre_reviewer' ? 'REVIEWER' : 'ANALYST');

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      const path = (req.url ?? '').split('?')[0];
      seen.push({ method: req.method ?? '', path, auth: req.headers.authorization, type: req.headers['content-type'], body });
      const r = path === '/v1/chat/completions' ? script.chat[roleOf(body)].shift()
        : path === '/v1/tokenizers/estimate-token-count' ? script.count.shift() : { status: 404, body: { error: { message: 'no route' } } };
      if (r === 'HANG') { hung.push(res); return; }
      const reply = r ?? { status: 500, body: { error: { message: 'unscripted' } } };
      res.writeHead(reply.status, { 'content-type': 'application/json', 'x-request-id': 'req-kimi-mock01' });
      res.end(reply.raw ?? JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { for (const h of hung) h.destroy(); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });

const GOOD_ANALYST = (m1?: string, m2?: string) => completion(analystAnswer(m1, m2));
const GOOD_REVIEW = () => completion(reviewAnswer('UPHOLD_WITH_CONCERNS'));
function reset(chat: Partial<Record<'ANALYST' | 'REVIEWER', Reply[]>> = {}, count: Reply[] = [{ status: 200, body: { data: { total_tokens: 1500 } } }, { status: 200, body: { data: { total_tokens: 2500 } } }]) {
  seen = [];
  script = { chat: { ANALYST: chat.ANALYST ?? [{ status: 200, body: GOOD_ANALYST() }], REVIEWER: chat.REVIEWER ?? [{ status: 200, body: GOOD_REVIEW() }] }, count };
}
const provider = () => new KimiProvider({ apiKey: KEY, fetch: (i, init) => fetch(i, init), baseUrl: base });

/** The pipeline over FakeDb with the Kimi adapter (both stages through the same adapter instance). */
async function setup(opts: { shots?: boolean; config?: Partial<PipelineConfig> } = {}) {
  const db = new FakeDb(await manifest(opts.shots ? {} : { screenshots: [] }));
  db.approved = { ANALYST: { model: KIMI_MODEL, maxOutputTokens: 8000 }, REVIEWER: { model: KIMI_MODEL, maxOutputTokens: 8000 } };
  db.prices = { ANALYST: [3, 15], REVIEWER: [3, 15] };
  db.inputBound = { ANALYST: 9000, REVIEWER: 30000 };
  db.reservedUsd = 0.357; // 9000x3 + 8000x15 + 30000x3 + 8000x15 = 357,000 micro-dollars
  const logger = new MemoryLogger();
  const p = provider();
  const run = () => runAnalysisPipeline(CASE, { founderDb: db, serviceDb: db, provider: p, logger,
    config: { analyst: MODEL, reviewer: MODEL, textOnly: true, callTimeoutMs: 1500, deadlineMs: 8000, completionReserveMs: 500, maxScreenshotBytes: 1024, ...opts.config } });
  return { db, logger, run };
}
const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({ role: 'ANALYST', model: KIMI_MODEL, system: 'SYNTHETIC system', content: [{ type: 'text', text: 'SYNTHETIC evidence' }],
  schema: ANALYST_SCHEMA, maxOutputTokens: 8000, signal: new AbortController().signal, ...over });
const chats = () => seen.filter((s) => s.path === '/v1/chat/completions');
const counts = () => seen.filter((s) => s.path === '/v1/tokenizers/estimate-token-count');

// ---------------------------------------------------------------- 1. endpoint, authentication, request shape

test('1. the two official endpoints, Bearer authentication, the exact bounded request; nothing else sent', async () => {
  reset();
  const { run } = await setup();
  expect(await run()).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    'POST /v1/tokenizers/estimate-token-count', 'POST /v1/chat/completions', 'POST /v1/tokenizers/estimate-token-count', 'POST /v1/chat/completions']);
  for (const s of seen) expect([s.auth, s.type]).toEqual([`Bearer ${KEY}`, 'application/json']);
  const [a, r] = chats().map((s) => s.body);
  // the exact outgoing JSON of BOTH calls: the explicit completion cap, never the deprecated max_tokens
  for (const [body, name, schema] of [[a, 'rre_analyst', ANALYST_SCHEMA], [r, 'rre_reviewer', REVIEWER_SCHEMA]] as const) {
    expect(Object.keys(body).sort(), name).toEqual(['max_completion_tokens', 'messages', 'model', 'reasoning_effort', 'response_format']);
    expect(body, name).toEqual({ model: 'kimi-k3', messages: body.messages, max_completion_tokens: 8000, reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: strictSchema(schema) } } });
    expect(body, name).not.toHaveProperty('max_tokens');
  }
  const msgs = a.messages as { role: string; content: string }[];
  expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
  expect(msgs[1].content).toContain('<evidence>');
  // the estimate is of the same model and messages as the request it precedes
  expect(counts().map((s) => s.body)).toEqual([{ model: 'kimi-k3', messages: a.messages }, { model: 'kimi-k3', messages: r.messages }]);
  expect(JSON.stringify(seen.map((s) => s.body))).not.toMatch(/"(stream|n|tools|tool_choice|temperature|top_p|fallback[a-z_]*|seed)"\s*:/);
});

test('1b. the adapter refuses a model off the allowlist, a cap above the approved maximum, and images', async () => {
  const p = provider();
  for (const r of [req({ model: 'kimi-k2.6' }), req({ maxOutputTokens: 8001 }), req({ maxOutputTokens: 0 }),
    req({ content: [{ type: 'image', mimeType: 'image/png', base64: 'AAAA' }] })]) {
    seen = [];
    await expect(p.call(r)).rejects.toMatchObject({ name: 'ProviderCallError' });
    expect(seen).toHaveLength(0);
  }
  expect(() => new KimiProvider({ apiKey: '', fetch })).toThrow();
  expect(new KimiProvider({ apiKey: KEY, fetch }).maxRetries).toBe(0);
});

// ---------------------------------------------------------------- 2. no key exposure

test('2. the key reaches only the Authorization header: never a result, a log line, an error or a request body', async () => {
  reset({ REVIEWER: [{ status: 500, body: { error: { message: `SYNTHETIC upstream failure echoing ${KEY}` } } }] });
  const { db, logger, run } = await setup();
  const result = await run();
  const everything = JSON.stringify({ result, logs: logger.events, completions: db.completions, bodies: seen.map((s) => s.body) });
  expect(everything).not.toContain(KEY);
  expect(everything).not.toContain('SYNTHETIC upstream failure');
  const e = await provider().call(req()).then(() => null, (x) => x); // a scripted-out route answers 500
  expect(String(e?.message)).not.toContain(KEY);
});

// ---------------------------------------------------------------- 3, 12, 14. success, both stages, reasoning never exposed

test('3/12/14. a structured answer is parsed for BOTH stages through the same adapter; reasoning_content never leaves it', async () => {
  reset();
  const { db, logger, run } = await setup();
  expect(await run()).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  expect(db.calls.filter((x) => /^(reserve|terms|dispatch|usage|complete)/.test(x))).toEqual([
    'reserve:kimi-k3:kimi-k3', 'terms', 'dispatch:ANALYST', 'usage:ANALYST:1200:900', 'dispatch:REVIEWER', 'usage:REVIEWER:1200:900', 'complete:COMPLETE']);
  expect(db.spend()).toBe('SETTLED:REPORTED_USAGE');
  const out = db.completions[0].output!;
  expect(out.contract_version).toBe('rre-analysis/2');
  expect(out.adversarial_review).toEqual(reviewAnswer('UPHOLD_WITH_CONCERNS'));
  expect(JSON.stringify({ db: db.completions, logs: logger.events })).not.toContain(REASONING);
  const parsed = parseCompletion(completion({ a: 1 }), KIMI_MODEL, { type: 'object', additionalProperties: false, properties: { a: { type: 'integer' } }, required: ['a'] });
  expect(parsed).toEqual({ text: '{"a":1}', stopReason: 'end_turn', inputTokens: 1200, outputTokens: 900, requestId: 'chatcmpl-synthetic01' });
});

test('3b. strict schema: every property required, optional ones made nullable — and the nulls are removed again before validation', () => {
  const strict = strictSchema(ANALYST_SCHEMA);
  const ref = ((strict.properties as Record<string, { items: { properties: { evidence: { items: Record<string, unknown> } } } }>).observations.items.properties.evidence.items);
  expect(ref.required).toEqual(['type', 'message_id', 'position', 'quote']);
  expect((ref.properties as Record<string, { type: unknown }>).message_id.type).toEqual(['string', 'null']);
  expect((ref.properties as Record<string, { type: unknown }>).position.type).toEqual(['integer', 'null']);
  expect(schemaProblems(strict)).toEqual([]); // still inside the documented limits we enforce (0 optional, 10 unions)
  expect(schemaProblems(strictSchema(REVIEWER_SCHEMA))).toEqual([]);
  expect(JSON.stringify(ANALYST_SCHEMA)).not.toContain('"position":{"type":["integer","null"]'); // the original is untouched
  // What a strict model returns (explicit nulls) normalises to exactly the original contract shape.
  const strictAnswer = analystAnswer(undefined, undefined, { observations: [{ id: 'O1', actor: 'PROSPECT', behavior: 'x',
    evidence: [{ type: 'MESSAGE', message_id: 'a0000000-0000-4000-8000-000000000001', position: null, quote: 'the price feels high' }] }] });
  const normal = stripOptionalNulls(strictAnswer, ANALYST_SCHEMA) as Record<string, unknown>;
  expect(validateOutput(normal, ANALYST_SCHEMA)).toBeNull();
  expect(JSON.stringify(normal)).not.toContain('"position":null');
  // A null in a REQUIRED field (classification) is kept: the contract decides.
  expect((stripOptionalNulls({ ...analystAnswer(), classification: null }, ANALYST_SCHEMA) as Record<string, unknown>).classification).toBeNull();
});

// ---------------------------------------------------------------- 4, 5, 6. malformed, off-schema, truncated

test('4/5/6. malformed JSON, off-schema output, truncation and a content filter all fail closed — the billed usage is still recorded', async () => {
  for (const [name, reply, code] of [
    ['prose', completion('Here is my analysis of the conversation.'), 'INVALID_JSON_ANALYST'],
    ['broken JSON', completion('{"analysis_status": "COMPLETE", '), 'INVALID_JSON_ANALYST'],
    ['outside the schema', completion({ ...analystAnswer(), secret_note: 'x' }), 'SCHEMA_INVALID_ANALYST'],
    ['wrong enum', completion(analystAnswer(undefined, undefined, { classification: 'PURPLE' })), 'SCHEMA_INVALID_ANALYST'],
    ['truncated (finish_reason length)', completion('{"analysis_status": "COMP', {}, { completion_tokens: 8000, total_tokens: 9200 }, { finish_reason: 'length' }), 'PROVIDER_INCOMPLETE_ANALYST'],
    ['content filter', completion('', {}, { completion_tokens: 3, total_tokens: 1203 }, { finish_reason: 'content_filter' }), 'PROVIDER_REFUSED_ANALYST'],
    ['no content', completion('', {}, {}, { message: { role: 'assistant', reasoning_content: REASONING } }), 'INVALID_JSON_ANALYST'],
  ] as [string, unknown, string][]) {
    reset({ ANALYST: [{ status: 200, body: reply }] });
    const { db, run } = await setup();
    expect(await run(), name).toMatchObject({ outcome: 'FAILED', code });
    expect(db.calls.filter((x) => x.startsWith('usage:ANALYST')), name).toHaveLength(1);
    expect(db.spend(), name).toBe('SETTLED:REPORTED_USAGE');
    expect(db.completions[0].output, name).toBeNull();
    expect(chats(), name).toHaveLength(1);
  }
});

test('6b. more output than the approved cap, or more input than the reserved bound, is reported in full and fails the run', async () => {
  reset({ ANALYST: [{ status: 200, body: completion(analystAnswer(), {}, { completion_tokens: 8001, total_tokens: 9201 }) }] });
  let s = await setup();
  expect(await s.run()).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_LIMIT_EXCEEDED_ANALYST' });
  expect(s.db.calls).toContain('usage:ANALYST:1200:8001');
  reset({ ANALYST: [{ status: 200, body: completion(analystAnswer(), {}, { prompt_tokens: 9001, total_tokens: 9901 }) }] });
  s = await setup();
  expect(await s.run()).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_INPUT_EXCEEDED_ANALYST' });
});

// ---------------------------------------------------------------- 7. missing or invalid usage

test('7. missing, invalid or inconsistent usage, another model, or an odd choice list: never reported, the reservation is HELD', async () => {
  for (const [name, reply] of [
    ['no usage', { ...completion(analystAnswer()), usage: undefined }],
    ['prompt_tokens missing', completion(analystAnswer(), {}, { prompt_tokens: undefined })],
    ['completion_tokens a string', completion(analystAnswer(), {}, { completion_tokens: '900' })],
    ['negative', completion(analystAnswer(), {}, { prompt_tokens: -1 })],
    ['total inconsistent', completion(analystAnswer(), {}, { total_tokens: 5 })],
    ['reasoning above completion', completion(analystAnswer(), {}, { completion_tokens_details: { reasoning_tokens: 901 } })],
    ['cached tokens invalid', completion(analystAnswer(), {}, { prompt_tokens_details: { cached_tokens: -5 } })],
    ['cache writes a string', completion(analystAnswer(), {}, { prompt_tokens_details: { cache_write_tokens: '10' } })],
    ['cache tokens outside prompt_tokens', completion(analystAnswer(), {}, { prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 501 } })],
    ['another model answered', completion(analystAnswer(), { model: 'kimi-k2.6' })],
    ['no choices', completion(analystAnswer(), { choices: [] })],
    ['two choices', (() => { const c = completion(analystAnswer()); return { ...c, choices: [c.choices[0], c.choices[0]] }; })()],
    ['not JSON at all', 'RAW'],
  ] as [string, unknown][]) {
    reset({ ANALYST: [reply === 'RAW' ? { status: 200, raw: '<html>gateway</html>' } : { status: 200, body: reply }] });
    const { db, run } = await setup();
    expect(await run(), name).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_ERROR_ANALYST' });
    expect(db.calls.some((x) => x.startsWith('usage:')), name).toBe(false);
    expect(db.spend(), name).toBe('HELD:UNKNOWN_USAGE');
  }
});

test('7b. context caching: cached and cache-written tokens inside prompt_tokens are accepted, and ALL prompt tokens are reported for billing', async () => {
  const cached = { prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 500 } };
  reset({ ANALYST: [{ status: 200, body: completion(analystAnswer(), {}, cached) }], REVIEWER: [{ status: 200, body: completion(reviewAnswer('UPHOLD_WITH_CONCERNS'), {}, cached) }] });
  const { db, run } = await setup();
  expect(await run()).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  // no discount is taken for cached input: the ledger bills all 1200 prompt tokens at the input price
  expect(db.calls.filter((x) => x.startsWith('usage:'))).toEqual(['usage:ANALYST:1200:900', 'usage:REVIEWER:1200:900']);
});

// ---------------------------------------------------------------- 8. token counting

test('8a. token counting: the official estimate is used, after the dispatch record, with the 10% margin', async () => {
  reset();
  const { logger, run } = await setup();
  await run();
  expect(logger.events.filter((e) => e.name === 'spend.input_counted').map((e) => [e.fields?.inputTokens, e.fields?.inputBound, e.fields?.ok]))
    .toEqual([[1500, 9000, true], [2500, 30000, true]]);
  expect(await provider().countInputTokens(req()).catch(() => null)).toBeNull(); // the mock script is spent: 500 -> fails closed
});

test('8b. token counting that fails or exceeds the bound: nothing generated, recorded as dispatched with 0/0 usage (USD 0)', async () => {
  for (const [name, count, code] of [
    ['over the bound', [{ status: 200, body: { data: { total_tokens: 8182 } } }], 'INPUT_EXCEEDS_RESERVATION_ANALYST'], // ceil(8182 x 1.1) = 9001 > 9000
    ['HTTP 500', [{ status: 500, body: { error: { message: 'x' } } }], 'TOKEN_COUNT_FAILED_ANALYST'],
    ['HTTP 429', [{ status: 429, body: { error: { message: 'x' } } }], 'TOKEN_COUNT_FAILED_ANALYST'],
    ['no data.total_tokens', [{ status: 200, body: { data: { tokens: 5 } } }], 'TOKEN_COUNT_FAILED_ANALYST'],
    ['not JSON', [{ status: 200, raw: 'oops' }], 'TOKEN_COUNT_FAILED_ANALYST'],
    ['hung', ['HANG'], 'TOKEN_COUNT_FAILED_ANALYST'],
  ] as [string, Reply[], string][]) {
    reset({}, count);
    const { db, run } = await setup();
    expect(await run(), name).toMatchObject({ outcome: 'FAILED', code });
    expect(chats(), name).toHaveLength(0);
    expect(db.calls.filter((x) => /^(dispatch|usage):/.test(x)), name).toEqual(['dispatch:ANALYST', 'usage:ANALYST:0:0']);
    expect(db.spend(), name).toBe('SETTLED:REPORTED_USAGE');
  }
});

// ---------------------------------------------------------------- 9, 10, 11. timeout, HTTP errors, no retries

test('9. timeout: the hung request is aborted, nothing reported, HELD; exactly one request', async () => {
  reset({ REVIEWER: ['HANG', { status: 200, body: GOOD_REVIEW() }] });
  const { db, logger, run } = await setup({ config: { callTimeoutMs: 400 } });
  expect(await run()).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_TIMEOUT_REVIEWER' });
  expect(chats().filter((s) => roleOf(s.body) === 'REVIEWER')).toHaveLength(1);
  expect(db.spend()).toBe('HELD:UNKNOWN_USAGE');
  expect(logger.events.find((e) => e.name === 'provider.call' && e.fields?.ok === false)?.fields).toMatchObject({ usageKnown: false, errorKind: 'TIMEOUT' });
});

test('10/11. HTTP 401, 429 and 500: one request each (no retry, no other model), usage unknown -> HELD, no provider text kept', async () => {
  for (const status of [401, 429, 500]) {
    reset({ ANALYST: [{ status, body: { error: { message: 'SYNTHETIC provider text', type: 'x' } } }, { status: 200, body: GOOD_ANALYST() }] });
    const { db, logger, run } = await setup();
    expect(await run(), String(status)).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_ERROR_ANALYST' });
    expect(chats().map((s) => s.body.model), String(status)).toEqual(['kimi-k3']);
    expect(db.spend(), String(status)).toBe('HELD:UNKNOWN_USAGE');
    expect(logger.events.find((e) => e.name === 'provider.call')?.fields, String(status)).toMatchObject({ errorKind: 'HTTP', httpStatus: status, requestId: 'req-kimi-mock01' });
    expect(JSON.stringify(logger.events)).not.toContain('SYNTHETIC provider text');
  }
});

// ---------------------------------------------------------------- 13. configuration and access controls

test('13a. configuration: fake stays the default; Kimi needs the paid flag, staging and a key; kimi-k3 is priced, an unpriced model is refused', () => {
  const env = (over: Record<string, string | undefined> = {}, url = STAGING_URL) => (k: string) => ({
    SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_SyntheticTestKey_0123' }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_SyntheticTestKey_0123' }),
    ANALYSIS_PROVIDER: 'kimi', ALLOW_PAID_PROVIDER: 'staging-only', KIMI_API_KEY: KEY, ...over,
  } as Record<string, string | undefined>)[k];
  expect(readConfig(env({ ANALYSIS_PROVIDER: 'fake', ALLOW_FAKE_PROVIDER: 'staging-only' }))).toMatchObject({ ok: true, config: { provider: 'fake', kimi: null } });
  expect(readConfig(env({ ANALYSIS_PROVIDER: undefined }))).toEqual({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' });
  expect(readConfig(env({ ALLOW_PAID_PROVIDER: undefined }))).toEqual({ ok: false, code: 'PAID_PROVIDER_NOT_ALLOWED' });
  expect(readConfig(env({}, 'https://productionref00000000000.supabase.co'))).toEqual({ ok: false, code: 'PAID_PROVIDER_NOT_ALLOWED' });
  for (const k of [undefined, '', 'not-a-key', 'sk-short', `${KEY}\nX-Injected: 1`, 'sk-ant-api03-SyntheticAnthropicShapedKey0000000']) {
    expect(readConfig(env({ KIMI_API_KEY: k })), String(k)).toEqual({ ok: false, code: 'PROVIDER_KEY_INVALID' });
  }
  // kimi-k3: 3 input (regular and cache-write; no cached discount) / 15 output, cap 8000 per call.
  expect(KIMI_MODELS).toEqual({ 'kimi-k3': { inputPerMTok: 3, outputPerMTok: 15, maxOutputTokens: 8000, approvedOutputCap: 8000 } });
  expect(Object.isFrozen(KIMI_MODELS) && Object.isFrozen(KIMI_MODELS['kimi-k3'])).toBe(true);
  expect(kimiModelConfig('kimi-k3')).toEqual({ model: 'kimi-k3', inputPerMTok: 3, outputPerMTok: 15, maxOutputTokens: 8000, approvedOutputCap: 8000 });
  expect(kimiModelConfig('kimi-k2')).toBeNull();
  expect(readConfig(env())).toMatchObject({ ok: true, config: { provider: 'kimi', anthropic: null, kimi: { model: 'kimi-k3' } } });
});

test('13b. with Kimi configured, an inactive database price stops the run at the reservation: nothing is sent to Moonshot', async () => {
  reset();
  const s = await setup();
  s.db.reserveError = new DbError('MODEL_NOT_PRICED');
  expect(await s.run()).toMatchObject({ outcome: 'FAILED' });
  expect(seen).toHaveLength(0);
  expect(s.db.calls.filter((x) => /^(reserve|dispatch|usage)/.test(x))).toEqual(['reserve:kimi-k3:kimi-k3']);
  expect(s.db.spend()).toBe('NONE');
});

test('13b-2. the pricing migration, its self-check, its verification and the code allowlist carry the same prices and cap', () => {
  const read = (p: string) => readFileSync(new URL(`../../supabase/${p}`, import.meta.url), 'utf8');
  const migration = read('migrations/20261021120000_stage2a6e_kimi_price.sql');
  const rows = [...migration.matchAll(/^\s+\('([a-z0-9-]+)', ([0-9.]+), ([0-9.]+), ([0-9]+), (true|false), '/gm)]
    .map((m) => [m[1], { inputPerMTok: Number(m[2]), outputPerMTok: Number(m[3]), cap: Number(m[4]), active: m[5] === 'true' }] as const);
  expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(Object.entries(KIMI_MODELS).map(([model, m]) =>
    [model, { inputPerMTok: m.inputPerMTok, outputPerMTok: m.outputPerMTok, cap: m.approvedOutputCap, active: false }])));
  const m = KIMI_MODELS['kimi-k3'];
  expect(read('deploy/parts-2a6e/90_postcheck.sql')).toContain(`(${m.inputPerMTok}::numeric, ${m.outputPerMTok}::numeric, ${m.approvedOutputCap}, false)`);
  expect(read('deploy/stage2a6e_verify.sql')).toContain(`input_usd_per_mtok = ${m.inputPerMTok} and output_usd_per_mtok = ${m.outputPerMTok} and max_output_tokens = ${m.approvedOutputCap}`);
  expect(read('deploy/stage2a6e_deploy.sql')).toContain(migration);
  expect(read('scripts/paid-pipeline-e2e.mjs')).toContain(`'kimi-k3': Object.freeze({ in: ${m.inputPerMTok}, out: ${m.outputPerMTok}, cap: ${m.approvedOutputCap} })`);
});

test('13c. screenshots are refused for the paid provider before any reservation or request', async () => {
  reset();
  const { db, run } = await setup({ shots: true });
  expect(await run()).toMatchObject({ outcome: 'FAILED', code: 'PAID_PROVIDER_TEXT_ONLY' });
  expect(db.spend()).toBe('NONE');
  expect(seen).toHaveLength(0);
});

test('13d. an adversarial REJECT verdict through Kimi still strips every contact instruction', async () => {
  reset({ REVIEWER: [{ status: 200, body: completion(reviewAnswer('REJECT_RECOMMENDATION')) }] });
  const { db, run } = await setup();
  expect(await run()).toMatchObject({ outcome: 'COMPLETED', code: 'RECOMMENDATION_REJECTED_BY_REVIEW' });
  expect(db.completions[0]).toMatchObject({ proposedMessage: null, classification: null });
});

// ---------------------------------------------------------------- source guard

test('source guard: the current code passes; the Kimi endpoint outside the adapter, or a Kimi-shaped key, is refused', () => {
  const fns = fileURLToPathSafe('../../supabase/functions');
  const files = readTree(fns) as { path: string; text: string }[];
  expect(sourceProblems(files)).toEqual([]);
  const withEndpoint = files.map((f) => (f.path === '_shared/edge/handler.ts' ? { ...f, text: `${f.text}\n// https://api.moonshot.ai/v1/chat/completions` } : f));
  expect(sourceProblems(withEndpoint)).toContain('_shared/edge/handler.ts: names the Kimi endpoint');
  const withKey = [...files, { path: '_shared/edge/k.ts', text: "export const K = 'sk-0123456789abcdefghijABCDEFGHIJ0123456789';" }];
  expect(sourceProblems(withKey)).toContain('_shared/edge/k.ts: contains something shaped like a Kimi key');
  expect(estimateBody(req())).toEqual({ model: 'kimi-k3', messages: (chatBody(req()) as { messages: unknown }).messages });
});

function fileURLToPathSafe(rel: string): string {
  return decodeURIComponent(new URL(rel, import.meta.url).pathname);
}

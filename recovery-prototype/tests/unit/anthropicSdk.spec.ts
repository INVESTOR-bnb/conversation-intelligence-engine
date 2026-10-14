// Stage 2A-6b — the REAL pinned SDK (@anthropic-ai/sdk 0.133.0, a devDependency for these
// tests; the Edge Function imports the same version from npm:) driven by the adapter against a
// LOCAL mock of the Messages API. No request leaves 127.0.0.1; the key is a synthetic string
// that is not shaped like a real one. Proves on the wire: one request per call (no SDK retry
// on 429/500/529), no beta or fallback, the explicit key and base URL win over the environment.

import Anthropic from '@anthropic-ai/sdk';
import { expect, test } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { runAnalysisPipeline, type ProviderRequest } from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import {
  AnthropicProvider, anthropicModelConfig, makeAnthropicClient, messagesBody, type AnthropicConstructor,
} from '../../supabase/functions/_shared/edge/anthropicProvider.ts';
import { analystAnswer, CASE, FakeDb, manifest, MemoryLogger, reviewAnswer } from '../pipeline/fakes';
import { message } from './fixtures/anthropicMessages';

const KEY = 'sk-ant-TEST-ONLY-not-a-real-key-0000';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | 'HANG';

let server: Server;
let base = '';
let seen: Seen[] = [];
let replies: Record<string, Reply[]> = {};
const hung: ServerResponse[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      seen.push({ method: req.method ?? '', path, headers: req.headers, body: data ? JSON.parse(data) : {} });
      const r = replies[path]?.shift() ?? { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'no script' } } };
      if (r === 'HANG') { hung.push(res); return; }
      res.writeHead(r.status, { 'content-type': 'application/json', 'request-id': 'req_mock01', ...r.headers });
      res.end(r.raw ?? JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { for (const r of hung) r.destroy(); await new Promise((r) => server.close(() => r(null))); });
test.beforeEach(() => { seen = []; replies = {}; });

const client = () => makeAnthropicClient(Anthropic as unknown as AnthropicConstructor, KEY, base);
const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  role: 'ANALYST', model: OPUS, system: 'SYNTHETIC system', content: [{ type: 'text', text: 'SYNTHETIC evidence' }],
  schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] },
  maxOutputTokens: 4096, signal: new AbortController().signal, ...over,
});
const apiError = (type: string) => ({ type: 'error', error: { type, message: 'SYNTHETIC upstream message' }, request_id: 'req_mock01' });

test('success on the wire: one POST /v1/messages with the exact body, the key on x-api-key, no beta, no Authorization', async () => {
  replies['/v1/messages'] = [{ status: 200, body: message({ a: 'x' }) }];
  const p = new AnthropicProvider(client(), 'medium');
  const r = await p.call(req());
  expect(r).toMatchObject({ text: '{"a":"x"}', stopReason: 'end_turn', inputTokens: 1200, outputTokens: 900 });
  expect(seen).toHaveLength(1);
  const [s] = seen;
  expect([s.method, s.path]).toEqual(['POST', '/v1/messages']);
  expect(s.body).toEqual(messagesBody(req(), 'medium'));
  expect(s.headers['x-api-key']).toBe(KEY);
  expect(s.headers['anthropic-version']).toBeTruthy();
  expect(s.headers.authorization).toBeUndefined();
  expect(s.headers['anthropic-beta']).toBeUndefined();
  expect(s.headers['x-stainless-retry-count']).toBe('0');
});

test('count_tokens on the wire: POST /v1/messages/count_tokens with the same input; nothing generated', async () => {
  replies['/v1/messages/count_tokens'] = [{ status: 200, body: { input_tokens: 4321 } }];
  const p = new AnthropicProvider(client(), 'low');
  expect(await p.countInputTokens(req())).toBe(4321);
  expect(seen.map((s) => s.path)).toEqual(['/v1/messages/count_tokens']);
  const { model, system, messages, output_config } = messagesBody(req(), 'low');
  expect(seen[0].body).toEqual({ model, system, messages, output_config });
});

test('no retry on the wire: 429, 500, 503 with x-should-retry, 529 and a dropped connection each make exactly one request', async () => {
  const p = new AnthropicProvider(client(), 'medium');
  for (const [name, reply, kind, status] of [
    ['429', { status: 429, body: apiError('rate_limit_error'), headers: { 'retry-after': '0' } }, 'HTTP', 429],
    ['500', { status: 500, body: apiError('api_error') }, 'HTTP', 500],
    ['503 retry hint', { status: 503, body: apiError('api_error'), headers: { 'x-should-retry': 'true' } }, 'HTTP', 503],
    ['529', { status: 529, body: apiError('overloaded_error') }, 'HTTP', 529],
  ] as [string, Reply, string, number][]) {
    seen = [];
    replies['/v1/messages'] = [reply, { status: 200, body: message({ a: 'second request must never happen' }) }];
    const e = await p.call(req()).then(() => null, (x) => x);
    expect(e, name).toMatchObject({ name: 'ProviderCallError', kind, httpStatus: status });
    expect(e.message, name).not.toContain('SYNTHETIC');
    expect(seen, name).toHaveLength(1);
  }
});

test('timeout on the wire: the pipeline aborts the hung request; one request; ABORTED', async () => {
  replies['/v1/messages'] = ['HANG', { status: 200, body: message({ a: 'no' }) }];
  const p = new AnthropicProvider(client(), 'medium');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const e = await p.call(req({ signal: ac.signal })).then(() => null, (x) => x);
  expect(e).toMatchObject({ name: 'ProviderCallError', kind: 'ABORTED' });
  expect(seen).toHaveLength(1);
});

test('malformed 200 bodies: not JSON, or not a message -> a provider error (usage unknown), never parsed as usage', async () => {
  const p = new AnthropicProvider(client(), 'medium');
  for (const reply of [{ status: 200, raw: '{"type": "message", "content": [' }, { status: 200, body: { hello: 'world' } }] as Reply[]) {
    seen = [];
    replies['/v1/messages'] = [reply];
    await expect(p.call(req())).rejects.toMatchObject({ name: 'ProviderCallError' });
    expect(seen).toHaveLength(1);
  }
});

test('the environment cannot redirect or re-authenticate the client (explicit base URL, key, no auth token)', async () => {
  const saved = { ...process.env };
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9/never';
  process.env.ANTHROPIC_AUTH_TOKEN = 'SYNTHETIC-env-token';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-ENV-KEY-must-not-be-used-0000';
  try {
    replies['/v1/messages'] = [{ status: 200, body: message({ a: 'x' }) }];
    await new AnthropicProvider(client(), 'medium').call(req());
    expect(seen).toHaveLength(1);
    expect(seen[0].headers['x-api-key']).toBe(KEY);
    expect(seen[0].headers.authorization).toBeUndefined();
  } finally {
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('the full pipeline over the real SDK: success settles from reported usage; a 500 on the reviewer is HELD after one request', async () => {
  const setup = async () => {
    const db = new FakeDb(await manifest({ screenshots: [] }));
    db.approved = { ANALYST: { model: OPUS, maxOutputTokens: 16000 }, REVIEWER: { model: SONNET, maxOutputTokens: 8000 } };
    db.prices = { ANALYST: [4, 20], REVIEWER: [2, 10] };
    db.inputBound = { ANALYST: 9000, REVIEWER: 30000 };
    db.reservedUsd = 0.496;
    const run = () => runAnalysisPipeline(CASE, { founderDb: db, serviceDb: db, provider: new AnthropicProvider(client(), 'medium'), logger: new MemoryLogger(),
      config: { analyst: anthropicModelConfig(OPUS)!, reviewer: anthropicModelConfig(SONNET)!, textOnly: true, callTimeoutMs: 2000, deadlineMs: 10000, completionReserveMs: 500, maxScreenshotBytes: 1024 } });
    return { db, run };
  };
  replies['/v1/messages/count_tokens'] = [{ status: 200, body: { input_tokens: 2000 } }, { status: 200, body: { input_tokens: 3000 } }];
  replies['/v1/messages'] = [{ status: 200, body: message(analystAnswer()) }, { status: 200, body: message(reviewAnswer('UPHOLD'), { model: SONNET }) }];
  let s = await setup();
  expect(await s.run()).toMatchObject({ outcome: 'COMPLETED', code: 'OK' });
  expect(seen.map((x) => `${x.path}:${x.body.model}`)).toEqual([
    `/v1/messages/count_tokens:${OPUS}`, `/v1/messages:${OPUS}`, `/v1/messages/count_tokens:${SONNET}`, `/v1/messages:${SONNET}`]);
  expect(s.db.spend()).toBe('SETTLED:REPORTED_USAGE');

  seen = [];
  replies['/v1/messages/count_tokens'] = [{ status: 200, body: { input_tokens: 2000 } }, { status: 200, body: { input_tokens: 3000 } }];
  replies['/v1/messages'] = [{ status: 200, body: message(analystAnswer()) }, { status: 500, body: apiError('api_error') }, { status: 200, body: message(reviewAnswer('UPHOLD'), { model: SONNET }) }];
  s = await setup();
  expect(await s.run()).toMatchObject({ outcome: 'FAILED', code: 'PROVIDER_ERROR_REVIEWER' });
  expect(seen.filter((x) => x.path === '/v1/messages')).toHaveLength(2);
  expect(s.db.spend()).toBe('HELD:UNKNOWN_USAGE');
});

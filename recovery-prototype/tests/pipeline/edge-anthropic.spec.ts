// Stage 2A-6b — the analyze-case handler configured for the Anthropic provider, end to end over
// HTTP (local fake of Supabase's APIs -> the REAL local database), with a SCRIPTED messages
// client injected where analyze-case/index.ts injects the SDK. No network, no real key.
// Covers: configuration refusals, founder-only access, text-only, and no key in any output.

import { expect, test } from '@playwright/test';
import { sha256Hex } from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { readConfig, STAGING_URL, UNSAFE_PROVIDER_ENV } from '../../supabase/functions/_shared/edge/config.ts';
import { createAnalyzeCaseHandler } from '../../supabase/functions/_shared/edge/handler.ts';
import { message, ScriptedClient } from '../unit/fixtures/anthropicMessages';
import { analystAnswer, BODY1, BODY2, reviewAnswer } from './fakes';
import { FakeSupabase, PUBLISHABLE, SECRET } from './fakeSupabase';
import { BIZ_A, CLIENT_A, CLIENT_B, enableTestSpending, FOUNDER, makeRoomForCase, one, sql } from './psqlDb';

const KEY = 'sk-ant-TEST-ONLY-not-a-real-key-0000';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const fake = new FakeSupabase();
let logs: string[] = [];
let clients: { key: string; client: ScriptedClient }[] = [];
let n = 0;

test.beforeAll(async () => { sql('select tests.seed() where not exists (select 1 from public.founders)'); await fake.start(); });
test.afterAll(async () => {
  sql(`update private.ai_model_prices set active = false where model in (:'o', :'s')`, { o: OPUS, s: SONNET });
  await fake.stop();
});
test.beforeEach(() => {
  enableTestSpending();
  sql(`insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note)
       values (:'o', 4, 20, 12000, true, 'LOCAL TEST ONLY'), (:'s', 2, 10, 8000, true, 'LOCAL TEST ONLY')
       on conflict (model) do update set input_usd_per_mtok = excluded.input_usd_per_mtok, output_usd_per_mtok = excluded.output_usd_per_mtok,
         max_output_tokens = excluded.max_output_tokens, active = true`, { o: OPUS, s: SONNET });
  logs = []; clients = []; fake.requests = [];
});

const ENV: Record<string, string | undefined> = {
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
  ANALYSIS_PROVIDER: 'anthropic', ALLOW_PAID_PROVIDER: 'staging-only', ANTHROPIC_API_KEY: KEY, ANALYST_MODEL: OPUS, REVIEWER_MODEL: SONNET,
};
function handler(over: Record<string, string | undefined> = {}, script?: () => ScriptedClient) {
  const e: Record<string, string | undefined> = { SUPABASE_URL: fake.url, ...ENV, ...over };
  return createAnalyzeCaseHandler({
    env: (k) => e[k], fetch: (i, init) => fetch(i, init), log: (l) => logs.push(l),
    anthropicClient: (apiKey) => { const client = script ? script() : good(); clients.push({ key: apiKey, client }); return client; },
  });
}
let ids: { m1: string; m2: string } = { m1: '', m2: '' };
const good = () => new ScriptedClient({ ANALYST: message(analystAnswer(ids.m1, ids.m2)), REVIEWER: message(reviewAnswer('UPHOLD', ids.m1), { model: SONNET }) });

async function post(h: (r: Request) => Promise<Response>, caseId: string, token = fake.tokenFor(FOUNDER)) {
  const res = await h(new Request('https://edge.local/functions/v1/analyze-case', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ case_id: caseId }),
  }));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}
function textCase() {
  n += 1;
  makeRoomForCase();
  const c = one(`select public.client_create_case(gen_random_uuid(), :'ref', 'Synthetic car', 'Referral', 'TEXT', :'body')`,
    { ref: `EA-${n}`, body: BODY1 }, { role: 'authenticated', sub: CLIENT_A })!;
  sql(`select public.client_submit_case(:'c')`, { c }, { role: 'authenticated', sub: CLIENT_A });
  ids = {
    m1: one(`select id from public.case_messages where case_id = :'c'`, { c })!,
    m2: one(`insert into public.case_messages (case_id, business_id, kind, body) values (:'c', :'b', 'PROSPECT_RESPONSE', :'body') returning id`, { c, b: BIZ_A, body: BODY2 })!,
  };
  return c;
}

test('a founder run with the Anthropic adapter completes; the explicit key reaches only the SDK factory; nothing leaks', async () => {
  const c = textCase();
  const r = await post(handler(), c);
  expect(r).toMatchObject({ status: 200, body: { outcome: 'COMPLETED', code: 'OK' } });
  expect(clients.map((x) => x.key)).toEqual([KEY]);
  expect(clients[0].client.creates.map((x) => x.body.model)).toEqual([OPUS, SONNET]);
  expect(one(`select status || ':' || settled_by from private.ai_spend_ledger where analysis_id = :'a'`, { a: r.body.analysis_id })).toBe('SETTLED:REPORTED_USAGE');
  expect(fake.requests.filter((x) => x.cred.startsWith('service')).map((x) => x.path)).toEqual(['/rest/v1/rpc/internal_reserve_ai_spend',
    '/rest/v1/rpc/internal_ai_reservation_terms', '/rest/v1/rpc/internal_ai_dispatch', '/rest/v1/rpc/internal_ai_report_usage',
    '/rest/v1/rpc/internal_ai_dispatch', '/rest/v1/rpc/internal_ai_report_usage', '/rest/v1/rpc/internal_complete_analysis']);
  const all = `${r.text}\n${logs.join('\n')}`;
  for (const s of [KEY, 'sk-ant', BODY1, BODY2, 'price feels high', SECRET]) expect(all, s.slice(0, 12)).not.toContain(s);
  // the founder reads the analysis; the business that owns the case does not
  expect(one(`select count(*) from public.analyses where id = :'a'`, { a: r.body.analysis_id }, { role: 'authenticated', sub: FOUNDER })).toBe('1');
  expect(one(`select count(*) from public.analyses where id = :'a'`, { a: r.body.analysis_id }, { role: 'authenticated', sub: CLIENT_A })).toBe('0');
});

test('businesses cannot run it: a client token is refused before any provider client is built', async () => {
  const c = textCase();
  for (const u of [CLIENT_A, CLIENT_B]) {
    const r = await post(handler(), c, fake.tokenFor(u));
    expect(r.status, u).toBe(403);
  }
  expect(clients).toEqual([]);
});

test('text only: a screenshots case is refused before any reservation or provider request', async () => {
  n += 1;
  makeRoomForCase();
  const c = one(`select public.client_create_case(gen_random_uuid(), :'ref', 'Synthetic car', 'Referral', 'SCREENSHOTS')`, { ref: `EAS-${n}` }, { role: 'authenticated', sub: CLIENT_A })!;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, 1, 2, 3]);
  const sha = await sha256Hex(bytes);
  const path = `${BIZ_A}/${c}/1-${sha}.png`;
  fake.storage.set(path, bytes);
  sql(`begin; set local session_replication_role = replica;
       insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', :'p', :'u', '{"mimetype": "image/png"}');
       insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
         values (:'c', :'b', 1, :'p', 'image/png', :'size', :'sha', :'u'); commit;`, { c, b: BIZ_A, p: path, size: String(bytes.length), sha, u: CLIENT_A });
  sql(`update public.cases set workflow_state = 'SUBMITTED', evidence_version = 1 where id = :'c'`, { c });
  const r = await post(handler(), c);
  expect(r.body).toMatchObject({ outcome: 'FAILED', code: 'PAID_PROVIDER_TEXT_ONLY' });
  expect(one(`select count(*) from private.ai_spend_ledger where analysis_id = :'a'`, { a: r.body.analysis_id })).toBe('0');
  expect(clients.flatMap((x) => [...x.client.creates, ...x.client.counts])).toEqual([]);
});

test('configuration refusals for the paid provider (no provider client is ever built)', async () => {
  const c = textCase();
  for (const [name, over, code] of [
    ['no permission flag', { ALLOW_PAID_PROVIDER: undefined }, 'PAID_PROVIDER_NOT_ALLOWED'],
    ['wrong permission flag', { ALLOW_PAID_PROVIDER: 'true' }, 'PAID_PROVIDER_NOT_ALLOWED'],
    ['no key', { ANTHROPIC_API_KEY: undefined }, 'PROVIDER_KEY_INVALID'],
    ['key of the wrong shape', { ANTHROPIC_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }, 'PROVIDER_KEY_INVALID'],
    ['key with a newline', { ANTHROPIC_API_KEY: `${KEY}\nX-Evil: 1` }, 'PROVIDER_KEY_INVALID'],
    ['model off the allowlist', { ANALYST_MODEL: 'claude-opus-4-8' }, 'MODEL_NOT_ALLOWED'],
    ['reviewer model missing', { REVIEWER_MODEL: undefined }, 'MODEL_NOT_ALLOWED'],
    ['fake model as the paid model', { REVIEWER_MODEL: 'FAKE-PROVIDER-NOT-AI' }, 'MODEL_NOT_ALLOWED'],
    ['effort not allowed', { ANTHROPIC_EFFORT: 'max' }, 'CONFIG_INVALID'],
    ['base URL override', { ANTHROPIC_BASE_URL: 'https://proxy.example' }, 'PROVIDER_ENV_UNSAFE'],
    ['extra headers', { ANTHROPIC_CUSTOM_HEADERS: 'anthropic-beta: x' }, 'PROVIDER_ENV_UNSAFE'],
    ['SDK logging', { ANTHROPIC_LOG: 'debug' }, 'PROVIDER_ENV_UNSAFE'],
    ['auth token', { ANTHROPIC_AUTH_TOKEN: 'x' }, 'PROVIDER_ENV_UNSAFE'],
  ] as [string, Record<string, string | undefined>, string][]) {
    fake.requests = [];
    const r = await post(handler(over), c);
    expect([r.status, r.body.code], name).toEqual([503, code]);
    expect(fake.requests.filter((x) => x.path.startsWith('/rest')), name).toEqual([]);
    expect(r.text + logs.join(''), name).not.toContain('sk-ant');
  }
  expect(clients).toEqual([]);
});

test('readConfig: the paid provider only on staging or a local host; every SDK environment override is refused', () => {
  const e = (url: string, over: Record<string, string | undefined> = {}) => (k: string) => ({ SUPABASE_URL: url, ...ENV, ...over } as Record<string, string | undefined>)[k];
  expect(readConfig(e(STAGING_URL))).toMatchObject({ ok: true, config: { provider: 'anthropic', anthropic: { analystModel: OPUS, reviewerModel: SONNET, effort: 'medium' } } });
  expect(readConfig(e(STAGING_URL, { ANTHROPIC_EFFORT: 'high' }))).toMatchObject({ ok: true, config: { anthropic: { effort: 'high' } } });
  expect(readConfig(e('https://productionprojectref.supabase.co'))).toEqual({ ok: false, code: 'PAID_PROVIDER_NOT_ALLOWED' });
  for (const name of UNSAFE_PROVIDER_ENV) expect(readConfig(e(STAGING_URL, { [name]: 'x' })), name).toEqual({ ok: false, code: 'PROVIDER_ENV_UNSAFE' });
  // the fake configuration is untouched by the paid settings
  expect(readConfig(e(STAGING_URL, { ANALYSIS_PROVIDER: 'fake', ALLOW_FAKE_PROVIDER: 'staging-only' }))).toMatchObject({ ok: true, config: { provider: 'fake', anthropic: null } });
});

// Stage 2A-6d — the guarded single-case PAID run (supabase/scripts/paid-pipeline-e2e.mjs) as a real
// child process, entirely offline, against the REAL local test database:
//   * Supabase Auth/PostgREST: tests/pipeline/fakeSupabase.ts (RLS and grants decide);
//   * the Edge Function: the real analyze-case handler behind an emulated platform JWT check, its
//     configuration read from the emulated function secrets on every request, and the Anthropic
//     SDK replaced by a SCRIPTED messages client (no network, no key: a synthetic string); the
//     Kimi adapter's fetch routed to a local MOCK of the two Moonshot endpoints (Stage 2A-6e);
//   * the Management API: a local emulator executing the script's SQL as the database owner and
//     serving function metadata, the function body (the working tree's sources, EZBR-encoded) and
//     the function secrets (list, write, delete).
// The preload routes only those hosts locally and refuses every other host (api.anthropic.com included);
// the function's own fetch reaches api.moonshot.ai only as the local mock, and nothing else.
// Run via supabase/scripts/test-pipeline-db.sh.

import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { createAnalyzeCaseHandler } from '../../supabase/functions/_shared/edge/handler.ts';
import { fakeAnalystAnswer, fakeReviewAnswer } from '../../supabase/functions/_shared/edge/fakeProvider.ts';
import { message, ScriptedClient } from '../unit/fixtures/anthropicMessages';
import { FakeSupabase, PUBLISHABLE, SECRET } from './fakeSupabase';
import { makeRoomForCase, one, sql } from './psqlDb';

const SCRIPT = fileURLToPath(new URL('../../supabase/scripts/paid-pipeline-e2e.mjs', import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./fixtures/route-to-local.mjs', import.meta.url))).href;
const FUNCTIONS_DIR = fileURLToPath(new URL('../../supabase/functions', import.meta.url));
const REF = 'aqwdwswpmbnzmkvyuqil';
const PAT = `sbp_${randomBytes(20).toString('hex')}`;
const PROVIDER_KEY = `sk-ant-TEST-ONLY-${randomBytes(12).toString('hex')}`;
const KIMI_KEY = `sk-TESTONLY${randomBytes(16).toString('hex')}`;
const KIMI = 'kimi-k3';
const LIMIT_OK = 'PROVIDER-LIMIT-CONFIRMED';
const RUN_OK = 'RUN-ONE-PAID-ANALYSIS';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const ACCOUNTS = {
  FOUNDER_EMAIL: 'founder@synthetic.test', FOUNDER_PASSWORD: `founder-${randomBytes(6).toString('hex')}`,
  CLIENT_A_EMAIL: 'client-a@synthetic.test', CLIENT_A_PASSWORD: `client-a-${randomBytes(6).toString('hex')}`,
  CLIENT_B_EMAIL: 'client-b@synthetic.test', CLIENT_B_PASSWORD: `client-b-${randomBytes(6).toString('hex')}`,
};
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const PAID_NAME = /^(ANTHROPIC_[A-Z0-9_]*|KIMI_[A-Z0-9_]*|ALLOW_PAID_PROVIDER|ANALYST_MODEL|REVIEWER_MODEL)$/;

function functionSources(dir = FUNCTIONS_DIR): string {
  return readdirSync(dir).sort().map((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? functionSources(p) : `// ${p}\n${readFileSync(p, 'utf8')}`;
  }).join('\n');
}
function oldSources(): string {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: FUNCTIONS_DIR, encoding: 'utf8', maxBuffer: 20_000_000 });
  return git('ls-tree', '-r', '--name-only', '9ee3767', '--', '.').split('\n').filter(Boolean).map((f) => `// ${f}\n${git('show', `9ee3767:./${f}`)}`).join('\n');
}
const ezbr = (text: string) => Buffer.concat([Buffer.from('EZBR'), brotliCompressSync(Buffer.from(text))]);

// ---------------------------------------------------------------- local servers
const fake = new FakeSupabase();
const sequence: string[] = [];
fake.sequence = sequence;

interface Knobs {
  deny: Set<string>; fail: Map<string, number>; before: Map<string, () => void>;
  fn: Record<string, unknown>; body: Buffer;
  secrets: Map<string, string>;
  /** 'hang' | 'platform-401' | 'error-500' | 'stale-config' (keeps running the fake) | null */
  fnMode: string | null;
  /** The scripted provider (Anthropic client or Kimi mock): 'ok' | 'reviewer-500' */
  provider: string;
  /** What the mocked Kimi analyst writes: the fake's insufficient-evidence answer, a complete analysis, or a complete one with an id defect. */
  kimiAnalyst: 'fake' | 'complete' | 'duplicate-ids' | 'missing-reference';
  /** What the mocked Kimi reviewer writes. */
  kimiReviewer: 'fake' | 'uphold' | 'reject';
}
let knobs: Knobs;
const mgmtLog: string[] = [];
const fnCalls: string[] = [];
const clients: { key: string; client: ScriptedClient }[] = [];
/** Every request the function made to the (mock) Moonshot API. */
const kimiSeen: { path: string; auth: string; body: Record<string, unknown> }[] = [];

function reset() {
  const body = ezbr(functionSources());
  knobs = {
    deny: new Set(), fail: new Map(), before: new Map(),
    fn: { id: 'fn-1', slug: 'analyze-case', name: 'analyze-case', status: 'ACTIVE', version: 4, verify_jwt: true, ezbr_sha256: sha(body) },
    body,
    secrets: new Map([['ALLOW_FAKE_PROVIDER', 'staging-only'], ['ANALYSIS_PROVIDER', 'fake'], ['SUPABASE_URL', 'x'], ['SUPABASE_SECRET_KEYS', 'y']]),
    fnMode: null, provider: 'ok', kimiAnalyst: 'fake', kimiReviewer: 'fake',
  };
  mgmtLog.length = 0; fnCalls.length = 0; sequence.length = 0; clients.length = 0; kimiSeen.length = 0;
}
reset();

const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const readBody = async (req: IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c).toString('utf8'); };

const mgmt = createServer((req, res) => { void (async () => {
  const u = new URL(req.url ?? '/', 'http://x');
  const route = u.pathname.replace(`/v1/projects/${REF}`, '');
  if (!u.pathname.startsWith(`/v1/projects/${REF}`)) return send(res, 404, { message: 'project not found' });
  if (req.headers.authorization !== `Bearer ${PAT}`) return send(res, 401, { message: 'Unauthorized' });
  const raw = await readBody(req);
  let tag = `${req.method} ${route}`;
  let query = '';
  if (route === '/database/query' && req.method === 'POST') {
    query = (JSON.parse(raw) as { query: string }).query;
    tag = /^\/\* rre:([a-z]+) \*\//.exec(query)?.[1] ?? 'untagged';
  }
  mgmtLog.push(tag);
  sequence.push(`mgmt ${tag}`);
  if (knobs.deny.has(tag)) return send(res, 403, { message: 'Forbidden', missing_permissions: ['secrets_write'] });
  const f = knobs.fail.get(tag) ?? 0;
  if (f > 0) { knobs.fail.set(tag, f - 1); return send(res, 500, { message: 'synthetic failure' }); }
  knobs.before.get(tag)?.();
  if (route === '/database/query') {
    if (tag === 'untagged') return send(res, 400, { message: 'only tagged statements are expected' });
    try {
      // A statement with data-modifying CTEs cannot be nested: run it as sent (like the real endpoint), rows as CSV.
      if (/^\/\*[^*]*\*\/\s*with\b/i.test(query) && /\bupdate\b/i.test(query)) {
        const [head, ...rest] = sql(`\\pset tuples_only off\n\\pset format csv\n${query.replace(/;\s*$/, '')};`);
        const cols = head.split(',');
        return send(res, 201, rest.map((l) => Object.fromEntries(l.split(',').map((v, n) => [cols[n], v]))));
      }
      const rows = sql(`with t as (${query.replace(/;\s*$/, '')}) select coalesce(json_agg(t), '[]') from t`);
      return send(res, 201, JSON.parse(rows.join('\n') || '[]'));
    } catch (e) { return send(res, 400, { message: (e as Error).message }); }
  }
  if (route === '/functions/analyze-case' && req.method === 'GET') return send(res, 200, knobs.fn);
  if (route === '/functions/analyze-case/body' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(knobs.body); return; }
  if (route === '/secrets' && req.method === 'GET') return send(res, 200, [...knobs.secrets].map(([name, value]) => ({ name, value: sha(value) })));
  if (route === '/secrets' && req.method === 'POST') { for (const s of JSON.parse(raw) as { name: string; value: string }[]) knobs.secrets.set(s.name, s.value); return send(res, 201, undefined); }
  if (route === '/secrets' && req.method === 'DELETE') { for (const n of JSON.parse(raw) as string[]) knobs.secrets.delete(n); return send(res, 200, {}); }
  return send(res, 404, { message: 'not found' });
})(); });

// A local mock of the two Moonshot endpoints (synthetic answers from the fake provider's content).
const kimiMock = createServer((req, res) => { void (async () => {
  const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
  const path = (req.url ?? '').split('?')[0];
  kimiSeen.push({ path, auth: String(req.headers.authorization ?? ''), body });
  if (path === '/v1/tokenizers/estimate-token-count') return send(res, 200, { data: { total_tokens: 1200 } });
  const role = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name === 'rre_reviewer' ? 'REVIEWER' : 'ANALYST';
  if (role === 'REVIEWER' && knobs.provider === 'reviewer-500') return send(res, 500, { error: { message: 'synthetic upstream failure' } });
  // The evidence exactly as the model receives it (the <evidence> block of the user message).
  const user = ((body.messages as { role: string; content: string }[] | undefined) ?? []).find((m) => m.role === 'user')?.content ?? '';
  const evidence = JSON.parse(/<evidence>\n([\s\S]*?)\n<\/evidence>/.exec(user)?.[1] ?? '{"messages":[]}') as { messages: { message_id: string; text: string }[] };
  const mid = evidence.messages[0]?.message_id ?? 'none';
  const answer = role === 'ANALYST'
    ? (knobs.kimiAnalyst === 'fake' ? fakeAnalystAnswer() : completeCarAnalysis(mid, knobs.kimiAnalyst))
    : (knobs.kimiReviewer === 'fake' ? fakeReviewAnswer() : carReview(mid, knobs.kimiReviewer));
  return send(res, 200, { id: `synthetic-${role}`, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
    usage: { prompt_tokens: 1200, completion_tokens: 900, total_tokens: 2100, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1200 } } });
})(); });
let KIMI_URL = '';

/** A complete, evidence-grounded analysis of the car-price scenario (quotes copied exactly from it), optionally with one id defect. */
function completeCarAnalysis(mid: string, variant: string) {
  const q = (quote: string) => [{ type: 'MESSAGE', message_id: mid, quote }];
  const a = {
    analysis_status: 'COMPLETE', classification: 'YELLOW',
    evidence_assessment: { sufficiency: 'PARTIAL', summary: 'One pasted conversation; the prospect asked for a viewing that was never answered.', missing_evidence: ['Whether the prospect still needs a car'] },
    observations: [
      { id: 'O1', actor: 'PROSPECT', behavior: 'Asked for the best price.', evidence: q('What is the best price?') },
      { id: 'O2', actor: 'PROSPECT', behavior: 'Said they must check with a partner and a bank.', evidence: q('I need to check with my partner and my bank first.') },
      { id: 'O3', actor: 'PROSPECT', behavior: 'Asked to see the car on Saturday morning.', evidence: q('Could I come on Saturday morning to see it?') },
      { id: 'O4', actor: 'SELLER', behavior: 'Asked whether the prospect was still interested without answering the Saturday request.', evidence: q('Hello? Are you still interested?') },
    ],
    hypotheses: [
      { id: 'H1', category: 'SELLER_CREATED_RESISTANCE', statement: 'The unanswered viewing request left the prospect without a next step.', basis: 'HYPOTHESIS',
        supporting_observations: ['O3', 'O4'], contradicting_observations: [], competing_hypotheses: ['H2'], confidence: 'MEDIUM', uncertainty: 'The prospect may have lost interest for other reasons.' },
      { id: 'H2', category: 'DECISION_FRICTION', statement: 'The decision depends on a partner and a bank.', basis: 'STATED_BY_PROSPECT',
        supporting_observations: ['O2'], contradicting_observations: [], competing_hypotheses: ['H1'], confidence: 'MEDIUM', uncertainty: 'Their answer is unknown.' },
    ],
    unknowns: [{ question: 'Did the partner or bank say no?', why_it_matters: 'A no would make another message unwelcome.' }],
    recommendation: { pursue: 'PURSUE', strategy: 'Answer the viewing request with a concrete time.', psychological_rationale: 'Removes the friction the seller created.',
      based_on_hypotheses: ['H1'], next_action: { type: 'SEND_MESSAGE', text: 'Sorry I missed your Saturday question. Would Saturday at 10 suit you to see the car?' } },
    contact_restrictions: [], reasons_not_to_pursue: [],
  };
  if (variant === 'duplicate-ids') a.observations[1].id = 'O1';
  if (variant === 'missing-reference') a.hypotheses[0].supporting_observations = ['O3', 'O9'];
  return a;
}
function carReview(mid: string, variant: string) {
  return {
    challenges: [{ id: 'C1', target: 'HYPOTHESIS', target_id: 'H1', severity: variant === 'reject' ? 'HIGH' : 'MEDIUM', challenge: 'The silence may not be caused by the seller.',
      evidence: [{ type: 'MESSAGE', message_id: mid, quote: 'Sorry, busy week.' }] }],
    verdict: variant === 'reject' ? 'REJECT_RECOMMENDATION' : 'UPHOLD_WITH_CONCERNS',
    verdict_rationale: variant === 'reject' ? 'Interest after a week of silence is not established.' : 'Plausible, with caveats.',
  };
}
/** The function's fetch: api.moonshot.ai goes to the local mock; everything else as is (Supabase is local). */
const fnFetch: typeof fetch = (i, init) => {
  const u = new URL(i instanceof Request ? i.url : String(i));
  return u.host === 'api.moonshot.ai' ? fetch(new URL(`${u.pathname}${u.search}`, KIMI_URL), init) : fetch(i, init);
};

const fakeEnv = { ANALYSIS_PROVIDER: 'fake', ALLOW_FAKE_PROVIDER: 'staging-only' };
const fnServer = createServer((req, res) => { void (async () => {
  const body = await readBody(req);
  const auth = String(req.headers.authorization ?? '');
  fnCalls.push(fake.tokens.get(auth.replace(/^Bearer /, '')) ?? 'unknown');
  sequence.push(`function ${req.method}`);
  if (knobs.fnMode === 'hang') return;
  if (knobs.fnMode === 'platform-401' || !fake.tokens.has(auth.replace(/^Bearer /, ''))) return send(res, 401, { code: 401, message: 'Invalid JWT' });
  if (knobs.fnMode === 'error-500') return send(res, 500, { message: 'synthetic platform error' });
  // The function's configuration: the platform's own variables + its secrets as they are NOW.
  const conf: Record<string, string> = { SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
    ...(knobs.fnMode === 'stale-config' ? fakeEnv : Object.fromEntries([...knobs.secrets].filter(([k]) => !k.startsWith('SUPABASE_')))) };
  const handler = createAnalyzeCaseHandler({
    env: (k) => conf[k], fetch: fnFetch, log: () => {},
    anthropicClient: (key) => {
      const reply = (answer: unknown) => (b: Record<string, unknown>) => message(answer, { model: b.model });
      const client = new ScriptedClient({
        ANALYST: reply(fakeAnalystAnswer()),
        REVIEWER: knobs.provider === 'reviewer-500' ? Object.assign(new Error('x'), { name: 'InternalServerError', status: 500 }) : reply(fakeReviewAnswer()),
      });
      clients.push({ key, client });
      return client;
    },
  });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const r = await handler(new Request(`http://fn.local${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? body : undefined }));
  const text = await r.text();
  sequence.push('function done');
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(text);
})(); });

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
let MGMT_URL = '';
let FN_URL = '';

const restoreDb = () => sql(`update private.ai_spend_config set enabled = false where id;
  update private.ai_model_prices set active = (model = 'FAKE-PROVIDER-NOT-AI');
  update private.ai_model_prices set input_usd_per_mtok = 0, output_usd_per_mtok = 0 where model = 'FAKE-PROVIDER-NOT-AI';
  update private.ai_model_prices set input_usd_per_mtok = 4, output_usd_per_mtok = 20, max_output_tokens = 8000 where model = 'claude-opus-5-5';
  update private.ai_model_prices set input_usd_per_mtok = 2, output_usd_per_mtok = 10, max_output_tokens = 8000 where model = 'claude-sonnet-5-5';
  insert into private.ai_model_prices (model, input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, active, note)
    values ('kimi-k3', 3, 15, 8000, false, 'test fixture: restored between tests') on conflict (model) do nothing;
  update private.ai_model_prices set input_usd_per_mtok = 3, output_usd_per_mtok = 15, max_output_tokens = 8000 where model = 'kimi-k3';
  delete from private.ai_model_prices where model = 'paid-model-synthetic';
  update private.ai_spend_ledger set status = 'RECONCILED', actual_usd = coalesce(actual_usd, 0), settled_by = 'RECONCILIATION',
    reconciliation_note = 'test fixture: cleared between tests', settled_at = now() where status in ('RESERVED', 'HELD')`);

test.beforeAll(async () => {
  sql('select tests.seed() where not exists (select 1 from public.founders)');
  await fake.start();
  for (const p of ['FOUNDER', 'CLIENT_A', 'CLIENT_B'] as const) fake.passwords.set(ACCOUNTS[`${p}_EMAIL`], ACCOUNTS[`${p}_PASSWORD`]);
  MGMT_URL = await listen(mgmt);
  FN_URL = await listen(fnServer);
  KIMI_URL = await listen(kimiMock);
});
test.afterAll(async () => {
  await fake.stop();
  await new Promise((r) => mgmt.close(r));
  fnServer.closeAllConnections();
  await new Promise((r) => fnServer.close(r));
  await new Promise((r) => kimiMock.close(r));
  restoreDb();
});
test.beforeEach(() => { reset(); fake.requests = []; makeRoomForCase(); restoreDb(); });

// ---------------------------------------------------------------- running the script
type Run = { code: number | null; out: string };
const INPUTS = { PAID_PROVIDER: 'anthropic', PAID_ANALYST_MODEL: SONNET, PAID_REVIEWER_MODEL: SONNET, PROVIDER_LIMIT_USD: '5', RUN_BUDGET_USD: '3' };
/** A Kimi run: the provider, its key, no Anthropic key or model choice. */
const KIMI_INPUTS = { PAID_PROVIDER: 'kimi', KIMI_API_KEY: KIMI_KEY, ANTHROPIC_API_KEY: undefined, PAID_ANALYST_MODEL: undefined, PAID_REVIEWER_MODEL: undefined };
function start(args: string[] = [], over: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ROUTE_SUPABASE: fake.url, ROUTE_FUNCTIONS: FN_URL, ROUTE_MGMT: MGMT_URL };
  for (const [k, v] of Object.entries({ RRE_SUPABASE_URL: `https://${REF}.supabase.co`, RRE_PUBLISHABLE_KEY: PUBLISHABLE, SUPABASE_ACCESS_TOKEN: PAT,
    ANTHROPIC_API_KEY: PROVIDER_KEY, ...INPUTS, ...ACCOUNTS, ...over })) if (v !== undefined) env[k] = v;
  const child = spawn(process.execPath, ['--import', PRELOAD, SCRIPT, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = new Promise<Run>((r) => child.on('exit', (code) => r({ code, out })));
  return { child, done, output: () => out };
}
function run(answers: string[] | null = [LIMIT_OK, RUN_OK], args: string[] = [], over: Record<string, string | undefined> = {}): Promise<Run> {
  const s = start(args, over);
  s.child.stdin.end(answers === null ? '' : `${answers.join('\n')}\n`);
  return s.done;
}
const paidState = () => one(`select (select enabled from private.ai_spend_config where id)::text || ' | ' ||
  (select string_agg(model, ',' order by model) from private.ai_model_prices where active)`);
const secretsOff = () => ![...knobs.secrets.keys()].some((n) => PAID_NAME.test(n)) && knobs.secrets.get('ANALYSIS_PROVIDER') === 'fake' && knobs.secrets.get('ALLOW_FAKE_PROVIDER') === 'staging-only';
const OFF = 'false | FAKE-PROVIDER-NOT-AI';
const lastCase = () => one(`select id from public.cases where reference like 'E2E-PAID-%' order by created_at desc limit 1`);
function noSecrets(out: string) {
  for (const s of [PAT, PROVIDER_KEY, KIMI_KEY, ...Object.values(ACCOUNTS).filter((v) => !v.includes('@')), PUBLISHABLE, ...fake.tokens.keys()]) {
    expect(out, 'a credential was printed').not.toContain(s);
  }
}
const writes = () => mgmtLog.filter((t) => t === 'enable' || t === 'off' || t.startsWith('POST /secrets') || t.startsWith('DELETE /secrets'));

// ---------------------------------------------------------------- the approved run

test('approved run: one paid analysis with the chosen models, everything switched off right after the single call, cost settled', async () => {
  const ledgerBefore = Number(one(`select count(*) from private.ai_spend_ledger`));
  const r = await run();
  if (process.env.E2E_SHOW_OUTPUT) console.log(r.out);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/== \d+ pass, 0 fail, 0 warn/);
  noSecrets(r.out);
  // The order: paid settings -> guarded enable -> ONE call -> off -> settings back to fake; results read only afterwards.
  const i = (x: string) => sequence.indexOf(x);
  expect(i('mgmt POST /secrets')).toBeLessThan(i('mgmt enable'));
  expect(i('mgmt enable')).toBeLessThan(i('function POST'));
  expect(i('function done')).toBeLessThan(i('mgmt off'));
  expect(i('mgmt off')).toBeLessThan(sequence.indexOf('mgmt DELETE /secrets'));
  const iRead = sequence.findIndex((x, n) => n > i('mgmt off') && x.startsWith('supabase GET /rest/v1/analyses'));
  expect(sequence.indexOf('mgmt DELETE /secrets')).toBeLessThan(iRead);
  const inWindow = sequence.slice(i('mgmt enable') + 1, i('mgmt off')).filter((x) => x.startsWith('mgmt') || x.startsWith('function'));
  expect(inWindow, 'only the one function call between switching on and off').toEqual(['function POST', 'function done']);
  expect(mgmtLog.filter((t) => t === 'enable')).toHaveLength(1);
  // Everything is off again; only the fake remains configured; the key is gone.
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
  expect(knobs.secrets.has('ANTHROPIC_API_KEY')).toBe(false);
  // The function got the key through its configuration (only there) and made two calls (two counts).
  expect(fnCalls).toHaveLength(1);
  expect(clients.map((c) => c.key)).toEqual([PROVIDER_KEY]);
  expect(clients[0].client.creates.map((c) => c.body.model)).toEqual([SONNET, SONNET]);
  expect(clients[0].client.counts).toHaveLength(2);
  // One analysis, by the paid models; one ledger row settled at the real (scripted) usage.
  const c = lastCase()!;
  expect(one(`select model from public.analyses where case_id = :'c'`, { c })).toBe(`analyst:${SONNET}|reviewer:${SONNET}`);
  expect(Number(one(`select count(*) from private.ai_spend_ledger`))).toBe(ledgerBefore + 1);
  expect(one(`select l.status || ':' || l.settled_by || ':' || l.actual_usd from private.ai_spend_ledger l join public.analyses a on a.id = l.analysis_id where a.case_id = :'c'`, { c }))
    .toBe('SETTLED:REPORTED_USAGE:0.0228'); // 2 x (1200 x 2 + 900 x 10) micro-dollars
  expect(r.out).toContain('PASS  the analysis was made by the chosen paid models (not the fake)');
  expect(r.out).toContain('PASS  client B: no analysis, audit trail or spending information');
  expect(r.out).not.toMatch(/FAKE PROVIDER|pipeline test/); // no analysis content printed
});

test('approved run with an Opus analyst and a Sonnet reviewer: both models activated, both switched off', async () => {
  const r = await run([LIMIT_OK, RUN_OK], [], { PAID_ANALYST_MODEL: OPUS });
  expect(r.code, r.out).toBe(0);
  expect(clients[0].client.creates.map((c) => c.body.model)).toEqual([OPUS, SONNET]);
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
});

// ---------------------------------------------------------------- confirmations: anything but the exact phrases changes nothing

for (const [name, answers] of [
  ['no limit confirmation', ['', RUN_OK]], ['a lower-case limit confirmation', ['provider-limit-confirmed', RUN_OK]],
  ['the run phrase given as the limit confirmation', [RUN_OK, RUN_OK]], ['no run phrase', [LIMIT_OK, '']], ['the run phrase with an extra character', [LIMIT_OK, `${RUN_OK}X`]],
  ['the run phrase with a typographic dash', [LIMIT_OK, RUN_OK.replace('-', '\u2013')]],
  ['the input ends', []],
] as [string, string[]][]) {
  test(`confirmation: ${name} — nothing is changed`, async () => {
    const r = await run(answers);
    expect(r.code, r.out).toBe(2);
    expect(writes()).toEqual([]);
    expect(paidState()).toBe(OFF);
    expect(secretsOff()).toBe(true);
    expect(fnCalls).toHaveLength(0);
  });
}

test('confirmation: the exact phrases with stray spaces or a carriage return at their ends (Android keyboards) are accepted', async () => {
  const r = await run([` ${LIMIT_OK} `, `${RUN_OK} \r`]);
  expect(r.code, r.out).toBe(0);
  expect(mgmtLog.filter((t) => t === 'enable')).toHaveLength(1);
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
});

// ---------------------------------------------------------------- refusals before anything changes

const refusals: [string, () => Record<string, string | undefined> | void, string][] = [
  ['a provider limit above the USD 15 ceiling', () => ({ PROVIDER_LIMIT_USD: '15.01' }), 'at most USD 15'],
  ['a provider limit below what the run can cost', () => ({ PROVIDER_LIMIT_USD: '0.10' }), 'exceeds the run budget'],
  ['a run budget above USD 3', () => ({ RUN_BUDGET_USD: '3.5' }), 'at most USD 3'],
  ['a run budget below what the run can cost', () => ({ RUN_BUDGET_USD: '0.10' }), 'exceeds the run budget'],
  ['a model off the allowlist', () => ({ PAID_REVIEWER_MODEL: 'claude-opus-4-8' }), 'must each be one of'],
  ['the fake model as the paid model', () => ({ PAID_ANALYST_MODEL: 'FAKE-PROVIDER-NOT-AI' }), 'must each be one of'],
  ['a key of the wrong shape', () => ({ ANTHROPIC_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }), 'not shaped like an Anthropic API key'],
  ['a non-staging project URL', () => ({ RRE_SUPABASE_URL: 'https://productionref00000000000.supabase.co' }), 'refused'],
  ['spending already enabled', () => { sql(`update private.ai_spend_config set enabled = true where id`); }, 'spending is already ENABLED'],
  ['a paid model already active', () => { sql(`update private.ai_model_prices set active = true where model = 'claude-opus-5-5'`); }, 'not exactly FAKE-PROVIDER-NOT-AI'],
  ['a paid price that differs from the reviewed price', () => { sql(`update private.ai_model_prices set input_usd_per_mtok = 3 where model = 'claude-sonnet-5-5'`); }, 'differs from the reviewed price'],
  ['a paid cap that differs from the reviewed cap', () => { sql(`update private.ai_model_prices set max_output_tokens = 9000 where model = 'claude-opus-5-5'`); }, 'differs from the reviewed price'],
  ['an unsettled reservation', () => { sql(`insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model, analyst_input_bound, analyst_max_output, reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price, reviewer_out_price, reserved_usd, status) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', 'y', 1, 1, 1, 1, 0, 0, 0, 0, 0, 'HELD')`); }, 'RESERVED or HELD'],
  ['the deployed function is the old fake-only code', () => { knobs.body = ezbr(oldSources()); }, 'not the reviewed Anthropic-capable version'],
  ['a key-shaped string in the deployed code', () => { knobs.body = ezbr(`${functionSources()}\nconst k = 'sk-ant-api03-${'D'.repeat(40)}';`); }, 'the deployed function is not the reviewed version'],
  ['no paid provider stated', () => ({ PAID_PROVIDER: undefined }), 'PAID_PROVIDER must be exactly one of anthropic, kimi'],
  ['an unknown synthetic scenario', () => ({ PAID_SCENARIO: 'real-customer-chat' }), 'PAID_SCENARIO must be one of car-price, academy-price, too-little, declined'],
  ['an unknown paid provider', () => ({ PAID_PROVIDER: 'openrouter' }), 'PAID_PROVIDER must be exactly one of anthropic, kimi'],
  ['Kimi: a key of the wrong shape (an Anthropic key)', () => ({ ...KIMI_INPUTS, KIMI_API_KEY: PROVIDER_KEY }), 'not shaped like a Kimi API key'],
  ['Kimi: no key', () => ({ ...KIMI_INPUTS, KIMI_API_KEY: undefined }), 'missing environment variable KIMI_API_KEY'],
  ['Kimi: the price row missing', () => { sql(`delete from private.ai_model_prices where model = 'kimi-k3'`); return KIMI_INPUTS; }, 'the price row for kimi-k3 is missing or differs from the reviewed price and cap (Stage 2A-6e)'],
  ['Kimi: a cached-input price instead of the reviewed input price', () => { sql(`update private.ai_model_prices set input_usd_per_mtok = 0.3 where model = 'kimi-k3'`); return KIMI_INPUTS; }, 'differs from the reviewed price'],
  ['Kimi: a larger output cap', () => { sql(`update private.ai_model_prices set max_output_tokens = 16000 where model = 'kimi-k3'`); return KIMI_INPUTS; }, 'differs from the reviewed price'],
  ['Kimi: kimi-k3 already active', () => { sql(`update private.ai_model_prices set active = true where model = 'kimi-k3'`); return KIMI_INPUTS; }, 'not exactly FAKE-PROVIDER-NOT-AI'],
  ['Kimi: a Kimi key already among the settings', () => { knobs.secrets.set('KIMI_API_KEY', 'sk-old'); return KIMI_INPUTS; }, 'already present'],
  ['Kimi: the deployed function lacks the Kimi adapter', () => { knobs.body = ezbr(functionSources().split('api.moonshot.ai').join('api.example.invalid')); return KIMI_INPUTS; }, 'not the reviewed Kimi-capable version (missing: api.moonshot.ai)'],
  ['Kimi: a provider limit below what the run can cost', () => ({ ...KIMI_INPUTS, PROVIDER_LIMIT_USD: '0.30' }), 'exceeds the run budget'],
  ['the JWT check off', () => { knobs.fn = { ...knobs.fn, verify_jwt: false }; }, 'not ACTIVE with verify_jwt ON'],
  ['a provider key already among the settings', () => { knobs.secrets.set('ANTHROPIC_API_KEY', 'sk-ant-old'); }, 'already present'],
  ['ALLOW_PAID_PROVIDER already set', () => { knobs.secrets.set('ALLOW_PAID_PROVIDER', 'staging-only'); }, 'already present'],
];
for (const [name, setup, message_] of refusals) {
  test(`refused before any change: ${name}`, async () => {
    const over = setup() ?? {};
    const secretsBefore = JSON.stringify([...knobs.secrets]);
    const stateBefore = paidState();
    const r = await run([LIMIT_OK, RUN_OK], [], over);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain(message_);
    expect(writes()).toEqual([]);
    expect(JSON.stringify([...knobs.secrets])).toBe(secretsBefore);
    expect(paidState()).toBe(stateBefore);
    expect(fnCalls).toHaveLength(0);
    noSecrets(r.out);
  });
}

test('a token that cannot write function settings: stopped, nothing changed, nothing to undo', async () => {
  knobs.deny.add('POST /secrets');
  const r = await run();
  expect(r.code, r.out).toBe(2);
  expect(r.out).toContain('lacks a permission for POST /secrets');
  expect(mgmtLog).not.toContain('enable');
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
  expect(fnCalls).toHaveLength(0);
});

test('the database guard refuses when the state changed after the audit: no call; the paid settings are removed again', async () => {
  knobs.before.set('enable', () => { sql(`update private.ai_model_prices set active = true where model = 'claude-opus-5-5'`); });
  const r = await run();
  expect(r.code, r.out).toBe(2);
  expect(r.out).toContain('the database refused to activate the model(s) and enable spending');
  expect(fnCalls).toHaveLength(0);
  expect(one(`select enabled::text from private.ai_spend_config where id`)).toBe('false');
  expect(one(`select active::text from private.ai_model_prices where model = 'claude-sonnet-5-5'`)).toBe('false');
  expect(secretsOff()).toBe(true);
});

test('the database guard refuses when someone enabled spending after the audit: no call, their setting left as found, paid settings removed', async () => {
  knobs.before.set('enable', () => { sql(`update private.ai_spend_config set enabled = true where id`); });
  const r = await run();
  expect(r.code, r.out).toBe(2);
  expect(r.out).toContain('the database refused to activate the model(s) and enable spending');
  expect(fnCalls).toHaveLength(0);
  expect(one(`select string_agg(model, ',' order by model) from private.ai_model_prices where active`)).toBe('FAKE-PROVIDER-NOT-AI');
  expect(one(`select enabled::text from private.ai_spend_config where id`)).toBe('true'); // not ours to change
  expect(secretsOff()).toBe(true);
});

// ---------------------------------------------------------------- failures inside the window: always switched off

const windowFailures: [string, () => void, number, string][] = [
  ['the function call errors (HTTP 500)', () => { knobs.fnMode = 'error-500'; }, 1, 'HTTP 500'],
  ['the platform rejects the founder JWT', () => { knobs.fnMode = 'platform-401'; }, 3, 'Do NOT redeploy with --no-verify-jwt'],
  ['the provider fails on the reviewer (usage unknown): the reservation is HELD and reported', () => { knobs.provider = 'reviewer-500'; }, 1, 'HELD: usage unknown'],
  ['the function did not pick up the new settings (ran the fake): reported, cost 0', () => { knobs.fnMode = 'stale-config'; }, 1, 'the function still ran the FAKE'],
  ['the first switch-off attempts fail, a retry succeeds', () => { knobs.fail.set('off', 2); knobs.fail.set('DELETE /secrets', 1); }, 0, 'confirmed by reading them back'],
];
for (const [name, setup, code, message_] of windowFailures) {
  test(`window: ${name} — everything is switched off`, async () => {
    setup();
    const r = await run();
    expect(r.code, r.out).toBe(code);
    expect(r.out).toContain(message_);
    expect(mgmtLog.filter((t) => t === 'enable')).toHaveLength(1);
    expect(fnCalls).toHaveLength(1);
    expect(paidState()).toBe(OFF);
    expect(secretsOff()).toBe(true);
    noSecrets(r.out);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`interrupted during the call (${sig}): everything switched off before exiting`, async () => {
    knobs.fnMode = 'hang';
    const s = start();
    s.child.stdin.end(`${LIMIT_OK}\n${RUN_OK}\n`);
    await expect.poll(() => fnCalls.length, { timeout: 30_000 }).toBe(1);
    expect(paidState()).toBe(`true | FAKE-PROVIDER-NOT-AI,${SONNET}`); // the paid window is open
    expect(knobs.secrets.get('ANALYSIS_PROVIDER')).toBe('anthropic');
    s.child.kill(sig);
    const r = await s.done;
    expect(r.code, r.out).toBe(130);
    expect(paidState()).toBe(OFF);
    expect(secretsOff()).toBe(true);
    noSecrets(r.out);
  });
}

// ---------------------------------------------------------------- failed switch-off, and recovery

test('the database cannot be switched off: exit 4 with the exact SQL (state really still on); --paid-off then fixes it', async () => {
  knobs.fail.set('off', 99);
  knobs.before.set('enable', () => { knobs.fail.set('state', 99); });
  const r = await run();
  expect(r.code, r.out).toBe(4);
  expect(r.out).toContain('ALERT: spending / paid models could NOT be confirmed off');
  expect(r.out).toContain("update private.ai_model_prices set active = false where model in ('claude-opus-5-5', 'claude-sonnet-5-5', 'kimi-k3');");
  expect(r.out.match(/ALERT: spending/g)).toHaveLength(1);
  expect(paidState()).not.toBe(OFF); // honest: it really is still on
  expect(secretsOff()).toBe(true); // the settings part still succeeded
  knobs.fail.clear();
  const rec = await run(null, ['--paid-off'], { RRE_PUBLISHABLE_KEY: undefined, ANTHROPIC_API_KEY: undefined, CLIENT_A_PASSWORD: undefined });
  expect(rec.code, rec.out).toBe(0);
  expect(paidState()).toBe(OFF);
  noSecrets(r.out + rec.out);
});

test('the provider settings cannot be removed: exit 4 with the dashboard steps (key really still set); --paid-off then fixes it', async () => {
  knobs.fail.set('DELETE /secrets', 99);
  const r = await run();
  expect(r.code, r.out).toBe(4);
  expect(r.out).toContain('ALERT: the paid provider settings could NOT be confirmed removed');
  expect(r.out).toContain('revoke the provider key in its console (Anthropic or Kimi)');
  expect(paidState()).toBe(OFF); // the database part succeeded first
  expect(knobs.secrets.has('ANTHROPIC_API_KEY')).toBe(true);
  knobs.fail.clear();
  const rec = await run(null, ['--paid-off'], { RRE_PUBLISHABLE_KEY: undefined, ANTHROPIC_API_KEY: undefined });
  expect(rec.code, rec.out).toBe(0);
  expect(secretsOff()).toBe(true);
  noSecrets(r.out + rec.out);
});

test('--paid-off with nothing to undo changes nothing paid and exits 0; it needs only the access token', async () => {
  const rec = await run(null, ['--paid-off'], { RRE_PUBLISHABLE_KEY: undefined, ANTHROPIC_API_KEY: undefined, FOUNDER_PASSWORD: undefined });
  expect(rec.code, rec.out).toBe(0);
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
  expect(fnCalls).toHaveLength(0);
});

// ---------------------------------------------------------------- Stage 2A-6e: the same guarded run with Kimi

test('approved Kimi run: kimi-k3 for both calls through the mock Moonshot API, everything switched off right after, cost settled at 3/15', async () => {
  const ledgerBefore = Number(one(`select count(*) from private.ai_spend_ledger`));
  const r = await run([LIMIT_OK, RUN_OK], [], KIMI_INPUTS);
  if (process.env.E2E_SHOW_OUTPUT) console.log(r.out);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/== \d+ pass, 0 fail, 0 warn/);
  expect(r.out).toContain('Kimi account of this key holds at most USD 5');
  noSecrets(r.out);
  // Same order as Anthropic: settings -> guarded enable -> ONE call -> off -> settings back to fake.
  const i = (x: string) => sequence.indexOf(x);
  expect(i('mgmt POST /secrets')).toBeLessThan(i('mgmt enable'));
  expect(i('mgmt enable')).toBeLessThan(i('function POST'));
  expect(i('function done')).toBeLessThan(i('mgmt off'));
  expect(i('mgmt off')).toBeLessThan(sequence.indexOf('mgmt DELETE /secrets'));
  expect(mgmtLog.filter((t) => t === 'enable')).toHaveLength(1);
  // Only the Kimi settings were written (no Anthropic key, no model choice), and all are gone again.
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
  expect(knobs.secrets.has('KIMI_API_KEY')).toBe(false);
  expect(clients).toHaveLength(0); // the Anthropic client was never created
  // The function called Moonshot exactly twice (analyst, reviewer), each after a token estimate; key only as Bearer.
  expect(fnCalls).toHaveLength(1);
  expect(kimiSeen.map((k) => k.path)).toEqual(['/v1/tokenizers/estimate-token-count', '/v1/chat/completions', '/v1/tokenizers/estimate-token-count', '/v1/chat/completions']);
  expect(new Set(kimiSeen.map((k) => k.auth))).toEqual(new Set([`Bearer ${KIMI_KEY}`]));
  for (const c of kimiSeen.filter((k) => k.path === '/v1/chat/completions')) {
    expect(c.body).toMatchObject({ model: KIMI, max_completion_tokens: 8000, reasoning_effort: 'low', response_format: { type: 'json_schema', json_schema: { strict: true } } });
    expect(c.body).not.toHaveProperty('max_tokens');
  }
  // One analysis by kimi-k3 (both stages); one ledger row reserved for BOTH calls and settled at 3/15 on ALL prompt tokens.
  const c = lastCase()!;
  expect(one(`select model from public.analyses where case_id = :'c'`, { c })).toBe(`analyst:${KIMI}|reviewer:${KIMI}`);
  expect(Number(one(`select count(*) from private.ai_spend_ledger`))).toBe(ledgerBefore + 1);
  expect(one(`select l.analyst_max_output || '/' || l.reviewer_max_output || ':' || l.status || ':' || l.settled_by || ':' || l.actual_usd from private.ai_spend_ledger l join public.analyses a on a.id = l.analysis_id where a.case_id = :'c'`, { c }))
    .toBe('8000/8000:SETTLED:REPORTED_USAGE:0.0342'); // 2 x (1200 x 3 + 900 x 15) micro-dollars; no cache discount
  expect(Number(one(`select l.reserved_usd from private.ai_spend_ledger l join public.analyses a on a.id = l.analysis_id where a.case_id = :'c'`, { c }))).toBeLessThanOrEqual(1);
  expect(r.out).toContain('PASS  the analysis was made by the chosen paid models (not the fake)');
  expect(r.out).toContain('PASS  client A (case owner): no analysis, audit trail or spending information');
  expect(r.out).toContain('PASS  client B: no analysis, audit trail or spending information');
  expect(r.out).toContain('PASS  anonymous: no analysis, audit trail or spending information');
});

test('Kimi run on another synthetic scenario (PAID_SCENARIO=too-little): that conversation is the one analysed', async () => {
  const r = await run([LIMIT_OK, RUN_OK], [], { ...KIMI_INPUTS, PAID_SCENARIO: 'too-little' });
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('scenario too-little: Almost nothing was said');
  const c = lastCase()!;
  expect(one(`select (position('Hello, how can we help you today?' in body) > 0)::text from public.case_messages where case_id = :'c' and kind = 'PASTED_CONVERSATION'`, { c })).toBe('true');
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
});

test('Kimi window: the provider fails on the reviewer — no retry, the reservation is HELD and reported, everything switched off', async () => {
  knobs.provider = 'reviewer-500';
  const r = await run([LIMIT_OK, RUN_OK], [], KIMI_INPUTS);
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain('HELD: usage unknown — reconcile it against the Kimi (Moonshot) platform console');
  expect(kimiSeen.filter((k) => k.path === '/v1/chat/completions')).toHaveLength(2); // analyst once, reviewer once: no retry
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
  noSecrets(r.out);
});

test('Kimi: interrupted during the call — everything switched off before exiting', async () => {
  knobs.fnMode = 'hang';
  const s = start([], KIMI_INPUTS);
  s.child.stdin.end(`${LIMIT_OK}\n${RUN_OK}\n`);
  await expect.poll(() => fnCalls.length, { timeout: 30_000 }).toBe(1);
  expect(paidState()).toBe(`true | FAKE-PROVIDER-NOT-AI,${KIMI}`);
  expect(knobs.secrets.get('ANALYSIS_PROVIDER')).toBe('kimi');
  s.child.kill('SIGTERM');
  const r = await s.done;
  expect(r.code, r.out).toBe(130);
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
  noSecrets(r.out);
});

test('--paid-off also removes a leftover Kimi key and deactivates kimi-k3', async () => {
  knobs.secrets.set('KIMI_API_KEY', KIMI_KEY); knobs.secrets.set('ALLOW_PAID_PROVIDER', 'staging-only'); knobs.secrets.set('ANALYSIS_PROVIDER', 'kimi');
  sql(`update private.ai_spend_config set enabled = true where id; update private.ai_model_prices set active = true where model = 'kimi-k3'`);
  const rec = await run(null, ['--paid-off'], { RRE_PUBLISHABLE_KEY: undefined, ANTHROPIC_API_KEY: undefined, PAID_PROVIDER: undefined });
  expect(rec.code, rec.out).toBe(0);
  expect(paidState()).toBe(OFF);
  expect(secretsOff()).toBe(true);
  noSecrets(rec.out);
});

// ---------------------------------------------------------------- Stage 2A-6f: contract acceptance of a real-shaped Kimi analysis

test('Kimi: a complete, evidence-grounded analysis passes the database contract — AI ANALYSIS ACCEPTANCE: PASSED', async () => {
  knobs.kimiAnalyst = 'complete'; knobs.kimiReviewer = 'uphold';
  const r = await run([LIMIT_OK, RUN_OK], [], KIMI_INPUTS);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('PASS  a contract-valid analysis was stored (COMPLETE or INSUFFICIENT_EVIDENCE)');
  expect(r.out).toContain('AI ANALYSIS ACCEPTANCE: PASSED');
  expect(r.out).toContain('SAFETY AND CLEANUP: PASSED');
  const c = lastCase()!;
  expect(one(`select status || ':' || (output->'observations'->0->>'id') || ':' || (output->>'contract_version') from public.analyses where case_id = :'c'`, { c })).toBe('COMPLETE:O1:rre-analysis/2');
  expect(r.out).not.toContain('evidence-grounded'); // the analysis content is never printed
});

test('Kimi: the review rejects the recommendation — still a contract-valid analysis (no message kept)', async () => {
  knobs.kimiAnalyst = 'complete'; knobs.kimiReviewer = 'reject';
  const r = await run([LIMIT_OK, RUN_OK], [], KIMI_INPUTS);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('COMPLETED / RECOMMENDATION_REJECTED_BY_REVIEW');
  expect(r.out).toContain('AI ANALYSIS ACCEPTANCE: PASSED');
  const c = lastCase()!;
  expect(one(`select status || ':' || coalesce(ai_proposed_message, 'none') from public.analyses where case_id = :'c'`, { c })).toBe('COMPLETE:none');
});

for (const [variant, reason] of [
  ['duplicate-ids', 'observation ids must be unique and look like O1, O2, ...'],
  ['missing-reference', 'hypotheses[0] refers to an observation that does not exist'],
] as const) {
  test(`Kimi: an analysis with ${variant} is rejected by the database contract — reported as a FAILED run, with cleanup and access still verified`, async () => {
    knobs.kimiAnalyst = variant; knobs.kimiReviewer = 'uphold';
    const r = await run([LIMIT_OK, RUN_OK], [], KIMI_INPUTS);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('FAIL  the founder call completed an analysis — HTTP 200 REJECTED / CONTRACT_REJECTED');
    expect(r.out).toContain('FAIL  a contract-valid analysis was stored (COMPLETE or INSUFFICIENT_EVIDENCE) — status ERROR');
    expect(r.out).toContain(`why it was not accepted: REJECTED by analysis contract rre-analysis/1: ${reason}`);
    expect(r.out).toContain('AI ANALYSIS ACCEPTANCE: FAILED — no contract-valid analysis from this run');
    expect(r.out).toContain('SAFETY AND CLEANUP: PASSED');
    // Money: the two calls were billed and settled from reported usage; nothing left on.
    expect(r.out).toContain('PASS  settled from reported usage (not HELD); actual within the reservation; no overrun');
    expect(paidState()).toBe(OFF);
    expect(secretsOff()).toBe(true);
    // Nothing of the rejected output is kept, and businesses still see nothing.
    const c = lastCase()!;
    expect(one(`select status || ':' || (output is null)::text from public.analyses where case_id = :'c'`, { c })).toBe('ERROR:true');
    expect(r.out).toContain('PASS  client A (case owner): no analysis, audit trail or spending information');
    expect(r.out).toContain('PASS  client B: no analysis, audit trail or spending information');
    noSecrets(r.out);
  });
}

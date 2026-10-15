// Stage 2A-5d-4d — the guarded fake-provider end-to-end script
// (supabase/scripts/fake-pipeline-e2e.mjs) run as a real child process against the REAL
// local test database:
//   * Supabase Auth/PostgREST: tests/pipeline/fakeSupabase.ts (queries run as the caller's
//     role, so RLS and grants decide);
//   * the Edge Function: the real analyze-case handler (fake provider) behind an emulated
//     platform JWT check;
//   * the Management API: a local emulator that executes the script's SQL as the database
//     owner (like the real endpoint) and serves function metadata, the function body (the
//     real function sources, EZBR/brotli-encoded like a CLI deployment) and secret names.
// A preload routes only those hosts to these servers and refuses every other host.
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
import { FakeSupabase, PUBLISHABLE, SECRET } from './fakeSupabase';
import { makeRoomForCase, one, sql } from './psqlDb';

const SCRIPT = fileURLToPath(new URL('../../supabase/scripts/fake-pipeline-e2e.mjs', import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./fixtures/route-to-local.mjs', import.meta.url))).href;
const FUNCTIONS_DIR = fileURLToPath(new URL('../../supabase/functions', import.meta.url));
const REF = 'aqwdwswpmbnzmkvyuqil';
const PAT = `sbp_${randomBytes(20).toString('hex')}`;
const PHRASE = 'ENABLE-FAKE-SPENDING';
const ACCOUNTS = {
  FOUNDER_EMAIL: 'founder@synthetic.test', FOUNDER_PASSWORD: `founder-${randomBytes(6).toString('hex')}`,
  CLIENT_A_EMAIL: 'client-a@synthetic.test', CLIENT_A_PASSWORD: `client-a-${randomBytes(6).toString('hex')}`,
  CLIENT_B_EMAIL: 'client-b@synthetic.test', CLIENT_B_PASSWORD: `client-b-${randomBytes(6).toString('hex')}`,
};
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- local servers
const fake = new FakeSupabase();
const sequence: string[] = [];
fake.sequence = sequence;

/** Every file under supabase/functions, as a deployment bundle would contain it. */
function functionSources(dir = FUNCTIONS_DIR): string {
  return readdirSync(dir).sort().map((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? functionSources(p) : `// ${p}\n${readFileSync(p, 'utf8')}`;
  }).join('\n');
}
/**
 * Stage 2A-6b: the function sources as DEPLOYED on staging (commit 9ee3767, the last change to
 * supabase/functions before 2A-6b). The working tree now carries the Anthropic adapter, which this
 * script must refuse (see the test below); the fake run is verified against what is deployed.
 */
const DEPLOYED_COMMIT = '9ee3767';
function deployedSources(): string {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: FUNCTIONS_DIR, encoding: 'utf8', maxBuffer: 20_000_000 });
  return git('ls-tree', '-r', '--name-only', DEPLOYED_COMMIT, '--', '.').split('\n').filter(Boolean).sort()
    .map((f) => `// ${f}\n${git('show', `${DEPLOYED_COMMIT}:./${f}`)}`).join('\n');
}
const ezbr = (text: string) => Buffer.concat([Buffer.from('EZBR'), brotliCompressSync(Buffer.from(text))]);

interface Knobs {
  /** Management API: SQL statement tags or routes answered 403 (missing permission). */
  deny: Set<string>;
  /** Management API: tags or routes answered 500, as many times as given. */
  fail: Map<string, number>;
  /** Management API: run before a tagged statement executes. */
  before: Map<string, () => void>;
  tokenRejected: boolean;
  fn: Record<string, unknown>;
  body: Buffer;
  secrets: { name: string; value: string }[];
  /** Edge Function: 'hang' | 'platform-401' | 'error-500' | null */
  fnMode: string | null;
}
let knobs: Knobs;
const mgmtLog: string[] = [];
const fnCalls: string[] = [];

function reset() {
  const body = ezbr(deployedSources());
  knobs = {
    deny: new Set(), fail: new Map(), before: new Map(), tokenRejected: false,
    fn: { id: 'fn-1', slug: 'analyze-case', name: 'analyze-case', status: 'ACTIVE', version: 3, verify_jwt: true, ezbr_sha256: sha(body) },
    body,
    secrets: [{ name: 'ALLOW_FAKE_PROVIDER', value: sha('staging-only') }, { name: 'ANALYSIS_PROVIDER', value: sha('fake') },
      { name: 'SUPABASE_URL', value: sha('x') }, { name: 'SUPABASE_SECRET_KEYS', value: sha('y') }],
    fnMode: null,
  };
  mgmtLog.length = 0; fnCalls.length = 0; sequence.length = 0;
}
reset();

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = async (req: IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c).toString('utf8'); };

const mgmt = createServer((req, res) => { void (async () => {
  const u = new URL(req.url ?? '/', 'http://x');
  const route = u.pathname.replace(`/v1/projects/${REF}`, '');
  if (!u.pathname.startsWith(`/v1/projects/${REF}`)) return send(res, 404, { message: 'project not found' });
  if (knobs.tokenRejected || req.headers.authorization !== `Bearer ${PAT}`) return send(res, 401, { message: 'Unauthorized' });
  let tag = route;
  let query = '';
  if (route === '/database/query' && req.method === 'POST') {
    query = (JSON.parse(await readBody(req)) as { query: string }).query;
    tag = /^\/\* rre:([a-z]+) \*\//.exec(query)?.[1] ?? 'untagged';
  }
  mgmtLog.push(tag);
  sequence.push(`mgmt ${tag}`);
  if (knobs.deny.has(tag)) return send(res, 403, { message: 'Forbidden', missing_permissions: [tag === 'enable' || tag === 'disable' ? 'database_write' : 'database_read'] });
  const f = knobs.fail.get(tag) ?? 0;
  if (f > 0) { knobs.fail.set(tag, f - 1); return send(res, 500, { message: 'synthetic failure' }); }
  if (route === '/database/query') {
    if (tag === 'untagged') return send(res, 400, { message: 'only the script\'s tagged statements are expected' });
    knobs.before.get(tag)?.();
    try {
      const rows = sql(`with t as (${query.replace(/;\s*$/, '')}) select coalesce(json_agg(t), '[]') from t`);
      return send(res, 201, JSON.parse(rows.join('\n') || '[]'));
    } catch (e) { return send(res, 400, { message: (e as Error).message }); }
  }
  if (route === '/functions/analyze-case' && req.method === 'GET') return send(res, 200, knobs.fn);
  if (route === '/functions/analyze-case/body' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(knobs.body); return; }
  if (route === '/secrets' && req.method === 'GET') return send(res, 200, knobs.secrets);
  return send(res, 404, { message: 'not found' });
})(); });

let handler: (r: Request) => Promise<Response>;
const fnServer = createServer((req, res) => { void (async () => {
  const body = await readBody(req);
  const auth = String(req.headers.authorization ?? '');
  fnCalls.push(fake.tokens.get(auth.replace(/^Bearer /, '')) ?? 'unknown');
  sequence.push(`function ${req.method}`);
  if (knobs.fnMode === 'hang') return; // never answers
  // The platform's verify_jwt: only real session tokens pass.
  if (knobs.fnMode === 'platform-401' || !fake.tokens.has(auth.replace(/^Bearer /, ''))) return send(res, 401, { code: 401, message: 'Invalid JWT' });
  if (knobs.fnMode === 'error-500') return send(res, 500, { message: 'synthetic platform error' });
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

test.beforeAll(async () => {
  sql('select tests.seed() where not exists (select 1 from public.founders)');
  await fake.start();
  for (const p of ['FOUNDER', 'CLIENT_A', 'CLIENT_B'] as const) fake.passwords.set(ACCOUNTS[`${p}_EMAIL`], ACCOUNTS[`${p}_PASSWORD`]);
  MGMT_URL = await listen(mgmt);
  FN_URL = await listen(fnServer);
  handler = createAnalyzeCaseHandler({
    env: (k) => ({ SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
      ANALYSIS_PROVIDER: 'fake', ALLOW_FAKE_PROVIDER: 'staging-only' } as Record<string, string>)[k],
    fetch: (i, init) => fetch(i, init), log: () => {},
  });
});
test.afterAll(async () => {
  await fake.stop();
  await new Promise((r) => mgmt.close(r));
  fnServer.closeAllConnections();
  await new Promise((r) => fnServer.close(r));
  sql(`update private.ai_spend_config set enabled = false where id`);
});
test.beforeEach(() => {
  reset();
  fake.requests = [];
  makeRoomForCase();
  // Staging's state: spending off, the free fake the only active priced model.
  sql(`update private.ai_spend_config set enabled = false where id;
       update private.ai_model_prices set active = (model = 'FAKE-PROVIDER-NOT-AI');
       update private.ai_model_prices set input_usd_per_mtok = 0, output_usd_per_mtok = 0 where model = 'FAKE-PROVIDER-NOT-AI';
       delete from private.ai_model_prices where model = 'paid-model-synthetic'`);
});

// ---------------------------------------------------------------- running the script
type Run = { code: number | null; out: string };
function start(args: string[] = [], over: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ROUTE_SUPABASE: fake.url, ROUTE_FUNCTIONS: FN_URL, ROUTE_MGMT: MGMT_URL };
  for (const [k, v] of Object.entries({ RRE_SUPABASE_URL: `https://${REF}.supabase.co`, RRE_PUBLISHABLE_KEY: PUBLISHABLE, SUPABASE_ACCESS_TOKEN: PAT, ...ACCOUNTS, ...over })) {
    if (v !== undefined) env[k] = v;
  }
  const child = spawn(process.execPath, ['--import', PRELOAD, SCRIPT, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = new Promise<Run>((r) => child.on('exit', (code) => r({ code, out })));
  return { child, done, output: () => out };
}
async function run(answer: string | null = PHRASE, args: string[] = [], over: Record<string, string | undefined> = {}): Promise<Run> {
  const s = start(args, over);
  s.child.stdin.end(answer === null ? '' : `${answer}\n`);
  return s.done;
}
const enabled = () => one(`select enabled from private.ai_spend_config where id`);
const lastCase = () => one(`select id from public.cases where reference like 'E2E-FAKE-%' order by created_at desc limit 1`);
function noSecrets(out: string) {
  for (const s of [PAT, ...Object.values(ACCOUNTS).filter((v) => !v.includes('@')), PUBLISHABLE, ...fake.tokens.keys()]) expect(out, 'a credential was printed').not.toContain(s);
}

// ---------------------------------------------------------------- the real thing, end to end

test('approved run: one case, one analysis, spending enabled only around the single call, everything verified, zero spend', async () => {
  const ledgerBefore = Number(one(`select count(*) from private.ai_spend_ledger`));
  const r = await run();
  if (process.env.E2E_SHOW_OUTPUT) console.log(r.out); // to read a full run locally
  expect(r.out).toMatch(/== \d+ pass, 0 fail/);
  expect(r.out).not.toMatch(/^FAIL/m);
  expect(r.code, r.out).toBe(0);
  noSecrets(r.out);
  expect(enabled()).toBe('f');
  // Exactly one enable, then a disable before anything else touched the database.
  expect(mgmtLog.filter((t) => t === 'enable')).toHaveLength(1);
  const iEnable = sequence.indexOf('mgmt enable');
  const iCall = sequence.indexOf('function POST');
  const iDone = sequence.indexOf('function done');
  const iDisable = sequence.indexOf('mgmt disable');
  const iFirstRead = sequence.findIndex((x, i) => i > iDone && x.startsWith('supabase GET /rest/v1/analyses'));
  expect(iEnable).toBeGreaterThan(-1);
  expect(iEnable).toBeLessThan(iCall);
  expect(iDone).toBeLessThan(iDisable);
  expect(iDisable).toBeLessThan(iFirstRead); // results are read only after spending is off
  const inWindow = sequence.slice(iEnable + 1, iDisable);
  expect(inWindow.filter((x) => x.startsWith('mgmt')), 'no other Management API call inside the window').toEqual([]);
  expect(inWindow.filter((x) => x.startsWith('function')), 'exactly one function call inside the window').toEqual(['function POST', 'function done']);
  // One founder call, one case, one analysis, one new ledger row at USD 0.
  expect(fnCalls).toHaveLength(1);
  const c = lastCase()!;
  expect(one(`select count(*) from public.analyses where case_id = :'c'`, { c })).toBe('1');
  expect(Number(one(`select count(*) from private.ai_spend_ledger`))).toBe(ledgerBefore + 1);
  expect(one(`select l.status || ':' || l.settled_by || ':' || l.actual_usd || ':' || l.reserved_usd from private.ai_spend_ledger l join public.analyses a on a.id = l.analysis_id where a.case_id = :'c'`, { c }))
    .toBe('SETTLED:REPORTED_USAGE:0.0000:0.0000');
  expect(one(`select workflow_state from public.cases where id = :'c'`, { c })).toBe('AWAITING_ADMIN_REVIEW');
  expect(one(`select conversation_source || ':' || lead_source from public.cases where id = :'c'`, { c })).toBe('TEXT:Other');
  expect(r.out).toContain('PASS  audit trail, in order: created, submitted, started, reserved, completed, settled');
  expect(r.out).toContain('PASS  client B: the analysis is invisible');
});

test('Stage 2A-6d: the fake regression run passes against the reviewed Anthropic-capable code (fake settings, no key)', async () => {
  knobs.body = ezbr(functionSources());
  knobs.fn = { ...knobs.fn, ezbr_sha256: sha(knobs.body) };
  const r = await run();
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('PASS  deployed source: the reviewed Anthropic-capable version (fake provider configured), spending controls present');
  expect(r.out).toMatch(/== \d+ pass, 0 fail/);
  expect(enabled()).toBe('f');
  noSecrets(r.out);
});

// ---------------------------------------------------------------- approval

for (const answer of ['', 'yes', 'enable-fake-spending', ' ENABLE-FAKE-SPENDING', 'ENABLE-FAKE-SPENDING ', 'ENABLE FAKE SPENDING']) {
  test(`approval: ${JSON.stringify(answer)} is not the exact phrase — spending is never touched`, async () => {
    const r = await run(answer);
    expect(r.code).toBe(2);
    expect(r.out).toContain('not approved: spending was not touched');
    expect(mgmtLog).not.toContain('enable');
    expect(fnCalls).toEqual([]);
    expect(enabled()).toBe('f');
  });
}

// ---------------------------------------------------------------- refusals before enabling

const preflightRefusals: [string, () => void, string][] = [
  ['another active priced model', () => sql(`insert into private.ai_model_prices values ('paid-model-synthetic', 3, 15, 4000, true, 'synthetic paid')`), 'are not exactly FAKE-PROVIDER-NOT-AI'],
  ['the fake priced above zero', () => sql(`update private.ai_model_prices set input_usd_per_mtok = 0.5 where model = 'FAKE-PROVIDER-NOT-AI'`), 'are not exactly FAKE-PROVIDER-NOT-AI'],
  ['the fake model inactive', () => sql(`update private.ai_model_prices set active = false where model = 'FAKE-PROVIDER-NOT-AI'`), 'are not exactly FAKE-PROVIDER-NOT-AI'],
  ['spending already enabled', () => sql(`update private.ai_spend_config set enabled = true where id`), 'spending is already ENABLED. Not touching it'],
  ['verify_jwt off on the deployed function', () => { knobs.fn.verify_jwt = false; }, 'is not ACTIVE with verify_jwt ON'],
  ['the function not ACTIVE', () => { knobs.fn.status = 'THROTTLED'; }, 'is not ACTIVE with verify_jwt ON'],
  ['provider SDK in the deployed source', () => { knobs.body = ezbr(`${deployedSources()}\nimport Anthropic from '@anthropic-ai/sdk';`); }, 'DEPLOYED function source contains an AI-provider SDK'],
  ['the Anthropic-capable code with a key-shaped string in it', () => { knobs.body = ezbr(`${functionSources()}\nconst k = 'sk-ant-api03-${'E'.repeat(40)}';`); }, 'DEPLOYED function source contains an AI-provider SDK'],
  ['the Anthropic-capable code missing a reviewed safeguard', () => { knobs.body = ezbr(functionSources().replaceAll('CAP_NOT_APPROVED', 'X')); }, 'DEPLOYED function source contains an AI-provider SDK'],
  ['ALLOW_PAID_PROVIDER among the function secrets', () => { knobs.secrets.push({ name: 'ALLOW_PAID_PROVIDER', value: sha('staging-only') }); }, 'include an AI-provider key name'],
  ['a paid model choice among the function secrets', () => { knobs.secrets.push({ name: 'ANALYST_MODEL', value: sha('claude-opus-5-5') }); }, 'include an AI-provider key name'],
  ['an unreadable deployed source', () => { knobs.body = Buffer.from('EZBR not brotli at all'); }, 'could not be read to verify it'],
  ['a deployed version without spending controls', () => { knobs.body = ezbr("const FAKE = 'FAKE-PROVIDER-NOT-AI'; // old version"); }, 'not the reviewed version'],
  ['a provider key among the function secrets', () => { knobs.secrets.push({ name: 'ANTHROPIC_API_KEY', value: sha('x') }); }, 'include an AI-provider key name'],
  ['the fake settings missing', () => { knobs.secrets = knobs.secrets.filter((s) => s.name !== 'ALLOW_FAKE_PROVIDER'); }, 'are missing'],
  ['a token without database read', () => { knobs.deny.add('probe'); }, 'lacks a permission for POST /database/query: database_read'],
  ['a token without Edge Functions read', () => { knobs.deny.add('/functions/analyze-case'); }, 'lacks a permission for GET /functions/analyze-case'],
  ['a token without secrets read', () => { knobs.deny.add('/secrets'); }, 'lacks a permission for GET /secrets'],
  ['a rejected token', () => { knobs.tokenRejected = true; }, 'access token was rejected (401)'],
  ['the Management API failing', () => { knobs.fail.set('state', 1); }, 'answered HTTP 500'],
];
for (const [name, setup, message] of preflightRefusals) {
  test(`refuses before enabling: ${name}`, async () => {
    setup();
    const wasEnabled = enabled();
    const r = await run();
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain(message);
    expect(mgmtLog).not.toContain('enable');
    expect(fnCalls).toEqual([]);
    expect(enabled()).toBe(wasEnabled); // untouched (an already-enabled state is reported, never changed)
    noSecrets(r.out);
  });
}

test('the database guard itself refuses: a paid model appearing just before enabling keeps spending off', async () => {
  knobs.before.set('enable', () => sql(`insert into private.ai_model_prices values ('paid-model-synthetic', 3, 15, 4000, true, 'synthetic paid')`));
  const r = await run();
  expect(r.code, r.out).toBe(2);
  expect(r.out).toContain('the database refused to enable spending');
  expect(enabled()).toBe('f');
  expect(fnCalls).toEqual([]);
});

test('the database guard refuses when someone else enabled spending after the audit: no call, and their setting is left as found', async () => {
  knobs.before.set('enable', () => sql(`update private.ai_spend_config set enabled = true where id`));
  const r = await run();
  expect(r.code, r.out).toBe(2);
  expect(r.out).toContain('the database refused to enable spending');
  expect(fnCalls).toEqual([]);
  expect(mgmtLog).not.toContain('disable');
  expect(enabled()).toBe('t');
});

test('a token without database WRITE: enabling is refused; spending confirmed off; no call made', async () => {
  knobs.deny.add('enable');
  knobs.deny.add('disable');
  const r = await run();
  expect(r.code, r.out).toBe(2);
  expect(r.out).toContain('lacks a permission for POST /database/query: database_write');
  expect(r.out).toContain('spending is DISABLED (confirmed by reading it back)');
  expect(r.out).not.toContain('ALERT');
  expect(fnCalls).toEqual([]);
  expect(enabled()).toBe('f');
});

// ---------------------------------------------------------------- failures inside the window: always restored

const windowFailures: [string, () => void, number, string][] = [
  ['the function call errors (HTTP 500)', () => { knobs.fnMode = 'error-500'; }, 1, 'HTTP 500'],
  ['the platform rejects the founder JWT', () => { knobs.fnMode = 'platform-401'; }, 3, 'Do NOT redeploy with --no-verify-jwt'],
  ['the first disable attempt fails, a retry succeeds', () => { knobs.fail.set('disable', 1); knobs.fnMode = 'error-500'; }, 1, 'spending is DISABLED (confirmed'],
];
for (const [name, setup, code, message] of windowFailures) {
  test(`window failure restores spending: ${name}`, async () => {
    setup();
    const r = await run();
    expect(r.code, r.out).toBe(code);
    expect(r.out).toContain(message);
    expect(mgmtLog.filter((t) => t === 'enable')).toHaveLength(1);
    expect(enabled()).toBe('f');
    expect(fnCalls.length).toBeLessThanOrEqual(1);
    noSecrets(r.out);
  });
}

test('failed restoration is reported loudly (exit 4) with the exact SQL — and the state really is still enabled', async () => {
  knobs.fail.set('disable', 99);
  knobs.fail.set('state', 0);
  knobs.before.set('enable', () => { knobs.fail.set('state', 99); }); // after enabling, nothing can be confirmed
  const r = await run();
  expect(r.code, r.out).toBe(4);
  expect(r.out).toContain('ALERT: spending could NOT be confirmed disabled');
  expect(r.out).toContain('update private.ai_spend_config set enabled = false, updated_at = now() where id;');
  expect(r.out).toContain('--disable-spending-only');
  expect(r.out.match(/ALERT/g)).toHaveLength(1); // not repeated on exit
  expect(enabled()).toBe('t'); // honest: it really is still on
  // The recovery command then fixes it.
  knobs.fail.clear();
  const rec = await run(null, ['--disable-spending-only'], { RRE_PUBLISHABLE_KEY: undefined, CLIENT_A_PASSWORD: undefined });
  expect(rec.code, rec.out).toBe(0);
  expect(enabled()).toBe('f');
  noSecrets(r.out + rec.out);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`interrupted during the call (${sig}): spending is disabled and sessions signed out before exiting`, async () => {
    knobs.fnMode = 'hang';
    const s = start();
    s.child.stdin.end(`${PHRASE}\n`);
    await expect.poll(() => fnCalls.length, { timeout: 30_000 }).toBe(1);
    expect(enabled()).toBe('t');
    s.child.kill(sig);
    const r = await s.done;
    expect(r.code, r.out).toBe(130);
    expect(r.out).toContain(`interrupted (${sig}): disabling spending`);
    expect(enabled()).toBe('f');
    expect(r.out).toMatch(/FOUNDER: signed out \(this session only\)/);
  });
}

test('interrupted at the approval prompt: nothing enabled, sessions signed out', async () => {
  const s = start();
  await expect.poll(() => s.output(), { timeout: 30_000 }).toContain(`Type ${PHRASE}`);
  s.child.kill('SIGINT');
  const r = await s.done;
  expect(r.code).toBe(130);
  expect(r.out).not.toContain('disabling spending');
  expect(mgmtLog).not.toContain('enable');
  expect(enabled()).toBe('f');
});

// ---------------------------------------------------------------- what the checks catch after the call

test('a business able to read analyses is reported as FAIL (exit 1), with spending already off', async () => {
  sql(`create policy e2e_leak on public.analyses for select to authenticated using (true)`);
  try {
    const r = await run();
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/^FAIL  client A \(case owner\): the analysis is invisible/m);
    expect(r.out).toMatch(/^FAIL  client B: the analysis is invisible/m);
    expect(enabled()).toBe('f');
  } finally {
    sql(`drop policy e2e_leak on public.analyses`);
  }
});

test('non-zero recorded spend is reported as FAIL', async () => {
  knobs.before.set('ledger', () => sql(`update private.ai_spend_ledger set actual_usd = 0.0001 where analysis_id = (select id from public.analyses order by created_at desc limit 1)`));
  const r = await run();
  expect(r.code, r.out).toBe(1);
  expect(r.out).toMatch(/^FAIL  ledger: SETTLED from reported usage, reserved 0, actual 0, no overrun/m);
});

// ---------------------------------------------------------------- recovery-only command and guards

test('recovery-only: turns spending off and changes nothing else; needs only the access token', async () => {
  sql(`update private.ai_spend_config set enabled = true where id`);
  const before = one(`select count(*) || '/' || (select count(*) from public.cases) from private.ai_spend_ledger`);
  const r = await run(null, ['--disable-spending-only'], { RRE_SUPABASE_URL: undefined, RRE_PUBLISHABLE_KEY: undefined, FOUNDER_PASSWORD: undefined, CLIENT_A_PASSWORD: undefined, CLIENT_B_PASSWORD: undefined });
  expect(r.code, r.out).toBe(0);
  expect(enabled()).toBe('f');
  expect(mgmtLog).toEqual(['disable', 'state']);
  expect(one(`select count(*) || '/' || (select count(*) from public.cases) from private.ai_spend_ledger`)).toBe(before);
  noSecrets(r.out);
});

test('recovery-only without database write: reports exit 4 unless the state already reads disabled', async () => {
  sql(`update private.ai_spend_config set enabled = true where id`);
  knobs.deny.add('disable');
  const r = await run(null, ['--disable-spending-only']);
  expect(r.code).toBe(4);
  expect(r.out).toContain('ALERT');
  expect(enabled()).toBe('t');
  sql(`update private.ai_spend_config set enabled = false where id`);
  const r2 = await run(null, ['--disable-spending-only']);
  expect(r2.code).toBe(0);
});

for (const [name, over, message] of [
  ['a secret key instead of an access token', { SUPABASE_ACCESS_TOKEN: ['sb', 'secret', 'SyntheticTestOnly0123456789'].join('_') }, 'not a Supabase personal access token'],
  ['another project URL', { RRE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }, 'this is not the staging project'],
  ['a missing password', { FOUNDER_PASSWORD: undefined }, 'missing environment variable FOUNDER_PASSWORD'],
] as [string, Record<string, string | undefined>, string][]) {
  test(`refuses ${name} before any request`, async () => {
    const r = await run(PHRASE, [], over);
    expect(r.code).toBe(2);
    expect(r.out).toContain(message);
    expect(mgmtLog).toEqual([]);
    expect(fake.requests.length).toBe(0);
  });
}

test('a token pasted with invisible characters at its ends (carriage return, byte-order mark) is trimmed and used as is', async () => {
  const r = await run(null, [], { SUPABASE_ACCESS_TOKEN: `\ufeff${PAT}\r` });
  expect(r.out).not.toContain('not a Supabase personal access token');
  expect(mgmtLog.length).toBeGreaterThan(0); // the Management API accepted exactly the trimmed token
  expect(r.code).toBe(2); // no approval typed: nothing enabled
  expect(enabled()).toBe('f');
  expect(r.out).not.toContain(PAT);
});

test('a token with a hyphen inside is refused before any request; the reason names the character kind, never the token', async () => {
  const bad = `${PAT.slice(0, 12)}-${PAT.slice(12)}`;
  const r = await run(PHRASE, [], { SUPABASE_ACCESS_TOKEN: bad });
  expect(r.code).toBe(2);
  expect(r.out).toContain('not a Supabase personal access token (sbp_…): it contains a hyphen at character 13');
  expect(r.out).not.toContain(PAT.slice(4, 12));
  expect(mgmtLog).toEqual([]);
});

test('the script contains only its fixed SQL: two writes (guarded enable, disable), everything else reads', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  expect(src.match(/update private\.ai_spend_config/g)).toHaveLength(3); // enable, disable, and the printed restore SQL
  expect(src).not.toMatch(/\b(insert|delete|truncate|drop|alter|grant|create)\s+(into|from|table|policy|function|on)\b/i);
  expect(src).not.toMatch(/writeFile|appendFile|createWriteStream/);
  expect(src).toContain("signOut({ scope: 'local' })");
});

// The durable paid-staging tool (supabase/scripts/paid-staging.mjs), run for real against the
// LOCAL test database through a fake Supabase Management API (its SQL runs in that database, as
// the real endpoint runs it in staging), a fake platform in front of the function, and a fake
// copy of the staging site. The preload routes only those hosts: the Kimi API is unreachable, so
// any provider call would fail the test. Synthetic data only.

import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
// @ts-expect-error plain ES module without type declarations
import { ACTIVATE_SQL, DEACTIVATE_SQL, schemaProblem } from '../../supabase/scripts/paid-staging.mjs';
import { makeRoomForCase, one, sql } from './psqlDb';

const SCRIPT = fileURLToPath(new URL('../../supabase/scripts/paid-staging.mjs', import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./fixtures/route-to-local.mjs', import.meta.url))).href;
const FUNCTIONS_DIR = fileURLToPath(new URL('../../supabase/functions', import.meta.url));
const REF = 'aqwdwswpmbnzmkvyuqil';
const PAT = `sbp_${randomBytes(20).toString('hex')}`;
const KIMI_KEY = `sk-TESTONLY${randomBytes(16).toString('hex')}`;
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

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
const CURRENT_BODY = ezbr(functionSources());

const FRONTEND_JS = 'const a="Run paid analysis";const b="This will run one paid AI analysis and one independent AI review. The total permitted cost is capped at $1.";rpc("founder_ai_spend_summary");';
const knobs = {
  secrets: new Map<string, string>(),
  fn: { status: 'ACTIVE', verify_jwt: true, version: 42, updated_at: 1 } as Record<string, unknown>,
  body: CURRENT_BODY,
  frontendJs: FRONTEND_JS,
};
const mgmtLog: string[] = [];
const fnRequests: { auth: boolean }[] = [];
function reset() {
  knobs.secrets = new Map([['ANALYSIS_PROVIDER', 'fake'], ['ALLOW_FAKE_PROVIDER', 'staging-only']]);
  knobs.fn = { status: 'ACTIVE', verify_jwt: true, version: 42, updated_at: 1 };
  knobs.body = CURRENT_BODY;
  knobs.frontendJs = FRONTEND_JS;
  mgmtLog.length = 0;
  fnRequests.length = 0;
}

const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b)); });
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

/** The Management API: SQL runs in the local test database as its owner (like the real endpoint). */
const mgmt = createServer((req, res) => { void (async () => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (!u.pathname.startsWith(`/v1/projects/${REF}`)) return send(res, 404, { message: 'project not found' });
  if (req.headers.authorization !== `Bearer ${PAT}`) return send(res, 401, { message: 'Unauthorized' });
  const route = u.pathname.replace(`/v1/projects/${REF}`, '');
  const raw = await readBody(req);
  if (route === '/database/query' && req.method === 'POST') {
    const query = (JSON.parse(raw) as { query: string }).query;
    const tag = /^\/\* rre:([a-z]+) \*\//.exec(query)?.[1] ?? 'untagged';
    mgmtLog.push(tag);
    const body = query.replace(/^\/\*[^*]*\*\/\s*/, '');
    try {
      if (/^do \$rre\$/.test(body)) { sql(body); return send(res, 201, []); }
      const rows = sql(`select coalesce(json_agg(t), '[]') from (${body}) t`);
      return send(res, 201, JSON.parse(rows.join('\n') || '[]'));
    } catch (e) { return send(res, 400, { message: (e as Error).message }); }
  }
  mgmtLog.push(`${req.method} ${route}`);
  if (route === '/functions/analyze-case' && req.method === 'GET') return send(res, 200, knobs.fn);
  if (route === '/functions/analyze-case/body' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(knobs.body); return; }
  if (route === '/secrets' && req.method === 'GET') return send(res, 200, [...knobs.secrets].map(([name, value]) => ({ name, value: sha(value) })));
  if (route === '/secrets' && req.method === 'POST') { for (const s of JSON.parse(raw) as { name: string; value: string }[]) knobs.secrets.set(s.name, s.value); return send(res, 201, undefined); }
  if (route === '/secrets' && req.method === 'DELETE') { for (const n of JSON.parse(raw) as string[]) knobs.secrets.delete(n); return send(res, 200, {}); }
  return send(res, 404, { message: 'not found' });
})(); });

/** The platform in front of the function: verify_jwt ON, so a request without a JWT never reaches it. */
const fnServer = createServer((req, res) => {
  fnRequests.push({ auth: Boolean(req.headers.authorization) });
  send(res, 401, { code: 401, message: 'Missing authorization header' });
});
/** The staging site. */
const pages = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><script type="module" crossorigin src="/assets/index-abc.js"></script>'); return; }
  if (req.url === '/assets/index-abc.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(knobs.frontendJs); return; }
  res.writeHead(404); res.end();
});

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
let MGMT_URL = '';
let FN_URL = '';
let PAGES_URL = '';

const restoreDb = () => sql(`update private.ai_spend_config set enabled = false, budget_usd = 20, stop_at_usd = 18, max_reservation_usd = 1,
    founder_attempts_24h = 10, case_attempts_24h = 3, case_attempts_total = 10 where id = true;
  update private.ai_model_prices set active = (model = 'FAKE-PROVIDER-NOT-AI');
  update private.ai_model_prices set input_usd_per_mtok = 3, output_usd_per_mtok = 15, max_output_tokens = 8000 where model = 'kimi-k3';
  delete from private.ai_spend_ledger where reconciliation_note = 'paid-staging test: synthetic committed spend';
  update private.ai_spend_ledger set status = 'RECONCILED', actual_usd = coalesce(actual_usd, 0), settled_by = 'RECONCILIATION',
    reconciliation_note = 'test fixture: cleared between tests', settled_at = now() where status in ('RESERVED', 'HELD')`);
const state = () => one(`select enabled || ' ' || budget_usd::numeric(10,2) || '/' || stop_at_usd::numeric(10,2) || '/' || max_reservation_usd::numeric(10,2)
    || ' kimi:' || (select active from private.ai_model_prices where model = 'kimi-k3')
    || ' limits:' || founder_attempts_24h || '/' || case_attempts_24h || '/' || case_attempts_total from private.ai_spend_config where id = true`);
const OFF_STATE = 'false 20.00/18.00/1.00 kimi:false limits:10/3/10';
const committed = () => Number(one('select private.ai_committed_usd()'));
/** A settled synthetic reservation that raises committed spending to `target` USD. */
function commitSpend(target: number) {
  const add = Math.max(0, target - committed());
  sql(`insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model, analyst_input_bound, analyst_max_output,
       reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price, reviewer_out_price, reserved_usd, status, actual_usd,
       settled_by, reconciliation_note, settled_at)
     values (:'a', :'c', :'c', :'c', 'kimi-k3', 'kimi-k3', 1, 1, 1, 1, 3, 15, 3, 15, :'x', 'SETTLED', :'x', 'RECONCILIATION',
       'paid-staging test: synthetic committed spend', now())`, { a: randomUUID(), c: randomUUID(), x: add.toFixed(4) });
}
const dashCases = () => Number(one(`select count(*) from public.cases where reference like 'DASH-PAID-%'`));

test.beforeAll(async () => {
  sql('select tests.seed() where not exists (select 1 from public.founders)');
  MGMT_URL = await listen(mgmt);
  FN_URL = await listen(fnServer);
  PAGES_URL = await listen(pages);
});
test.afterAll(async () => {
  for (const s of [mgmt, fnServer, pages]) await new Promise((r) => s.close(r));
  restoreDb();
});
test.beforeEach(() => { reset(); makeRoomForCase(); restoreDb(); });

type Run = { code: number | null; out: string };
function run(cmd: string, over: Record<string, string | undefined> = {}): Promise<Run> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ROUTE_MGMT: MGMT_URL, ROUTE_FUNCTIONS: FN_URL, ROUTE_PAGES: PAGES_URL };
  for (const [k, v] of Object.entries({ SUPABASE_ACCESS_TOKEN: PAT, KIMI_API_KEY: KIMI_KEY, ...over })) if (v !== undefined) env[k] = v;
  const child = spawn(process.execPath, ['--import', PRELOAD, SCRIPT, cmd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((r) => child.on('exit', (code) => r({ code, out })));
}
const noSecrets = (out: string) => { for (const s of [PAT, KIMI_KEY]) expect(out, 'a credential was printed').not.toContain(s); };
const noCredentialedFunctionCall = () => expect(fnRequests.every((r) => !r.auth)).toBe(true);

// ---------------------------------------------------------------- activation

test('activate: Kimi settings, spending on with a USD 3 allowance and the USD 1 cap, a synthetic case, readiness PASSED; no provider call', async () => {
  expect(committed(), 'precondition: the local ledger leaves room for one USD 1 analysis').toBeLessThanOrEqual(2);
  const before = dashCases();
  const r = await run('activate');
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('RESULT: ACTIVATE PASSED');
  // settings: exactly Kimi; the fake permission removed
  expect(knobs.secrets.get('ANALYSIS_PROVIDER')).toBe('kimi');
  expect(knobs.secrets.get('ALLOW_PAID_PROVIDER')).toBe('staging-only');
  expect(knobs.secrets.get('KIMI_API_KEY')).toBe(KIMI_KEY);
  expect(knobs.secrets.has('ALLOW_FAKE_PROVIDER')).toBe(false);
  // database: one atomic activation; limits and cap unchanged
  expect(state()).toBe('true 3.00/3.00/1.00 kimi:true limits:10/3/10');
  expect(mgmtLog.filter((t) => t === 'activate')).toHaveLength(1);
  // the synthetic case: submitted by the synthetic business, analysable, no analysis
  expect(dashCases()).toBe(before + 1);
  expect(one(`select b.name || ' | ' || c.workflow_state || ' | ' || (select count(*) from public.analyses a where a.case_id = c.id)
      from public.cases c join public.businesses b on b.id = c.business_id where c.reference like 'DASH-PAID-%' order by c.created_at desc limit 1`))
    .toBe('Synthetic Autos A | SUBMITTED | 0');
  expect(one(`select (position('Synthetic Autos A: 9,500 is already a very good price.' in m.body) > 0)::text from public.case_messages m
      join public.cases c on c.id = m.case_id where c.reference like 'DASH-PAID-%' and m.kind = 'PASTED_CONVERSATION' order by c.created_at desc limit 1`)).toBe('true');
  // readiness ran: founder and business access proven through RLS, frontend and platform checked
  expect(r.out).toContain('as the founder: spending summary says enabled, the case is visible and analysable');
  expect(r.out).toContain('as the business: no analysis readable, no internal field, no spending summary, cannot start an analysis');
  expect(r.out).toContain('PASS  a request with no credential is refused by the platform');
  expect(r.out).toContain('PASS  the live frontend');
  expect(r.out).toContain('PASS  KIMI_API_KEY equals the protected GitHub secret (digest; value not shown)');
  noCredentialedFunctionCall();
  expect(Number(one(`select count(*) from public.analyses a join public.cases c on c.id = a.case_id where c.reference like 'DASH-PAID-%'`))).toBe(0);
  noSecrets(r.out);

  // a second activation reuses the eligible case (no duplicates) and stays at the same limits
  const again = await run('activate');
  expect(again.code, again.out).toBe(0);
  expect(dashCases()).toBe(before + 1);
  expect(state()).toBe('true 3.00/3.00/1.00 kimi:true limits:10/3/10');
});

test('activate refuses a wrong kimi-k3 price: nothing changed (settings, spending, cases)', async () => {
  sql(`update private.ai_model_prices set output_usd_per_mtok = 16 where model = 'kimi-k3'`);
  const before = dashCases();
  const r = await run('activate');
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain('FAIL  the kimi-k3 price row is the reviewed USD 3 / 15, cap 8000');
  expect(state()).toBe(OFF_STATE);
  expect(knobs.secrets.get('ANALYSIS_PROVIDER')).toBe('fake');
  expect(knobs.secrets.has('KIMI_API_KEY')).toBe(false);
  expect(dashCases()).toBe(before);
  noSecrets(r.out);
});

test('activate refuses when committed spending leaves no room for a USD 1 analysis under USD 3: nothing changed', async () => {
  commitSpend(2.5);
  const r = await run('activate');
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain('FAIL  committed spending leaves room for one USD 1 analysis under USD 3');
  expect(state()).toBe(OFF_STATE);
  expect(knobs.secrets.has('KIMI_API_KEY')).toBe(false);
});

test('activate refuses a deployed function that is not the reviewed Kimi-capable code, and missing or malformed credentials', async () => {
  knobs.body = ezbr(oldSources());
  let r = await run('activate');
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain('FAIL  the deployed code is the reviewed Kimi-capable version');
  expect(state()).toBe(OFF_STATE);
  expect(knobs.secrets.has('KIMI_API_KEY')).toBe(false);
  reset();
  for (const [over, want] of [
    [{ KIMI_API_KEY: undefined }, 'refused: KIMI_API_KEY is no key given'],
    [{ KIMI_API_KEY: 'sk-ant-api03-notakimikey000000000000000' }, 'refused: KIMI_API_KEY is not shaped like a Kimi API key'],
    [{ SUPABASE_ACCESS_TOKEN: undefined }, 'refused: SUPABASE_ACCESS_TOKEN: no access token given'],
  ] as [Record<string, string | undefined>, string][]) {
    r = await run('activate', over);
    expect(r.code, want).toBe(2);
    expect(r.out).toContain(want);
    expect(mgmtLog).toEqual([]);
  }
});

// ---------------------------------------------------------------- the activation statement itself (atomic, exact key)

test('the activation statement is atomic and keyed on id = true: each refusal rolls back everything', () => {
  sql(`update private.ai_model_prices set max_output_tokens = 9000 where model = 'kimi-k3'`);
  expect(() => sql(ACTIVATE_SQL)).toThrow(/RRE_ACTIVATE: the kimi-k3 price row is not the reviewed/);
  expect(state()).toBe(OFF_STATE.replace('kimi:false', 'kimi:false'));
  restoreDb();
  commitSpend(2.2);
  expect(() => sql(ACTIVATE_SQL)).toThrow(/RRE_ACTIVATE: committed spending .* leaves no room/);
  expect(state()).toBe(OFF_STATE);
  restoreDb();
  // zero configuration rows: refused, and nothing else changed (inside a transaction that is rolled back)
  expect(() => sql(`begin; delete from private.ai_spend_config; ${ACTIVATE_SQL} rollback;`)).toThrow(/RRE_ACTIVATE: expected exactly one spending configuration row/);
  expect(state()).toBe(OFF_STATE);
  // a cap other than USD 1 is refused (the cap is never changed by activation)
  sql('update private.ai_spend_config set max_reservation_usd = 2 where id = true');
  expect(() => sql(ACTIVATE_SQL)).toThrow(/RRE_ACTIVATE: the per-analysis cap is not USD 1/);
  restoreDb();
  // success: exactly the expected change; the allowance is lowered, never raised
  sql(ACTIVATE_SQL);
  expect(state()).toBe('true 3.00/3.00/1.00 kimi:true limits:10/3/10');
  restoreDb();
  sql('update private.ai_spend_config set budget_usd = 2.5, stop_at_usd = 2.5 where id = true');
  sql(ACTIVATE_SQL);
  expect(state()).toBe('true 2.50/2.50/1.00 kimi:true limits:10/3/10');
});

test('the singleton-key schema check accepts only a boolean primary key id with CHECK (id) and exactly one row', () => {
  const live = JSON.parse(one(`select json_build_object(
    'id_type', (select data_type from information_schema.columns where table_schema = 'private' and table_name = 'ai_spend_config' and column_name = 'id'),
    'pk', (select coalesce(json_agg(a.attname order by a.attname), '[]'::json) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
            where i.indrelid = 'private.ai_spend_config'::regclass and i.indisprimary),
    'id_check', exists (select 1 from pg_constraint where conrelid = 'private.ai_spend_config'::regclass and contype = 'c' and pg_get_constraintdef(oid) = 'CHECK (id)'),
    'rows', (select count(*) from private.ai_spend_config), 'key_rows', (select count(*) from private.ai_spend_config where id = true))`)!);
  expect(schemaProblem(live)).toBeNull();
  expect(schemaProblem({ ...live, id_type: 'integer' })).toMatch(/not a boolean/);
  expect(schemaProblem({ ...live, pk: ['id', 'x'] })).toMatch(/primary key/);
  expect(schemaProblem({ ...live, id_check: false })).toMatch(/CHECK \(id\)/);
  expect(schemaProblem({ ...live, rows: 2 })).toMatch(/exactly one row/);
  expect(schemaProblem({ ...live, key_rows: 0 })).toMatch(/exactly one row/);
});

// ---------------------------------------------------------------- deactivation

test('deactivate: spending off and kimi-k3 inactive, the Kimi key kept; deactivate-and-remove-key deletes the paid settings', async () => {
  expect((await run('activate')).code).toBe(0);
  let r = await run('deactivate', { KIMI_API_KEY: undefined });
  expect(r.code, r.out).toBe(0);
  expect(state()).toBe('false 3.00/3.00/1.00 kimi:false limits:10/3/10');
  expect(knobs.secrets.get('KIMI_API_KEY')).toBe(KIMI_KEY);
  expect(r.out).toContain('PASS  the Kimi key is kept');
  expect(mgmtLog.filter((t) => t === 'deactivate')).toHaveLength(1);
  // readiness now fails closed: spending is off
  r = await run('readiness');
  expect(r.code).toBe(1);
  expect(r.out).toContain('FAIL  spending is enabled');
  r = await run('deactivate-and-remove-key', { KIMI_API_KEY: undefined });
  expect(r.code, r.out).toBe(0);
  expect([...knobs.secrets.keys()].filter((n) => /KIMI|ALLOW_PAID|ANALYSIS_PROVIDER/.test(n))).toEqual([]);
  noSecrets(r.out);
  // the deactivation statement itself asserts one row each
  expect(() => sql(`begin; delete from private.ai_spend_config; ${DEACTIVATE_SQL} rollback;`)).toThrow(/RRE_DEACTIVATE: the configuration update changed 0 rows/);
});

// ---------------------------------------------------------------- readiness catches what would break the dashboard test

test('readiness fails when the live frontend lacks the paid action, when the fake is still allowed, or when the key differs', async () => {
  expect((await run('activate')).code).toBe(0);
  knobs.frontendJs = 'const a="Run analysis";';
  let r = await run('readiness');
  expect(r.code).toBe(1);
  expect(r.out).toContain('FAIL  the live frontend');
  knobs.frontendJs = FRONTEND_JS;
  knobs.secrets.set('ALLOW_FAKE_PROVIDER', 'staging-only');
  r = await run('readiness');
  expect(r.code).toBe(1);
  expect(r.out).toContain('FAIL  no fake-provider, Anthropic or model-override setting is present');
  knobs.secrets.delete('ALLOW_FAKE_PROVIDER');
  r = await run('readiness', { KIMI_API_KEY: `sk-OTHERKEY${randomBytes(16).toString('hex')}` });
  expect(r.code).toBe(1);
  expect(r.out).toContain('FAIL  KIMI_API_KEY equals the protected GitHub secret');
  r = await run('readiness');
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('RESULT: READINESS PASSED');
  noCredentialedFunctionCall();
  noSecrets(r.out);
});

test('the tool never names the Kimi endpoint and never starts an analysis or sends a credential to the function', () => {
  const code = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  expect(code).not.toMatch(/moonshot|api\.kimi|chat\/completions/i);
  // founder_start_analysis appears once: inside the business check, which must be refused (and rolls back if not)
  expect(code.match(/founder_start_analysis/g)).toHaveLength(1);
  expect(code).toMatch(/perform public\.founder_start_analysis\('\$\{caseId\}'\);\s*raise exception 'RRE_READY: a business account can start an analysis'/);
  // the only Bearer credential sent is the Management API token, and the function is called once, with no credential
  expect(code.match(/Bearer \$\{/g)).toEqual(['Bearer ${']);
  expect(code).toContain('authorization: `Bearer ${TOKEN}`');
  expect(code.match(/fetch\(FUNCTION_URL/g)).toHaveLength(1);
  expect(code).not.toMatch(/fetch\(FUNCTION_URL[^)]*authorization/i);
});

// The isolated WhatsApp preview: its workflow job and its Supabase setup script (fake Management API;
// nothing reaches Supabase). The prototype's project and site are refused.
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-expect-error plain ES module without type declarations
import { configProblem, PROTOTYPE_REF, schemaFiles } from '../../supabase/scripts/wa-preview-deploy.mjs';

const SCRIPT = fileURLToPath(new URL('../../supabase/scripts/wa-preview-deploy.mjs', import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL('../pipeline/fixtures/route-to-local.mjs', import.meta.url))).href;
const FILE = readFileSync(fileURLToPath(new URL('../../../.github/workflows/deploy-recovery-prototype.yml', import.meta.url)), 'utf8');
const JOB = FILE.slice(FILE.indexOf('\n  wa-preview:\n'));
const REF = 'isolatedpreviewabcde';
const PAT = `sbp_${'a'.repeat(40)}`;
const APP_SECRET = 'TESTONLYappsecret0123456789abcdef';
const VERIFY = 'TESTONLY-verify-token-0123456789';

const fakeState = { schema: false, bundle: false, secrets: new Map<string, string>(), queries: [] as string[], founderUser: true };
let mgmt: Server; let MGMT_URL = '';
test.beforeAll(async () => {
  mgmt = createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${PAT}`) return send(401, { message: 'no' });
      const path = (req.url ?? '').replace(`/v1/projects/${REF}`, '');
      if (path === '' && req.method === 'GET') return send(200, { status: 'ACTIVE_HEALTHY' });
      if (path === '/secrets' && req.method === 'GET') return send(200, [...fakeState.secrets.keys()].map((name) => ({ name, value: 'digest' })));
      if (path === '/secrets' && req.method === 'POST') { for (const x of JSON.parse(raw)) fakeState.secrets.set(x.name, x.value); return send(201, null); }
      if (path === '/database/query') {
        const q = JSON.parse(raw).query as string;
        fakeState.queries.push(q);
        if (q.includes("to_regclass('public.cases') is null")) return send(201, [{ v: !fakeState.schema }]);
        if (q.includes("to_regclass('private.wa_settings') is null")) return send(201, [{ v: !fakeState.bundle }]);
        if (q.includes('create table private.wa_settings')) { fakeState.bundle = true; return send(201, []); }
        if (q.includes('select id from auth.users')) return send(201, [{ v: fakeState.founderUser ? '00000000-0000-4000-8000-00000000000f' : null }]);
        if (q.startsWith('select (')) return send(201, [{ v: true }]);
        fakeState.schema = true;
        return send(201, []);
      }
      return send(404, {});
    });
  });
  MGMT_URL = await new Promise((r) => mgmt.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(mgmt.address() as { port: number }).port}`)));
});
test.afterAll(async () => { await new Promise((r) => mgmt.close(r)); });

function run(cmd: string, over: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ROUTE_MGMT: MGMT_URL };
  for (const [k, v] of Object.entries({ WA_PREVIEW_PROJECT_REF: REF, WA_PREVIEW_SUPABASE_ACCESS_TOKEN: PAT, WA_APP_ID: '123456789012345',
    WA_APP_SECRET: APP_SECRET, WA_VERIFY_TOKEN: VERIFY, WA_ALLOWED_ORIGIN: 'https://rre-whatsapp-preview.pages.dev', ...over })) if (v !== undefined) env[k] = v;
  const child = spawn(process.execPath, ['--import', PRELOAD, SCRIPT, cmd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return new Promise((r) => child.on('exit', (code) => r({ code, out })));
}

test('isolation: the prototype\'s project, a malformed reference or token are refused before any request', async () => {
  expect(configProblem({ WA_PREVIEW_PROJECT_REF: PROTOTYPE_REF, WA_PREVIEW_SUPABASE_ACCESS_TOKEN: PAT })).toMatch(/prototype/);
  expect(configProblem({ WA_PREVIEW_PROJECT_REF: 'short', WA_PREVIEW_SUPABASE_ACCESS_TOKEN: PAT })).toMatch(/reference/);
  expect(configProblem({ WA_PREVIEW_PROJECT_REF: REF, WA_PREVIEW_SUPABASE_ACCESS_TOKEN: 'nope' })).toMatch(/token/);
  const before = fakeState.queries.length;
  const r = await run('setup', { WA_PREVIEW_PROJECT_REF: PROTOTYPE_REF });
  expect(r.code).toBe(2);
  expect(fakeState.queries.length).toBe(before);
});

test('first setup: migrations then the WhatsApp bundle, settings with generated keys (never printed), worker scheduled via Vault', async () => {
  const r = await run('setup');
  expect(r.code, r.out).toBe(0);
  const migrations = schemaFiles().length;
  expect(r.out.match(/applied [0-9]+_/g)).toHaveLength(migrations);
  expect(r.out).toContain('applied whatsapp/wa_integration.sql');
  expect([...fakeState.secrets.keys()].sort()).toEqual(['WA_ALLOWED_ORIGIN', 'WA_APP_ID', 'WA_APP_SECRET', 'WA_TOKEN_KEY', 'WA_VERIFY_TOKEN', 'WA_WORKER_SECRET']);
  expect(Buffer.from(fakeState.secrets.get('WA_TOKEN_KEY')!, 'base64')).toHaveLength(32);
  const cron = fakeState.queries.find((q) => q.includes('cron.schedule'))!;
  expect(cron).toContain("vault.create_secret(");
  expect(cron).toContain(`https://${REF}.supabase.co/functions/v1/whatsapp/worker`);
  expect(cron).not.toContain(PROTOTYPE_REF);
  for (const v of [PAT, APP_SECRET, VERIFY, fakeState.secrets.get('WA_TOKEN_KEY')!, fakeState.secrets.get('WA_WORKER_SECRET')!]) expect(r.out).not.toContain(v);
});

test('re-running setup changes no schema and never regenerates the token key or worker secret', async () => {
  const key = fakeState.secrets.get('WA_TOKEN_KEY'); const worker = fakeState.secrets.get('WA_WORKER_SECRET');
  const n = fakeState.queries.length;
  const r = await run('setup');
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('RRE schema present (not re-applied)');
  expect(r.out).toContain('WhatsApp bundle present (not re-applied)');
  expect(fakeState.secrets.get('WA_TOKEN_KEY')).toBe(key);
  expect(fakeState.secrets.get('WA_WORKER_SECRET')).toBe(worker);
  expect(fakeState.queries.slice(n).some((q) => q.includes('cron.schedule'))).toBe(false);
});

test('founder: a strict email, an existing user of the PREVIEW project only', async () => {
  expect((await run('founder', { FOUNDER_EMAIL: "x' or 1=1 --@a.co" })).out).toContain('not a valid email address');
  fakeState.founderUser = false;
  expect((await run('founder', { FOUNDER_EMAIL: 'founder@example.com' })).out).toContain('no user with that email in the PREVIEW project');
  fakeState.founderUser = true;
  const r = await run('founder', { FOUNDER_EMAIL: 'Founder@Example.com' });
  expect(r.code, r.out).toBe(0);
  expect(fakeState.queries.at(-1)).toMatch(/^insert into public\.founders/);
  expect((await run('readiness')).code).toBe(0);
});

test('workflow job: manual, this branch only, exact commit, its own environment, isolation guard, secrets only as env', () => {
  const cond = /\n {4}if: >-\n((?: {6}.*\n)+)/.exec(JOB)![1].replace(/\s+/g, ' ');
  for (const c of ["github.repository == 'INVESTOR-bnb/conversation-intelligence-engine'", "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/claude/whatsapp-integration'", "startsWith(inputs.target, 'wa-preview-')", 'github.sha == inputs.expected_sha']) expect(cond).toContain(c);
  expect(JOB).toMatch(/\n {4}environment: wa-preview\n/);
  expect(JOB).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
  expect(JOB).toContain(`[ "$WA_PREVIEW_PROJECT_REF" != "aqwdwswpmbnzmkvyuqil" ]`);
  expect(JOB).toContain(`[ "$WA_PREVIEW_PAGES_PROJECT" != "revenue-recovery-v0" ]`);
  expect(JOB).not.toMatch(/uses:|--project-name="?revenue-recovery-v0|aqwdwswpmbnzmkvyuqil\.supabase/);
  for (const l of JOB.split('\n').filter((x) => x.includes('secrets.'))) expect(l).toMatch(/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/);
  expect(JOB).not.toMatch(/set -x|upload-artifact|KIMI_API_KEY|SUPABASE_ACCESS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN/);
});

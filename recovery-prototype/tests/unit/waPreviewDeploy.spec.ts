// The isolated WhatsApp preview: its workflow job, its Supabase setup script and its Cloudflare Pages
// script (fake Management API and fake Cloudflare API; nothing reaches Supabase or Cloudflare).
// The prototype's project and site are refused.
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-expect-error plain ES module without type declarations
import { configProblem, PERMISSIONS, PROTOTYPE_REF, schemaFiles } from '../../supabase/scripts/wa-preview-deploy.mjs';
// @ts-expect-error plain ES module without type declarations
import { pagesConfigProblem } from '../../supabase/scripts/wa-preview-pages.mjs';

test.describe.configure({ mode: 'serial' });

const SCRIPT = fileURLToPath(new URL('../../supabase/scripts/wa-preview-deploy.mjs', import.meta.url));
const PAGES = fileURLToPath(new URL('../../supabase/scripts/wa-preview-pages.mjs', import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL('../pipeline/fixtures/route-to-local.mjs', import.meta.url))).href;
const FILE = readFileSync(fileURLToPath(new URL('../../../.github/workflows/deploy-recovery-prototype.yml', import.meta.url)), 'utf8');
const README = readFileSync(fileURLToPath(new URL('../../supabase/whatsapp/README.md', import.meta.url)), 'utf8');
const JOB = FILE.slice(FILE.indexOf('\n  wa-preview:\n'));
const REF = 'isolatedpreviewabcde';
const PAT = `sbp_${'a'.repeat(40)}`;
const APP_SECRET = 'TESTONLYappsecret0123456789abcdef';
const VERIFY = 'TESTONLY-verify-token-0123456789';
const CF_TOKEN = 'TESTONLYcloudflaretoken0123456789';
const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';
const FILES: { name: string; sha256: string }[] = schemaFiles();

const st = {
  applied: new Map<string, string>(), foreignSchema: false, failOn: '' as string, deny: new Set<string>(),
  secrets: new Map<string, string>(), queries: [] as string[], cronExt: false, schedule: false, founderUser: true, founder: false,
};
let mgmt: Server; let MGMT_URL = '';
const cfState = { projects: new Map<string, { subdomain: string; latest_deployment: unknown }>(), denyList: false, creates: 0 };
let cf: Server; let CF_URL = '';

test.beforeAll(async () => {
  mgmt = createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${PAT}`) return send(401, { message: 'no' });
      const path = (req.url ?? '').replace(`/v1/projects/${REF}`, '');
      if (st.deny.has(`${req.method} ${path}`)) return send(403, { message: 'forbidden' });
      if (path === '' && req.method === 'GET') return send(200, { status: 'ACTIVE_HEALTHY' });
      if (path === '/functions' && req.method === 'GET') return send(200, [{ slug: 'whatsapp', status: 'ACTIVE', verify_jwt: false }, { slug: 'analyze-case', status: 'ACTIVE', verify_jwt: true }]);
      if (path === '/secrets' && req.method === 'GET') return send(200, [...st.secrets.keys()].map((name) => ({ name, value: 'digest' })));
      if (path === '/secrets' && req.method === 'POST') { for (const x of JSON.parse(raw)) st.secrets.set(x.name, x.value); return send(201, null); }
      if (path !== '/database/query') return send(404, {});
      const q = JSON.parse(raw).query as string;
      st.queries.push(q);
      const v = (x: unknown) => send(201, [{ v: x }]);
      if (q.startsWith('begin;')) {
        const m = /insert into rre_preview\.applied \(file, sha256\) values \('([^']+)', '([0-9a-f]{64})'\);\ncommit;$/.exec(q);
        if (!m) return send(400, { message: 'bad apply' });
        if (m[1] === st.failOn) return send(400, { message: 'connection reset' }); // the whole transaction is lost
        st.applied.set(m[1], m[2]); return send(201, []);
      }
      if (q.includes('create table if not exists rre_preview.applied')) return send(201, []);
      if (q.includes('select file, sha256 from rre_preview.applied')) return send(201, [...st.applied].map(([file, sha256]) => ({ file, sha256 })));
      if (q.includes("to_regclass('public.cases') is not null")) return v(st.foreignSchema);
      if (q.includes("where nspname = 'cron'")) return v(st.cronExt);
      if (q.includes("from cron.job where jobname = 'rre-wa-worker'") && q.startsWith('select (')) return v(st.schedule);
      if (q.includes('cron.schedule(')) { st.cronExt = true; st.schedule = true; return send(201, []); }
      if (q.includes('select id from auth.users')) return v(st.founderUser ? '00000000-0000-4000-8000-00000000000f' : null);
      if (q.startsWith('insert into public.founders')) { st.founder = true; return send(201, []); }
      if (q.includes('from public.founders')) return v(st.founder);
      if (q.includes('sending_enabled') || q.includes('ai_spend_config')) return v(true);
      if (q === 'select (1) as v') return v(1);
      return send(400, { message: 'unexpected query in test' });
    });
  });
  MGMT_URL = await new Promise((r) => mgmt.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(mgmt.address() as { port: number }).port}`)));

  cf = createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (s: number, b: object) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${CF_TOKEN}`) return send(401, { success: false, errors: [{ code: 10000 }] });
      const base = `/client/v4/accounts/${CF_ACCOUNT}/pages/projects`;
      const url = (req.url ?? '').split('?')[0];
      if (url === base && req.method === 'GET') return cfState.denyList ? send(403, { success: false, errors: [{ code: 10000 }] }) : send(200, { success: true, result: [] });
      if (url === base && req.method === 'POST') {
        const { name } = JSON.parse(raw); cfState.creates++;
        const p = { name, subdomain: `${name}-7xq.pages.dev`, latest_deployment: null }; // name taken globally → suffix
        cfState.projects.set(name, p); return send(200, { success: true, result: p });
      }
      const p = cfState.projects.get(decodeURIComponent(url.slice(base.length + 1)));
      return p ? send(200, { success: true, result: p }) : send(404, { success: false, errors: [{ code: 8000007 }] });
    });
  });
  CF_URL = await new Promise((r) => cf.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(cf.address() as { port: number }).port}`)));
});
test.afterAll(async () => { await new Promise((r) => mgmt.close(r)); await new Promise((r) => cf.close(r)); });

function spawnScript(script: string, args: string[], over: Record<string, string | undefined>): Promise<{ code: number | null; out: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ROUTE_MGMT: MGMT_URL, ROUTE_CF: CF_URL };
  for (const [k, v] of Object.entries(over)) if (v !== undefined) env[k] = v;
  const child = spawn(process.execPath, ['--import', PRELOAD, script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return new Promise((r) => child.on('exit', (code) => r({ code, out })));
}
const run = (cmd: string, over: Record<string, string | undefined> = {}) => spawnScript(SCRIPT, [cmd], {
  WA_PREVIEW_PROJECT_REF: REF, WA_PREVIEW_SUPABASE_ACCESS_TOKEN: PAT, WA_APP_ID: '123456789012345', WA_APP_SECRET: APP_SECRET,
  WA_VERIFY_TOKEN: VERIFY, WA_ALLOWED_ORIGIN: 'https://rre-whatsapp-preview-7xq.pages.dev', ...over });
const pages = (args: string[], over: Record<string, string | undefined> = {}) => spawnScript(PAGES, args, {
  CLOUDFLARE_API_TOKEN: CF_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, WA_PREVIEW_PAGES_PROJECT: 'rre-whatsapp-preview', ...over });
const appliedLines = (out: string) => (out.match(/^applied \S+$/gm) ?? []).length;

test('isolation: the prototype\'s project, a malformed reference or token are refused before any request', async () => {
  expect(configProblem({ WA_PREVIEW_PROJECT_REF: PROTOTYPE_REF, WA_PREVIEW_SUPABASE_ACCESS_TOKEN: PAT })).toMatch(/prototype/);
  expect(configProblem({ WA_PREVIEW_PROJECT_REF: 'short', WA_PREVIEW_SUPABASE_ACCESS_TOKEN: PAT })).toMatch(/reference/);
  expect(configProblem({ WA_PREVIEW_PROJECT_REF: REF, WA_PREVIEW_SUPABASE_ACCESS_TOKEN: 'nope' })).toMatch(/token/);
  const before = st.queries.length;
  const r = await run('setup', { WA_PREVIEW_PROJECT_REF: PROTOTYPE_REF });
  expect(r.code).toBe(2);
  expect(st.queries.length).toBe(before);
});

test('preflight: probes Project Settings: Read first and names the exact missing permission', async () => {
  const ok = await run('preflight');
  expect(ok.code, ok.out).toBe(0);
  expect(ok.out).toContain('PASS  Project Settings: Read');
  expect(ok.out).toContain('PASS  Edge Functions: Read');
  st.deny.add('GET ');
  const denied = await run('preflight');
  expect(denied.code).toBe(1);
  expect(denied.out).toContain('lacks "Project Settings: Read"');
  st.deny.clear();
  st.deny.add('GET /functions');
  expect((await run('preflight')).out).toContain('lacks "Edge Functions: Read"');
  st.deny.clear();
  // the checklist in the README lists every permission the deployment uses
  for (const p of new Set<string>(PERMISSIONS.map((x: { permission: string }) => x.permission))) expect(README).toContain(p);
});

test('a project with an RRE schema this tool did not install is refused (use a new, empty project)', async () => {
  st.foreignSchema = true;
  const r = await run('setup');
  expect(r.code).toBe(1);
  expect(r.out).toContain('not installed by this tool');
  expect(appliedLines(r.out)).toBe(0);
  st.foreignSchema = false;
});

test('interrupted first setup resumes: each file is applied once in its own transaction, tracked by checksum', async () => {
  st.failOn = FILES[3].name;
  const first = await run('setup');
  expect(first.code).toBe(1);
  expect(appliedLines(first.out)).toBe(3);
  expect([...st.applied.keys()]).toEqual(FILES.slice(0, 3).map((f) => f.name));
  expect(st.secrets.size).toBe(0); // nothing configured until the schema is complete
  st.failOn = '';
  const resumed = await run('setup');
  expect(resumed.code, resumed.out).toBe(0);
  expect(appliedLines(resumed.out)).toBe(FILES.length - 3);
  expect(resumed.out).toContain('applied whatsapp/wa_integration.sql');
  for (const f of FILES) expect(st.applied.get(f.name)).toBe(f.sha256);
  expect([...st.secrets.keys()].sort()).toEqual(['WA_ALLOWED_ORIGIN', 'WA_APP_ID', 'WA_APP_SECRET', 'WA_TOKEN_KEY', 'WA_VERIFY_TOKEN', 'WA_WORKER_SECRET']);
  expect(Buffer.from(st.secrets.get('WA_TOKEN_KEY')!, 'base64')).toHaveLength(32);
  const cron = st.queries.find((q) => q.includes('cron.schedule('))!;
  expect(cron).toContain('vault.create_secret(');
  expect(cron).toContain(`https://${REF}.supabase.co/functions/v1/whatsapp/worker`);
  expect(cron).not.toContain(PROTOTYPE_REF);
  for (const v of [PAT, APP_SECRET, VERIFY, st.secrets.get('WA_TOKEN_KEY')!, st.secrets.get('WA_WORKER_SECRET')!]) {
    expect(first.out + resumed.out).not.toContain(v);
  }
});

test('re-running setup applies nothing and never regenerates the token key or worker secret', async () => {
  const key = st.secrets.get('WA_TOKEN_KEY'); const worker = st.secrets.get('WA_WORKER_SECRET');
  const n = st.queries.length;
  const r = await run('setup');
  expect(r.code, r.out).toBe(0);
  expect(appliedLines(r.out)).toBe(0);
  expect(r.out).toContain('worker schedule present (not changed)');
  expect(st.secrets.get('WA_TOKEN_KEY')).toBe(key);
  expect(st.secrets.get('WA_WORKER_SECRET')).toBe(worker);
  expect(st.queries.slice(n).some((q) => q.includes('cron.schedule('))).toBe(false);
});

test('a missing worker schedule is repaired with a new worker secret; the token key is kept', async () => {
  const key = st.secrets.get('WA_TOKEN_KEY'); const worker = st.secrets.get('WA_WORKER_SECRET');
  st.schedule = false;
  const r = await run('setup');
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('the token key was not touched');
  expect(st.schedule).toBe(true);
  expect(st.secrets.get('WA_TOKEN_KEY')).toBe(key);
  expect(st.secrets.get('WA_WORKER_SECRET')).not.toBe(worker);
  expect(st.queries.at(-1)).toContain('vault.update_secret(');
});

test('a schema file changed after it was applied is refused, not re-applied', async () => {
  const name = FILES[0].name;
  st.applied.set(name, 'f'.repeat(64));
  const r = await run('setup');
  expect(r.code).toBe(1);
  expect(r.out).toContain(`${name} changed after it was applied`);
  expect((await run('readiness')).out).toContain('FAIL  schema_complete_and_unchanged');
  st.applied.set(name, FILES[0].sha256);
});

test('infrastructure readiness is separate from founder-account readiness', async () => {
  const infra = await run('readiness');
  expect(infra.code, infra.out).toBe(0);
  expect(infra.out).not.toContain('founder');
  const before = await run('founder-readiness');
  expect(before.code).toBe(1);
  expect(before.out).toContain('FAIL  founder_account');
});

test('founder: a strict email, an existing user of the PREVIEW project only; then founder readiness passes', async () => {
  expect((await run('founder', { FOUNDER_EMAIL: "x' or 1=1 --@a.co" })).out).toContain('not a valid email address');
  st.founderUser = false;
  expect((await run('founder', { FOUNDER_EMAIL: 'founder@example.com' })).out).toContain('no user with that email in the PREVIEW project');
  st.founderUser = true;
  const r = await run('founder', { FOUNDER_EMAIL: 'Founder@Example.com' });
  expect(r.code, r.out).toBe(0);
  expect(st.queries.at(-1)).toMatch(/^insert into public\.founders/);
  expect((await run('founder-readiness')).out).toContain('PASS  founder_account');
});

test('Pages: refuses the prototype\'s site and missing credentials; names a token without Pages access', async () => {
  expect(pagesConfigProblem({ WA_PREVIEW_PAGES_PROJECT: 'revenue-recovery-v0', CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT })).toMatch(/prototype/);
  expect(pagesConfigProblem({ WA_PREVIEW_PAGES_PROJECT: 'rre-whatsapp-preview', CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT })).toMatch(/CLOUDFLARE_API_TOKEN/);
  expect(pagesConfigProblem({ WA_PREVIEW_PAGES_PROJECT: 'rre-whatsapp-preview', CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: '' })).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
  expect((await pages([], { WA_PREVIEW_PAGES_PROJECT: 'revenue-recovery-v0' })).code).toBe(1);
  cfState.denyList = true;
  const denied = await pages([]);
  expect(denied.code).toBe(1);
  expect(denied.out).toContain('Cloudflare Pages › Edit');
  cfState.denyList = false;
  expect(cfState.creates).toBe(0);
});

test('Pages: check never creates; create makes the separate project once and reports its real address', async () => {
  const check = await pages(['check']);
  expect(check.code).toBe(1);
  expect(check.out).toContain('does not exist yet');
  expect(cfState.creates).toBe(0);
  const dir = mkdtempSync(join(tmpdir(), 'wa-pages-'));
  const output = join(dir, 'out');
  const made = await pages(['create'], { GITHUB_OUTPUT: output });
  expect(made.code, made.out).toBe(0);
  expect(made.out).toContain('created');
  expect(readFileSync(output, 'utf8')).toBe('origin=https://rre-whatsapp-preview-7xq.pages.dev\nhas_deployment=false\n');
  const again = await pages(['create']);
  expect(again.out).toContain('exists (not created again)');
  expect(cfState.creates).toBe(1);
  expect(made.out + again.out).not.toContain(CF_TOKEN);
  expect(made.out + again.out).not.toContain(CF_ACCOUNT);
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
  for (const r of JOB.split('\n').filter((l) => /^\s+run: /.test(l))) expect(r).not.toMatch(/\$\{\{/);
});

test('workflow job: preflight checks Cloudflare and Supabase, deploy is preflighted and resumable, readiness split', () => {
  expect(FILE).toContain('wa-preview-gate-test, wa-preview-preflight, wa-preview-deploy, wa-preview-founder, wa-preview-readiness]');
  expect(JOB).toContain("WA_PREVIEW_PAGES_PROJECT: ${{ vars.WA_PREVIEW_PAGES_PROJECT || 'rre-whatsapp-preview' }}");
  expect(JOB).toContain('node supabase/scripts/wa-preview-pages.mjs "$mode"');
  expect(JOB).toContain('node supabase/scripts/wa-preview-deploy.mjs preflight');
  expect(JOB).toContain('WA_ALLOWED_ORIGIN: ${{ steps.pages.outputs.origin }}');
  expect(JOB).not.toContain('pages project create'); // the project is created by the checked script only
  expect(JOB).toContain("steps.pages.outputs.has_deployment != 'true'"); // the placeholder never replaces a real deployment
  expect(JOB.indexOf('wa-preview-deploy.mjs preflight')).toBeLessThan(JOB.indexOf('wa-preview-deploy.mjs setup'));
  expect(JOB).toContain('node supabase/scripts/wa-preview-deploy.mjs readiness');
  expect(JOB).toContain('node supabase/scripts/wa-preview-deploy.mjs founder-readiness');
  const infra = JOB.slice(JOB.indexOf('- name: Infrastructure readiness'), JOB.indexOf('- name: Founder-account readiness'));
  expect(infra).not.toContain('founder');
});

// Stage 2A-5d-4c — safety of the staging tools for the analyze-case Edge Function:
//   * supabase/scripts/analyze-case-live-check.mjs runs against an in-process fake of
//     staging (fixtures/fake-supabase-analyze.mjs) that blocks every real connection;
//   * supabase/scripts/deploy-analyze-case-staging.sh runs in a temporary clone of
//     this repository with a fake `npx` on PATH: nothing can reach Supabase.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
// @ts-expect-error plain ES module without type declarations
import { STAGING_URL } from '../../supabase/scripts/live-guards.mjs';

const SCRIPT = fileURLToPath(new URL('../../supabase/scripts/analyze-case-live-check.mjs', import.meta.url));
const DEPLOY = fileURLToPath(new URL('../../supabase/scripts/deploy-analyze-case-staging.sh', import.meta.url));
const FAKE = pathToFileURL(fileURLToPath(new URL('./fixtures/fake-supabase-analyze.mjs', import.meta.url))).href;
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const BRANCH = 'claude/revenue-recovery-engine-stage-1-8xg8vf';
const REF = 'aqwdwswpmbnzmkvyuqil';

// Synthetic look-alikes built at run time (no key-shaped literals in the repo).
const PUBLISHABLE = 'sb_publishable_SyntheticTestKey_0123456789-ab';
const SECRET = ['sb', 'secret', 'SyntheticTestOnly0123456789'].join('_');
const ACCOUNTS = {
  CLIENT_A_EMAIL: 'client-a@synthetic.invalid', CLIENT_A_PASSWORD: 'synthetic-password-A-7Qx',
  CLIENT_B_EMAIL: 'client-b@synthetic.invalid', CLIENT_B_PASSWORD: 'synthetic-password-B-3Zk',
  FOUNDER_EMAIL: 'founder@synthetic.invalid', FOUNDER_PASSWORD: 'synthetic-password-F-9Lm',
};
const NEVER_PRINTED = [...Object.values(ACCOUNTS), PUBLISHABLE, 'fake-access-token', 'fake-refresh-token'];

type Entry = { host?: string; method?: string; path?: string; as?: string | null; apikey?: string | null; signIn?: string; signOut?: string;
  network?: string; fn?: boolean; status?: number; analysisStarted?: boolean };

function setup(scenario: string, overrides: Record<string, string | undefined> = {}) {
  const logFile = join(mkdtempSync(join(tmpdir(), 'ac-live-')), 'requests.jsonl');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', FAKE_SUPABASE_LOG: logFile, FAKE_SUPABASE_SCENARIO: scenario };
  for (const [k, v] of Object.entries({ RRE_SUPABASE_URL: STAGING_URL, RRE_PUBLISHABLE_KEY: PUBLISHABLE, ...ACCOUNTS, ...overrides })) if (v !== undefined) env[k] = v;
  const entries = (): Entry[] => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env, entries };
}
function run(scenario: string, overrides: Record<string, string | undefined> = {}) {
  const { env, entries } = setup(scenario, overrides);
  const r = spawnSync(process.execPath, ['--import', FAKE, SCRIPT], { env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, entries: entries() };
}
const nothingSecret = (out: string) => { for (const s of NEVER_PRINTED) expect(out, 'a credential or token was printed').not.toContain(s); };
const fnCalls = (e: Entry[]) => e.filter((x) => x.fn && x.status !== undefined);
const signOuts = (e: Entry[]) => e.filter((x) => x.signOut).map((x) => [x.as, x.signOut]);
const allSignedOut = [[ACCOUNTS.CLIENT_A_EMAIL, 'local'], [ACCOUNTS.CLIENT_B_EMAIL, 'local'], [ACCOUNTS.FOUNDER_EMAIL, 'local']];

// ---------------------------------------------------------------- live check: guards

for (const [name, url] of [['another project', 'https://abcdefghijklmnopqrst.supabase.co'], ['look-alike', 'https://aqwdwswpmbnzmkvyuqil.supabase.co.evil.example'],
  ['plain http', 'http://aqwdwswpmbnzmkvyuqil.supabase.co'], ['local server', 'http://localhost:54321']]) {
  test(`live check refuses ${name} before any request`, () => {
    const { code, out, entries } = run('correct', { RRE_SUPABASE_URL: url });
    expect(code).toBe(2);
    expect(out).toContain('refused: this is not the staging project');
    expect(entries).toEqual([]);
    expect(out).not.toContain(url);
    nothingSecret(out);
  });
}

test('live check refuses a secret key before any request, without printing it', () => {
  const { code, out, entries } = run('correct', { RRE_PUBLISHABLE_KEY: SECRET });
  expect(code).toBe(2);
  expect(out).toContain('refused:');
  expect(out).not.toContain(SECRET);
  expect(entries).toEqual([]);
});

test('live check stops on a missing value before any request', () => {
  const { code, out, entries } = run('correct', { CLIENT_B_PASSWORD: undefined });
  expect(code).toBe(2);
  expect(out).toContain('missing environment variable CLIENT_B_PASSWORD');
  expect(entries).toEqual([]);
});

// ---------------------------------------------------------------- live check: a correct deployment

test('a correct deployment passes every check; only staging is contacted; everything is signed out locally', () => {
  const { code, out, entries } = run('correct');
  expect(out).toMatch(/== \d+ pass, 0 fail/);
  expect(out).not.toMatch(/^FAIL/m);
  expect(code).toBe(0);
  expect(entries.filter((e) => e.network)).toEqual([]);
  expect(new Set(entries.map((e) => e.host))).toEqual(new Set([new URL(STAGING_URL).host]));
  expect(entries.filter((e) => e.apikey).every((e) => e.apikey === PUBLISHABLE)).toBe(true);
  expect(signOuts(entries)).toEqual(allSignedOut);
  expect(out).toMatch(/Synthetic cases created: AC-LIVE-\d{14} \(for cleanup\)/);
  // Only the founder's two real runs may start an analysis; nobody else ever does.
  expect(fnCalls(entries).filter((e) => e.analysisStarted).map((e) => e.as)).toEqual([ACCOUNTS.FOUNDER_EMAIL, ACCOUNTS.FOUNDER_EMAIL]);
  // Business users were sent to the function, and refused.
  expect(fnCalls(entries).filter((e) => e.as === ACCOUNTS.CLIENT_A_EMAIL).map((e) => e.status)).toEqual([403]);
  expect(fnCalls(entries).filter((e) => e.as === ACCOUNTS.CLIENT_B_EMAIL).map((e) => e.status)).toEqual([403]);
  expect(out).toContain('PASS  spending is disabled');
  expect(out).toContain('FAILED / SPENDING_DISABLED');
  nothingSecret(out);
});

// ---------------------------------------------------------------- live check: what it must catch

test('the platform rejecting the founder\'s JWT STOPS the run (exit 3) after one function call, with no redeploy advice to disable the check', () => {
  const { code, out, entries } = run('platform-rejects');
  expect(code).toBe(3);
  expect(out).toContain('STOP: the platform rejected the founder\'s valid session token');
  expect(out).toContain('Do NOT redeploy with --no-verify-jwt');
  expect(fnCalls(entries)).toHaveLength(1);
  expect(signOuts(entries)).toEqual(allSignedOut);
  nothingSecret(out);
});

test('spending enabled: the run stops before creating a case or calling the function', () => {
  const { code, out, entries } = run('spending-enabled');
  expect(code).toBe(2);
  expect(out).toContain('stopped: spending is ENABLED on staging');
  expect(fnCalls(entries)).toEqual([]);
  expect(entries.some((e) => e.path === '/rest/v1/rpc/client_create_case')).toBe(false);
  expect(signOuts(entries)).toEqual(allSignedOut);
});

test('a function without its provider settings stops the run with the code', () => {
  const { code, out } = run('not-configured');
  expect(code).toBe(2);
  expect(out).toContain('the function refuses to run: PROVIDER_NOT_CONFIGURED');
});

test('a business that can read analyses is reported as FAIL (exit 1)', () => {
  const { code, out } = run('leaky');
  expect(code).toBe(1);
  expect(out).toMatch(/^FAIL  client A \(case owner\): no rows from analyses/m);
  expect(out).toMatch(/^FAIL  client A \(case owner\): the analysis is invisible by id/m);
  nothingSecret(out);
});

test('a function that lets a business run an analysis is reported as FAIL (exit 1)', () => {
  const { code, out } = run('business-allowed');
  expect(code).toBe(1);
  expect(out).toMatch(/^FAIL  client A on its OWN case \(businesses cannot run analyses\)/m);
});

test('Ctrl-C while the function is busy signs out every session before exiting', async () => {
  const { env, entries } = setup('hang');
  const child = spawn(process.execPath, ['--import', FAKE, SCRIPT], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  await expect.poll(() => entries().some((e) => (e as { fnStart?: boolean }).fnStart), { timeout: 20_000 }).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGINT');
  expect(await exited).toBe(130);
  expect(signOuts(entries()).map((e) => e[1])).toEqual(['local', 'local', 'local']);
  nothingSecret(out);
});

test('the live check never signs out globally, never enables spending, never calls a provider', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  expect(src).toContain("signOut({ scope: 'local' })");
  expect(src).not.toMatch(/signOut\(\s*\)|scope:\s*'(global|others)'/);
  expect(src).not.toMatch(/ai_spend_config|enabled\s*=\s*true|update\s|anthropic\.com|api\.openai/i);
});

// ---------------------------------------------------------------- deploy script (temporary clone, fake npx)

const TOKEN = `sbp_${'0123456789abcdef'.repeat(2)}0123456789`;

function deployEnv(opts: { failOn?: string; branch?: string; dirty?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-deploy-'));
  const clone = join(dir, 'clone');
  const r = spawnSync('git', ['clone', '-q', '--branch', BRANCH, REPO, clone], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const app = join(clone, 'recovery-prototype');
  if (opts.branch) spawnSync('git', ['-C', clone, 'checkout', '-q', '-b', opts.branch]);
  if (opts.dirty) writeFileSync(join(app, 'supabase', 'functions', 'stray.ts'), '// local change\n');
  const bin = join(dir, 'bin');
  const log = join(dir, 'npx.jsonl');
  spawnSync('mkdir', ['-p', bin]);
  // A fake npx: records its arguments, whether a token was in its environment (never the token itself),
  // and what the throwaway project directory contained; makes no connection.
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const wd = args.includes('--workdir') ? args[args.indexOf('--workdir') + 1] : process.cwd();
const cfg = path.join(wd, 'supabase', 'config.toml');
if (args.includes('init')) { fs.mkdirSync(path.join(process.cwd(), 'supabase'), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), 'supabase', 'config.toml'), 'project_id = "x"\\n'); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, tokenInEnv: process.env.SUPABASE_ACCESS_TOKEN === ${JSON.stringify(TOKEN)},
  hasFunction: fs.existsSync(path.join(wd, 'supabase', 'functions', 'analyze-case', 'index.ts')) && fs.existsSync(path.join(wd, 'supabase', 'functions', '_shared', 'edge', 'handler.ts')),
  verifyJwtOn: fs.existsSync(cfg) && /\\[functions\\.analyze-case\\]\\nverify_jwt = true\\n/.test(fs.readFileSync(cfg, 'utf8')), workdir: wd }) + '\\n');
process.exit(${JSON.stringify(opts.failOn ?? '')} && args.includes(${JSON.stringify(opts.failOn ?? '')}) ? 1 : 0);
`);
  chmodSync(join(bin, 'npx'), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const deploy = (input: string) => {
    const res = spawnSync('bash', [DEPLOY], { cwd: app, input, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 60_000 });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  };
  return { app, clone, calls, deploy, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('deploy: exactly analyze-case to the staging ref, JWT check on, fake provider settings, token only in the environment', () => {
  const d = deployEnv();
  try {
    const { code, out } = d.deploy(`${REF}\n${TOKEN}\n`);
    expect(code, out).toBe(0);
    const calls = d.calls();
    const cmd = calls.map((c: { args: string[] }) => c.args.filter((a, i, all) => all[i - 1] !== '--workdir').join(' '));
    expect(cmd).toEqual([
      '--yes supabase@2.117.0 init',
      `--yes supabase@2.117.0 functions deploy analyze-case --use-api --project-ref ${REF} --workdir`,
      `--yes supabase@2.117.0 secrets set ANALYSIS_PROVIDER=fake ALLOW_FAKE_PROVIDER=staging-only --project-ref ${REF} --workdir`,
      `--yes supabase@2.117.0 functions list --project-ref ${REF} --workdir`,
    ]);
    const deployCall = calls[1];
    expect(deployCall.hasFunction).toBe(true);
    expect(deployCall.verifyJwtOn).toBe(true);
    expect(calls.slice(1).every((c: { tokenInEnv: boolean }) => c.tokenInEnv)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    expect(JSON.stringify(calls)).not.toMatch(/no-verify-jwt|--prune|ANTHROPIC|ALLOW_FAKE_PROVIDER=(?!staging-only)/);
    expect(out).not.toContain(TOKEN);
    expect(existsSync(deployCall.workdir)).toBe(false); // the throwaway directory is removed
    expect(spawnSync('git', ['-C', d.clone, 'status', '--porcelain'], { encoding: 'utf8' }).stdout).toBe(''); // the checkout is untouched
  } finally { d.cleanup(); }
});

for (const [name, input, opts, expectMsg] of [
  ['a mistyped project reference', `aqwdwswpmbnzmkvyuqi\n${TOKEN}\n`, {}, 'the project reference was not confirmed'],
  ['another project reference', `abcdefghijklmnopqrst\n${TOKEN}\n`, {}, 'the project reference was not confirmed'],
  ['a secret key instead of an access token', `${REF}\n${SECRET}\n`, {}, 'not a Supabase personal access token'],
  ['an empty token', `${REF}\n\n`, {}, 'not a Supabase personal access token'],
  ['uncommitted changes', `${REF}\n${TOKEN}\n`, { dirty: true }, 'uncommitted or untracked changes'],
  ['another branch', `${REF}\n${TOKEN}\n`, { branch: 'other-branch' }, `not on ${BRANCH}`],
] as [string, string, { dirty?: boolean; branch?: string }, string][]) {
  test(`deploy refuses ${name}: nothing is deployed`, () => {
    const d = deployEnv(opts);
    try {
      const { code, out } = d.deploy(input);
      expect(code).toBe(2);
      expect(out).toContain('REFUSED (nothing deployed)');
      expect(out).toContain(expectMsg);
      expect(d.calls()).toEqual([]);
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(TOKEN);
    } finally { d.cleanup(); }
  });
}

test('deploy: a failed deployment sets no settings', () => {
  const d = deployEnv({ failOn: 'deploy' });
  try {
    const { code, out } = d.deploy(`${REF}\n${TOKEN}\n`);
    expect(code).toBe(1);
    expect(out).toContain('DEPLOY FAILED');
    expect(d.calls().some((c: { args: string[] }) => c.args.includes('secrets'))).toBe(false);
  } finally { d.cleanup(); }
});

test('deploy script: no --no-verify-jwt, no --prune, no deploy without a function name, staging ref only', () => {
  const src = readFileSync(DEPLOY, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  expect(src).not.toMatch(/--no-verify-jwt|--prune|verify_jwt = false/);
  expect(src).toMatch(/^REF=aqwdwswpmbnzmkvyuqil$/m);
  expect(src.match(/--project-ref/g)).toHaveLength(1); // only inside cli(), always "$REF"
  expect(src).toContain('cli functions deploy "$FN" --use-api');
});

test('deploy refuses function code that imports an AI-provider SDK (even when committed and pushed)', () => {
  const d = deployEnv();
  try {
    const bare = `${d.clone}.git`;
    const g = (...a: string[]) => spawnSync('git', ['-C', d.clone, ...a], { encoding: 'utf8' });
    spawnSync('git', ['clone', '-q', '--bare', d.clone, bare]);
    g('remote', 'set-url', 'origin', bare);
    writeFileSync(join(d.app, 'supabase', 'functions', '_shared', 'provider.ts'), "import Anthropic from '@anthropic-ai/sdk';\nexport default Anthropic;\n");
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@synthetic.invalid', 'commit', '-q', '-m', 'synthetic provider');
    g('push', '-q', 'origin', `HEAD:${BRANCH}`);
    const { code, out } = d.deploy(`${REF}\n${TOKEN}\n`);
    expect(code).toBe(2);
    expect(out).toContain('contains an AI-provider SDK, endpoint or key');
    expect(d.calls()).toEqual([]);
  } finally { d.cleanup(); }
});

test('deploy refuses a checkout without Stage 2A-5d-3b (the spending controls)', () => {
  const d = deployEnv();
  try {
    spawnSync('git', ['-C', d.clone, 'reset', '-q', '--hard', 'f835563']); // Stage 2A-5d-4b, before 2A-5d-3b
    const { code, out } = d.deploy(`${REF}\n${TOKEN}\n`);
    expect(code).toBe(2);
    expect(out).toContain('does not contain Stage 2A-5d-3b');
    expect(d.calls()).toEqual([]);
  } finally { d.cleanup(); }
});

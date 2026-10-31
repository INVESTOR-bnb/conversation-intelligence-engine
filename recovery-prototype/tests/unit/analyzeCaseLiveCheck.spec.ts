// Stage 2A-5d-4c — safety of the staging tools for the analyze-case Edge Function:
//   * supabase/scripts/analyze-case-live-check.mjs runs against an in-process fake of
//     staging (fixtures/fake-supabase-analyze.mjs) that blocks every real connection;
//   * supabase/scripts/deploy-analyze-case-staging.sh runs in a temporary clone of
//     this repository with a fake `npx` on PATH: nothing can reach Supabase.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ---------------------------------------------------------------- deploy script: retired

// deploy-analyze-case-staging.sh deployed the fake-only code and always set ANALYSIS_PROVIDER=fake:
// run today it would silently replace a configured paid (Kimi) provider. It is retired and
// refuses before doing anything (deploy-analyze-case-2a6d.sh replaces it; see stage2a6d.spec.ts).
test('the retired deploy script refuses, calls nothing and never writes the fake provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-retired-'));
  try {
    const bin = join(dir, 'bin');
    const log = join(dir, 'npx.log');
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    const res = spawnSync('bash', [DEPLOY], { cwd: fileURLToPath(new URL('../..', import.meta.url)), input: `${REF}\nsbp_${'0'.repeat(32)}\n`, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 30_000 });
    expect(res.status).toBe(2);
    expect(`${res.stdout}${res.stderr}`).toContain('REFUSED (nothing deployed): deploy-analyze-case-staging.sh is retired');
    expect(existsSync(log)).toBe(false);
    const src = readFileSync(DEPLOY, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(src).not.toMatch(/secrets set|functions deploy|ANALYSIS_PROVIDER=/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

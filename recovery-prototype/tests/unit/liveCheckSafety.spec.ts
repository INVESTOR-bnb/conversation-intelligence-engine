// Safety of the live Storage check (supabase/scripts/storage-live-check.mjs):
// it may only ever touch the synthetic STAGING project, only with a
// publishable key, must never print a credential, and must sign out every
// session it opened ('local' scope only), whether it passes, fails or is
// interrupted. The script runs here against an in-process fake Supabase
// (fixtures/fake-supabase.mjs) that also blocks every real network connection.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
// @ts-expect-error plain ES module without type declarations
import { STAGING_URL, publishableKeyProblem, stagingUrlProblem } from '../../supabase/scripts/live-guards.mjs';

const SCRIPT = fileURLToPath(new URL('../../supabase/scripts/storage-live-check.mjs', import.meta.url));
const FAKE = pathToFileURL(fileURLToPath(new URL('./fixtures/fake-supabase.mjs', import.meta.url))).href;

// Synthetic, unsigned look-alikes built at run time (no key-shaped literals in the repo).
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (role: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role })}.synthetic`;
const ANON_JWT = fakeJwt('anon');
const SERVICE_JWT = fakeJwt('service_role');
const SECRET = ['sb', 'secret', 'SyntheticTestOnly0123456789'].join('_');
const PUBLISHABLE = 'sb_publishable_SyntheticTestKey_0123456789-ab';

const ACCOUNTS = {
  CLIENT_A_EMAIL: 'client-a@synthetic.invalid', CLIENT_A_PASSWORD: 'synthetic-password-A-7Qx',
  CLIENT_B_EMAIL: 'client-b@synthetic.invalid', CLIENT_B_PASSWORD: 'synthetic-password-B-3Zk',
  FOUNDER_EMAIL: 'founder@synthetic.invalid', FOUNDER_PASSWORD: 'synthetic-password-F-9Lm',
};
// Nothing in this list may ever appear in the script's output.
const NEVER_PRINTED = [...Object.values(ACCOUNTS), PUBLISHABLE, 'fake-access-token', 'fake-refresh-token'];

type Entry = { host?: string; method?: string; path?: string; as?: string | null; signIn?: string; signOut?: string; network?: string };

function setup(scenario: string, overrides: Record<string, string | undefined> = {}) {
  const logFile = join(mkdtempSync(join(tmpdir(), 'live-check-')), 'requests.jsonl');
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

function expectNothingSecret(out: string) {
  for (const s of NEVER_PRINTED) expect(out, 'a credential or token was printed').not.toContain(s);
}
const signIns = (e: Entry[]) => e.filter((x) => x.signIn).map((x) => x.signIn);
const signOuts = (e: Entry[]) => e.filter((x) => x.signOut);

// ------------------------------------------------------------- staging URL guard

test('accepts only the staging project URL', () => {
  expect(STAGING_URL).toBe('https://aqwdwswpmbnzmkvyuqil.supabase.co');
  expect(stagingUrlProblem(STAGING_URL)).toBeNull();
  expect(stagingUrlProblem(`${STAGING_URL}/`)).toBeNull();
});

const REJECTED_URLS: [string, unknown][] = [
  ['another Supabase project (e.g. production)', 'https://abcdefghijklmnopqrst.supabase.co'],
  ['plain http', 'http://aqwdwswpmbnzmkvyuqil.supabase.co'],
  ['look-alike suffix', 'https://aqwdwswpmbnzmkvyuqil.supabase.co.evil.example'],
  ['look-alike prefix', 'https://xaqwdwswpmbnzmkvyuqil.supabase.co'],
  ['credentials trick', 'https://aqwdwswpmbnzmkvyuqil.supabase.co@evil.example'],
  ['extra path', 'https://aqwdwswpmbnzmkvyuqil.supabase.co/rest/v1'],
  ['explicit port', 'https://aqwdwswpmbnzmkvyuqil.supabase.co:443'],
  ['query string', 'https://aqwdwswpmbnzmkvyuqil.supabase.co?x=1'],
  ['upper case', 'https://AQWDWSWPMBNZMKVYUQIL.supabase.co'],
  ['surrounding space', ' https://aqwdwswpmbnzmkvyuqil.supabase.co'],
  ['local server', 'http://localhost:54321'],
  ['empty', ''],
  ['missing', undefined],
];
for (const [name, url] of REJECTED_URLS) {
  test(`rejects URL: ${name}`, () => {
    expect(stagingUrlProblem(url)).not.toBeNull();
  });
}

for (const [name, url] of REJECTED_URLS.slice(0, 6)) {
  test(`script refuses ${name} before any request, sign-in or data change`, () => {
    const { code, out, entries } = run('all-refused', { RRE_SUPABASE_URL: url as string });
    expect(code).toBe(2);
    expect(out).toContain('refused: this is not the staging project');
    expect(entries, 'no request may be made').toEqual([]);
    expect(out).not.toContain(url as string); // the value given is never repeated
    expectNothingSecret(out);
  });
}

test('a password typed at the URL prompt is refused and not repeated', () => {
  const { code, out, entries } = run('all-refused', { RRE_SUPABASE_URL: ACCOUNTS.CLIENT_A_PASSWORD });
  expect(code).toBe(2);
  expect(entries).toEqual([]);
  expectNothingSecret(out);
});

test('a missing account value stops the script before any request', () => {
  const { code, out, entries } = run('all-refused', { FOUNDER_PASSWORD: undefined });
  expect(code).toBe(2);
  expect(out).toContain('missing environment variable FOUNDER_PASSWORD');
  expect(entries).toEqual([]);
  expectNothingSecret(out);
});

// ------------------------------------------------------------- publishable key guard

test('accepts a publishable key', () => {
  expect(publishableKeyProblem(PUBLISHABLE)).toBeNull();
  expect(publishableKeyProblem('sb_publishable_x')).toBeNull();
});

const REJECTED_KEYS: [string, unknown][] = [
  ['legacy anon JWT', ANON_JWT],
  ['legacy service_role JWT', SERVICE_JWT],
  ['secret key', SECRET],
  ['secret key hidden after a publishable prefix', `sb_publishable_abc_${SECRET}`],
  ['publishable prefix with nothing after it', 'sb_publishable_'],
  ['leading space', ' sb_publishable_abc'],
  ['trailing newline', 'sb_publishable_abc\n'],
  ['two keys pasted together', `sb_publishable_abc ${SECRET}`],
  ['wrong case', 'SB_PUBLISHABLE_abc'],
  ['prefix not at the start', 'xsb_publishable_abc'],
  ['empty', ''],
  ['missing', undefined],
];
for (const [name, key] of REJECTED_KEYS) {
  test(`rejects key: ${name}`, () => {
    const problem = publishableKeyProblem(key);
    expect(problem).not.toBeNull();
    if (typeof key === 'string' && key.length > 'sb_publishable_'.length) expect(problem).not.toContain(key); // never echoes a real key
  });
}

for (const [name, key] of [['legacy service_role JWT', SERVICE_JWT], ['legacy anon JWT', ANON_JWT], ['secret key', SECRET]]) {
  test(`script refuses a ${name} before any request, without printing it`, () => {
    const { code, out, entries } = run('all-refused', { RRE_PUBLISHABLE_KEY: key });
    expect(code).toBe(2);
    expect(out).toContain('refused:');
    expect(out).toContain('sb_publishable_');
    expect(out).not.toContain(key);
    expect(entries).toEqual([]);
    expectNothingSecret(out);
  });
}

// ------------------------------------------------------------- sign-out and output

test('a complete run (with failing checks) signs out all three sessions, locally only', () => {
  const { code, out, entries } = run('all-refused');
  expect(code).toBe(1); // the fake refuses everything, so some checks fail
  expect(out).toMatch(/== \d+ pass, \d+ fail/);
  expect(entries.filter((e) => e.network)).toEqual([]);
  expect(new Set(entries.map((e) => e.host))).toEqual(new Set([new URL(STAGING_URL).host]));
  expect(signIns(entries)).toEqual([ACCOUNTS.CLIENT_A_EMAIL, ACCOUNTS.CLIENT_B_EMAIL, ACCOUNTS.FOUNDER_EMAIL]);
  expect(signOuts(entries).map((e) => [e.as, e.signOut])).toEqual([
    [ACCOUNTS.CLIENT_A_EMAIL, 'local'], [ACCOUNTS.CLIENT_B_EMAIL, 'local'], [ACCOUNTS.FOUNDER_EMAIL, 'local'],
  ]);
  expect(entries.findIndex((e) => e.signOut)).toBeGreaterThan(entries.findLastIndex((e) => !e.signOut));
  expect(out).toMatch(/Synthetic cases created: LIVE-CHECK-\d{14}, LIVE-CHECK-\d{14}-X \(for cleanup\)/);
  expect(out).not.toContain('sign-out failed');
  expectNothingSecret(out);
});

test('an early stop (clients in the same business) still signs out every session', () => {
  const { code, out, entries } = run('same-business');
  expect(code).toBe(2);
  expect(out).toContain('stopped: accounts must be: two CLIENTS of different businesses');
  expect(entries.some((e) => e.path === '/rest/v1/rpc/client_create_case')).toBe(false);
  expect(signOuts(entries).map((e) => e.signOut)).toEqual(['local', 'local', 'local']);
  expectNothingSecret(out);
});

test('a failed sign-in signs out the sessions already opened, and nothing else', () => {
  const { code, out, entries } = run('b-sign-in-fails');
  expect(code).toBe(2);
  expect(out).toContain('CLIENT_B: sign-in failed');
  expect(signIns(entries)).toEqual([ACCOUNTS.CLIENT_A_EMAIL, ACCOUNTS.CLIENT_B_EMAIL]);
  expect(signOuts(entries).map((e) => [e.as, e.signOut])).toEqual([[ACCOUNTS.CLIENT_A_EMAIL, 'local']]);
  expectNothingSecret(out);
});

test('an error part-way through still signs out every session', () => {
  const { code, out, entries } = run('create-fails');
  expect(code).toBe(2);
  expect(out).toContain('stopped: could not create the synthetic case');
  expect(signOuts(entries).map((e) => e.signOut)).toEqual(['local', 'local', 'local']);
  expectNothingSecret(out);
});

test('Ctrl-C during the run signs out every session before exiting', async () => {
  const { env, entries } = setup('hang');
  const child = spawn(process.execPath, ['--import', FAKE, SCRIPT], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  await expect.poll(() => entries().some((e) => e.path === '/rest/v1/rpc/client_create_case'), { timeout: 20_000 }).toBe(true);
  child.kill('SIGINT');
  expect(await exited).toBe(130);
  expect(out).toContain('interrupted: signing out before exiting');
  expect(signOuts(entries()).map((e) => e.signOut)).toEqual(['local', 'local', 'local']);
  expect(entries().filter((e) => e.network)).toEqual([]);
  expectNothingSecret(out);
});

test('the script never uses global or "others" sign-out', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  expect(src).toContain("signOut({ scope: 'local' })");
  expect(src).not.toMatch(/signOut\(\s*\)|scope:\s*'(global|others)'/);
});

// The live Storage test must only ever run with a publishable key. A legacy
// eyJ… key may be the service_role key (it bypasses every policy under test),
// and a secret key must never be used from a phone.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
// @ts-expect-error plain ES module without type declarations
import { publishableKeyProblem } from '../../supabase/scripts/live-key.mjs';

const SCRIPT = fileURLToPath(new URL('../../supabase/scripts/storage-live-check.mjs', import.meta.url));
// Synthetic, unsigned look-alikes built at run time (no key-shaped literals in the repo).
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (role: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role })}.synthetic`;
const ANON_JWT = fakeJwt('anon');
const SERVICE_JWT = fakeJwt('service_role');
const SECRET = ['sb', 'secret', 'SyntheticTestOnly0123456789'].join('_');
const PUBLISHABLE = 'sb_publishable_SyntheticTestKey_0123456789-ab';

test('accepts a publishable key', () => {
  expect(publishableKeyProblem(PUBLISHABLE)).toBeNull();
  expect(publishableKeyProblem('sb_publishable_x')).toBeNull();
});

const REJECTED: [string, unknown][] = [
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
for (const [name, key] of REJECTED) {
  test(`rejects: ${name}`, () => {
    const problem = publishableKeyProblem(key);
    expect(problem).not.toBeNull();
    if (typeof key === 'string' && key.length > 'sb_publishable_'.length) expect(problem).not.toContain(key); // never echoes a real key
  });
}

// Runs the real script with only the URL and key set (no accounts), so it can
// never reach the network: a refused key exits before any client is created,
// and an accepted key stops at the first missing account variable.
function run(key: string) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH ?? '', RRE_SUPABASE_URL: 'https://synthetic.invalid', RRE_PUBLISHABLE_KEY: key },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

for (const [name, key] of [['legacy service_role JWT', SERVICE_JWT], ['legacy anon JWT', ANON_JWT], ['secret key', SECRET]]) {
  test(`script refuses a ${name} before signing in, without printing it`, () => {
    const { code, out } = run(key);
    expect(code).toBe(2);
    expect(out).toContain('refused:');
    expect(out).toContain('sb_publishable_');
    expect(out).not.toContain(key);
    expect(out).not.toContain('missing environment variable CLIENT_A_EMAIL');
  });
}

test('script accepts a publishable key and continues to the account variables', () => {
  const { code, out } = run(PUBLISHABLE);
  expect(code).toBe(2);
  expect(out).toContain('missing environment variable CLIENT_A_EMAIL');
  expect(out).not.toContain('refused:');
  expect(out).not.toContain(PUBLISHABLE);
});

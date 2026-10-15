// Android / Codespaces terminal input for the end-to-end wrappers (paid-pipeline-e2e.sh,
// fake-pipeline-e2e.sh): every answer stays on its own prompt, credentials are checked at the
// prompt and never shown, and only the exact confirmation phrase typed after its prompt counts.
// Real pseudo-terminals (fixtures/pty-run.py); synthetic values only; the scripts themselves are
// replaced by an environment probe (fixtures/env-probe.mjs), so nothing is ever sent anywhere.

import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../..', import.meta.url));
const PTY = fileURLToPath(new URL('./fixtures/pty-run.py', import.meta.url));
const PROBE = fileURLToPath(new URL('./fixtures/env-probe.mjs', import.meta.url));
const DRIVER = fileURLToPath(new URL('./fixtures/answer-driver.mjs', import.meta.url));
const CHECK = fileURLToPath(new URL('../../supabase/scripts/check-input.mjs', import.meta.url));

const SCOPED = 'sbp_fcSYNTHETICscopedTESTonly00000000000000';
const CLASSIC = `sbp_${'0123456789abcdef'.repeat(2)}01234567`;
const KIMI = 'sk-SYNTHETICkimiTESTonly0000000000000';
const PUBLISHABLE = 'sb_publishable_SYNTHETICtestONLY0000';
const SECRET = ['sb', 'secret', 'SYNTHETICtestONLY0000000000'].join('_');

type Step = [number, string];
function pty(cmd: string[], steps: Step[], env: Record<string, string> = {}): string {
  return execFileSync('python3', [PTY, JSON.stringify(cmd), JSON.stringify(steps)], {
    cwd: APP, encoding: 'utf8', timeout: 90_000, env: { ...process.env, NODE_OPTIONS: `--import=${PROBE}`, ...env },
  }).replace(/\r/g, '');
}
const probe = (screen: string) => JSON.parse(/ENV-PROBE (\{.*\})/.exec(screen)?.[1] ?? 'null') as Record<string, boolean> | null;
const EXPECT = { EXPECT_TOKEN: SCOPED, EXPECT_KIMI: KIMI, EXPECT_PUBLISHABLE: PUBLISHABLE, EXPECT_FOUNDER_EMAIL: 'f@synthetic.test', EXPECT_PROVIDER: 'kimi' };
const kimiAnswers = (token: string): Step[] => [[0.6, `${token}\r`], [0.4, `${PUBLISHABLE}\r`], [0.3, 'a@synthetic.test\r'], [0.3, 'pw-a\r'], [0.3, 'b@synthetic.test\r'],
  [0.3, 'pw-b\r'], [0.3, 'f@synthetic.test\r'], [0.3, 'pw-f\r'], [0.3, 'kimi\r'], [0.3, `${KIMI} \r`], [0.3, '5\r'], [0.3, '\r']];

test.describe.configure({ mode: 'parallel' });

// ---------------------------------------------------------------- the per-prompt checker
test('checker: classic and scoped tokens accepted; invisible characters at the ends allowed; wrong credentials refused without echoing them', () => {
  const chk = (kind: string, v: string) => { const r = spawnSync('node', [CHECK, kind], { input: v, encoding: 'utf8' }); return { ok: r.status === 0, err: r.stderr.trim() }; };
  for (const v of [SCOPED, CLASSIC, `﻿${SCOPED}\r\n`, `${CLASSIC} `]) expect(chk('pat', v).ok, JSON.stringify(v.slice(0, 6))).toBe(true);
  for (const [v, why] of [['', 'no access token given'], [PUBLISHABLE, 'a publishable key was given'], [SECRET, 'a secret API key was given'],
    ['sbp_fc0123', 'too short'], [`${SCOPED.slice(0, 10)}-${SCOPED.slice(10)}`, 'a hyphen']] as [string, string][]) {
    const r = chk('pat', v);
    expect(r.ok, why).toBe(false);
    expect(r.err, why).toContain(why);
    if (v.length > 8) expect(r.err).not.toContain(v.slice(-8));
  }
  expect(chk('kimi-key', `${KIMI}\r`).ok).toBe(true);
  expect(chk('kimi-key', 'sk-ant-SYNTHETICanthropicTEST000000').ok).toBe(false);
  expect(chk('publishable', PUBLISHABLE).ok).toBe(true);
  for (const v of [SECRET, SCOPED, KIMI]) { const r = chk('publishable', v); expect(r.ok).toBe(false); expect(r.err).not.toContain(v.slice(-8)); }
  expect(chk('email', SCOPED).err).toBe('that looks like a secret, not an email address');
  expect(chk('provider', 'kimi ').ok).toBe(true);
  expect(chk('provider', 'Kimi').ok).toBe(false);
});

// ---------------------------------------------------------------- the wrappers under a real terminal
test('paid wrapper (Kimi): a stray Enter, Android paste artefacts — every answer reaches its own variable; no credential on screen', () => {
  // An Enter pressed before the first prompt, a byte-order mark + carriage return around the scoped
  // token, a non-breaking space after the Kimi key: nothing shifts, and bash hands Node the values.
  const screen = pty(['bash', 'supabase/scripts/paid-pipeline-e2e.sh'], [[0.2, '\r'], ...kimiAnswers(`﻿${SCOPED}\r`)], EXPECT);
  expect(probe(screen), screen).toEqual({ SUPABASE_ACCESS_TOKEN: false, KIMI_API_KEY: false, RRE_PUBLISHABLE_KEY: true, FOUNDER_EMAIL: true, PAID_PROVIDER: true });
  // The token and key arrive with their paste artefacts (the scripts trim them: live-guards.mjs);
  // what matters here is that they arrived at the right variables, never on screen.
  for (const v of [SCOPED, KIMI, 'pw-a', 'pw-b', 'pw-f']) expect(screen).not.toContain(v);
});

test('paid wrapper (Kimi): typed cleanly, the exact token and key reach Node', () => {
  const screen = pty(['bash', 'supabase/scripts/paid-pipeline-e2e.sh'], kimiAnswers(SCOPED).map(([w, t]) => [w, t.replace(' ', '')] as Step), EXPECT);
  expect(probe(screen), screen).toEqual({ SUPABASE_ACCESS_TOKEN: true, KIMI_API_KEY: true, RRE_PUBLISHABLE_KEY: true, FOUNDER_EMAIL: true, PAID_PROVIDER: true });
  for (const v of [SCOPED, KIMI]) expect(screen).not.toContain(v);
});

test('wrong answers are asked again at the SAME prompt: a publishable key, a secret key and an empty line at the token prompt', () => {
  const screen = pty(['bash', 'supabase/scripts/fake-pipeline-e2e.sh'], [[0.6, `${PUBLISHABLE}\r`], [0.6, `${SECRET}\r`], [0.6, `${CLASSIC}\r`],
    [0.4, `${PUBLISHABLE}\r`], [0.3, 'a@synthetic.test\r'], [0.3, 'pw-a\r'], [0.3, 'b@synthetic.test\r'], [0.3, 'pw-b\r'], [0.3, 'f@synthetic.test\r'], [0.3, 'pw-f\r']],
  { EXPECT_TOKEN: CLASSIC, EXPECT_PUBLISHABLE: PUBLISHABLE, EXPECT_FOUNDER_EMAIL: 'f@synthetic.test' });
  expect(screen).toContain('not accepted: a publishable key was given, not a personal access token — please answer this same prompt again');
  expect(screen).toContain('not accepted: a secret API key was given, not a personal access token');
  expect(screen.match(/Scoped Supabase access token \(sbp_…, hidden\): /g)).toHaveLength(3);
  expect(probe(screen), screen).toEqual({ SUPABASE_ACCESS_TOKEN: true, RRE_PUBLISHABLE_KEY: true, FOUNDER_EMAIL: true });
  for (const v of [SECRET, CLASSIC]) expect(screen).not.toContain(v);
});

test('a token pasted into a visible prompt is refused there and does not shift the later prompts', () => {
  const screen = pty(['bash', 'supabase/scripts/fake-pipeline-e2e.sh'], [[0.6, `${CLASSIC}\r`], [0.6, `${SCOPED}\r`], [0.6, `${PUBLISHABLE}\r`],
    [0.3, 'a@synthetic.test\r'], [0.3, 'pw-a\r'], [0.3, 'b@synthetic.test\r'], [0.3, 'pw-b\r'], [0.3, 'f@synthetic.test\r'], [0.3, 'pw-f\r']],
  { EXPECT_TOKEN: CLASSIC, EXPECT_PUBLISHABLE: PUBLISHABLE, EXPECT_FOUNDER_EMAIL: 'f@synthetic.test' });
  expect(screen).toContain('not accepted: that looks like a secret, not the publishable key');
  expect(probe(screen), screen).toEqual({ SUPABASE_ACCESS_TOKEN: true, RRE_PUBLISHABLE_KEY: true, FOUNDER_EMAIL: true });
});

test('three wrong answers in a row: refused, nothing started, nothing printed back', () => {
  const screen = pty(['bash', 'supabase/scripts/paid-pipeline-e2e.sh'], [[0.6, 'not-a-token\r'], [0.6, `${SECRET}\r`], [0.6, '\r']], EXPECT);
  expect(screen).toContain('refused: three answers in a row were not accepted; nothing was sent');
  expect(probe(screen)).toBeNull();
  expect(screen).not.toContain(SECRET);
});

// ---------------------------------------------------------------- the confirmation phrases
for (const [name, steps, c1, c2] of [
  ['typed exactly', [[1.6, 'PROVIDER-LIMIT-CONFIRMED\r'], [0.5, 'RUN-ONE-PAID-ANALYSIS\r']], 'ACCEPTED', 'ACCEPTED'],
  ['a trailing space from the keyboard', [[1.6, 'PROVIDER-LIMIT-CONFIRMED \r'], [0.5, 'RUN-ONE-PAID-ANALYSIS \r']], 'ACCEPTED', 'ACCEPTED'],
  ['Enter pressed twice after the first phrase', [[1.6, 'PROVIDER-LIMIT-CONFIRMED\r\r'], [0.5, 'RUN-ONE-PAID-ANALYSIS\r']], 'ACCEPTED', 'ACCEPTED'],
  ['Enter pressed while the script was busy', [[0.3, '\r'], [0.3, 'RUN-ONE-PAID-ANALYSIS\r'], [1.2, 'PROVIDER-LIMIT-CONFIRMED\r'], [0.5, 'RUN-ONE-PAID-ANALYSIS\r']], 'ACCEPTED', 'ACCEPTED'],
  ['a wrong phrase', [[1.6, 'PROVIDER-LIMIT-CONFIRMED\r'], [0.5, 'RUN-ONE-ANALYSIS\r']], 'ACCEPTED', 'REFUSED'],
  ['lower case', [[1.6, 'provider-limit-confirmed\r']], 'REFUSED', null],
  ['the phrase answered BEFORE its prompt, then something else after it', [[0.3, 'PROVIDER-LIMIT-CONFIRMED\r'], [1.4, 'yes\r']], 'REFUSED', null],
] as [string, Step[], string, string | null][]) {
  test(`confirmation under a real terminal: ${name}`, () => {
    const screen = pty(['node', DRIVER], steps);
    expect(screen, screen).toContain(`[c1 ${c1}]`);
    if (c2) expect(screen, screen).toContain(`[c2 ${c2}]`); else expect(screen).not.toContain('[c2 ');
  });
}

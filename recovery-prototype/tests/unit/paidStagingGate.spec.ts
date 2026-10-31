// The paid-staging gate (supabase/scripts/paid-staging-gate.mjs): it runs in a job with no secret
// and must refuse anything but a manual run of the authorised branch at exactly expected_sha,
// with the staging-paid environment protected. A local fake of the GitHub API stands in for GitHub.
import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ES module without type declarations
import { BRANCH, environmentProblems, runProblems } from '../../supabase/scripts/paid-staging-gate.mjs';

const GATE = fileURLToPath(new URL('../../supabase/scripts/paid-staging-gate.mjs', import.meta.url));
const tip = execFileSync('git', ['rev-parse', `refs/remotes/origin/${BRANCH}`], { encoding: 'utf8' }).trim();
const GOOD_RUN = { repository: 'INVESTOR-bnb/conversation-intelligence-engine', ref: `refs/heads/${BRANCH}`, eventName: 'workflow_dispatch',
  sha: tip, expectedSha: tip, target: 'paid-readiness', onBranch: true };
const GOOD_ENV = {
  name: 'staging-paid', can_admins_bypass: false,
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { login: 'INVESTOR-bnb' } }] }, { type: 'branch_policy' }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
const GOOD_POLICIES = { total_count: 1, branch_policies: [{ name: BRANCH, type: 'branch' }] };

test('run checks: only a manual dispatch of the authorised branch, a fixed paid target and exactly expected_sha pass', () => {
  expect(runProblems(GOOD_RUN)).toEqual([]);
  const bad: [Partial<typeof GOOD_RUN>, RegExp][] = [
    [{ repository: 'someone/fork-of-engine' }, /repository is not/],
    [{ ref: 'refs/heads/main' }, /not on the authorised branch/],
    [{ ref: `refs/pull/1/merge` }, /not on the authorised branch/],
    [{ eventName: 'push' }, /not started manually/],
    [{ eventName: 'pull_request_target' }, /not started manually/],
    [{ target: 'frontend' }, /target is not one of/],
    [{ target: 'paid-activate; rm -rf /' }, /target is not one of/],
    [{ expectedSha: '' }, /full 40-character/],
    [{ expectedSha: tip.slice(0, 7) }, /full 40-character/],
    [{ expectedSha: tip.toUpperCase() }, /full 40-character/],
    [{ expectedSha: `${tip}\n` }, /full 40-character/],
    [{ expectedSha: '$(id)'.padEnd(40, 'a') }, /full 40-character/],
    [{ expectedSha: 'f'.repeat(40) }, /does not equal the commit this run checked out/],
    [{ onBranch: false }, /is not a commit of/],
  ];
  for (const [over, want] of bad) expect(runProblems({ ...GOOD_RUN, ...over }).join(' | '), JSON.stringify(over)).toMatch(want);
});

test('environment checks: owner as required reviewer, no admin bypass, self-review allowed, exactly the authorised branch', () => {
  expect(environmentProblems(GOOD_ENV, GOOD_POLICIES)).toEqual([]);
  const cases: [unknown, unknown, RegExp][] = [
    [null, GOOD_POLICIES, /does not exist or could not be read/],
    [{ ...GOOD_ENV, protection_rules: [] }, GOOD_POLICIES, /not a required reviewer/],
    [{ ...GOOD_ENV, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'someone-else' } }] }] }, GOOD_POLICIES, /not a required reviewer/],
    [{ ...GOOD_ENV, protection_rules: [{ ...GOOD_ENV.protection_rules[0], prevent_self_review: true }] }, GOOD_POLICIES, /prevents self-review/],
    [{ ...GOOD_ENV, can_admins_bypass: true }, GOOD_POLICIES, /administrators may bypass/],
    [{ ...GOOD_ENV, deployment_branch_policy: null }, GOOD_POLICIES, /not limited to selected branches/],
    [{ ...GOOD_ENV, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, GOOD_POLICIES, /not limited to selected branches/],
    [GOOD_ENV, { branch_policies: [] }, /exactly one deployment branch/],
    [GOOD_ENV, { branch_policies: [{ name: BRANCH, type: 'branch' }, { name: 'main', type: 'branch' }] }, /exactly one deployment branch/],
    [GOOD_ENV, { branch_policies: [{ name: 'claude/*', type: 'branch' }] }, /exactly one deployment branch/],
    [GOOD_ENV, null, /exactly one deployment branch/],
  ];
  for (const [env, pol, want] of cases) expect(environmentProblems(env, pol).join(' | ')).toMatch(want);
});

// ---------------------------------------------------------------- the gate, run as in the workflow

let api: Server;
let API = '';
let answers: { env: unknown; policies: unknown } = { env: GOOD_ENV, policies: GOOD_POLICIES };
const seen: string[] = [];
test.beforeAll(async () => {
  api = createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization ? 'auth' : 'anon'}`);
    const body = req.url?.endsWith('/deployment-branch-policies') ? answers.policies : req.url?.endsWith('/environments/staging-paid') ? answers.env : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { message: 'Not Found' }));
  });
  API = await new Promise((r) => api.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(api.address() as { port: number }).port}`)));
});
test.afterAll(async () => { await new Promise((r) => api.close(r)); });

function gate(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [GATE], { env: { PATH: process.env.PATH ?? '', GITHUB_API_URL: API, GITHUB_REPOSITORY: GOOD_RUN.repository,
    GITHUB_REF: GOOD_RUN.ref, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: tip, EXPECTED_SHA: tip, TARGET: 'paid-activate', GITHUB_TOKEN: 'ghs_TESTONLYtoken', ...env },
  stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((r) => child.on('exit', (code) => r({ code, out })));
}

test('the gate passes a correct run with a protected environment, and checks the commit against the branch history', async () => {
  answers = { env: GOOD_ENV, policies: GOOD_POLICIES };
  const r = await gate({});
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain(`GATE PASSED: paid-activate at ${tip}`);
  expect(r.out).not.toContain('ghs_TESTONLYtoken');
  // a commit that is not on the branch (here: an unrelated hash) is refused even when it equals github.sha
  const other = 'e'.repeat(40);
  const r2 = await gate({ GITHUB_SHA: other, EXPECTED_SHA: other });
  expect(r2.code).toBe(1);
  expect(r2.out).toContain('is not a commit of');
});

test('the gate refuses before any secret exists: wrong repository, branch, event, SHA, target, or an unprotected environment', async () => {
  for (const [env, want] of [
    [{ GITHUB_REPOSITORY: 'attacker/conversation-intelligence-engine' }, 'repository is not'],
    [{ GITHUB_REF: 'refs/heads/main' }, 'not on the authorised branch'],
    [{ GITHUB_EVENT_NAME: 'pull_request' }, 'not started manually'],
    [{ EXPECTED_SHA: tip.slice(0, 12) }, 'full 40-character'],
    [{ EXPECTED_SHA: 'a'.repeat(40) }, 'does not equal the commit'],
    [{ TARGET: 'paid-everything' }, 'target is not one of'],
  ] as [Record<string, string>, string][]) {
    seen.length = 0;
    const r = await gate(env);
    expect(r.code, want).toBe(1);
    expect(r.out).toContain(want);
    expect(r.out).toContain('no secret was made available');
    expect(seen, 'the environment is not even read for a refused run').toEqual([]);
  }
  answers = { env: { ...GOOD_ENV, can_admins_bypass: true }, policies: GOOD_POLICIES };
  let r = await gate({});
  expect(r.code).toBe(1);
  expect(r.out).toContain('administrators may bypass');
  answers = { env: null, policies: null };
  r = await gate({});
  expect(r.code).toBe(1);
  expect(r.out).toContain('does not exist or could not be read');
  answers = { env: GOOD_ENV, policies: GOOD_POLICIES };
});

// The wa-preview approval gate: the founder must approve every job that enters the environment.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ES module without type declarations
import { BRANCH, environmentProblems, FOUNDER, runProblems } from '../../supabase/scripts/wa-preview-gate.mjs';

const FILE = readFileSync(fileURLToPath(new URL('../../../.github/workflows/deploy-recovery-prototype.yml', import.meta.url)), 'utf8');
const job = (name: string) => { const i = FILE.indexOf(`\n  ${name}:\n`); const rest = FILE.slice(i + 1); const j = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/); return j < 0 ? rest : rest.slice(0, j + 1); };
const SHA = 'a'.repeat(40);
const good = {
  name: 'wa-preview', can_admins_bypass: false,
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { login: FOUNDER } }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
const policies = { branch_policies: [{ name: BRANCH, type: 'branch' }] };

test('a correctly protected single-founder environment passes', () => {
  expect(environmentProblems(good, policies)).toEqual([]);
  expect(runProblems({ repository: 'INVESTOR-bnb/conversation-intelligence-engine', ref: `refs/heads/${BRANCH}`, eventName: 'workflow_dispatch',
    sha: SHA, expectedSha: SHA, target: 'wa-preview-gate-test', onBranch: true })).toEqual([]);
});

test('every missing protection is refused (absent, no reviewer, self-review blocked, admin bypass, any branch)', () => {
  expect(environmentProblems(null, policies)[0]).toMatch(/does not exist/);
  expect(environmentProblems({ ...good, protection_rules: [] }, policies).join()).toMatch(/not a required reviewer/);
  expect(environmentProblems({ ...good, protection_rules: [{ ...good.protection_rules[0], prevent_self_review: true }] }, policies).join()).toMatch(/self-review/);
  expect(environmentProblems({ ...good, can_admins_bypass: true }, policies).join()).toMatch(/bypass/);
  expect(environmentProblems({ ...good, deployment_branch_policy: null }, policies).join()).toMatch(/selected branches/);
  expect(environmentProblems(good, { branch_policies: [{ name: 'claude/revenue-recovery-engine-stage-1-8xg8vf' }] }).join()).toMatch(/exactly one/);
  expect(environmentProblems(good, { branch_policies: [...policies.branch_policies, { name: 'main' }] }).join()).toMatch(/exactly one/);
});

test('wrong branch, trigger, target or commit is refused', () => {
  const base = { repository: 'INVESTOR-bnb/conversation-intelligence-engine', ref: `refs/heads/${BRANCH}`, eventName: 'workflow_dispatch', sha: SHA, expectedSha: SHA, target: 'wa-preview-deploy', onBranch: true };
  expect(runProblems({ ...base, ref: 'refs/heads/claude/revenue-recovery-engine-stage-1-8xg8vf' }).join()).toMatch(/not on/);
  expect(runProblems({ ...base, eventName: 'push' }).join()).toMatch(/manually/);
  expect(runProblems({ ...base, target: 'paid-activate' }).join()).toMatch(/target/);
  expect(runProblems({ ...base, expectedSha: 'b'.repeat(40) }).join()).toMatch(/does not equal/);
  expect(runProblems({ ...base, onBranch: false }).join()).toMatch(/not a commit/);
});

test('workflow: the gate has no environment or secret; every wa-preview job needs it; the test job is harmless', () => {
  const gate = job('wa-preview-gate'); const testJob = job('wa-preview-gate-test'); const main = job('wa-preview');
  expect(gate).not.toMatch(/environment:|secrets\./);
  expect(gate).toContain('run: node supabase/scripts/wa-preview-gate.mjs');
  for (const j of [testJob, main]) {
    expect(j).toMatch(/\n {4}needs: wa-preview-gate\n/);
    expect(j).toContain("needs.wa-preview-gate.result == 'success'");
    expect(j).toContain('github.sha == inputs.expected_sha');
    expect(j).toMatch(/\n {4}environment: wa-preview\n/);
  }
  expect(testJob).not.toMatch(/secrets\.|vars\.|git |checkout|node |npx|curl|wrangler|supabase/);
  expect(testJob.match(/run: /g)).toHaveLength(1);
  expect(main).toContain("inputs.target != 'wa-preview-gate-test'");
});

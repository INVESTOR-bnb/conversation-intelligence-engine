#!/usr/bin/env node
// Gate for the isolated WhatsApp preview jobs. Runs in a job WITHOUT any environment or secret,
// before a job that uses the "wa-preview" environment may start. Exit 0 only if:
//   * the run is a manual dispatch of INVESTOR-bnb/conversation-intelligence-engine on
//     claude/whatsapp-integration, the target is a wa-preview-* target and expected_sha equals
//     the commit the run checked out and is on that branch;
//   * the environment "wa-preview" exists with the founder INVESTOR-bnb as a required reviewer,
//     self-review ALLOWED (single-founder account: the founder starts and approves the run),
//     administrators NOT allowed to bypass, and deployments limited to exactly that branch.
// Prints problems only (no token, no value).

import { execFileSync } from 'node:child_process';

export const REPOSITORY = 'INVESTOR-bnb/conversation-intelligence-engine';
export const FOUNDER = 'INVESTOR-bnb';
export const BRANCH = 'claude/whatsapp-integration';
export const ENVIRONMENT = 'wa-preview';
export const TARGETS = ['wa-preview-gate-test', 'wa-preview-preflight', 'wa-preview-deploy', 'wa-preview-founder', 'wa-preview-readiness'];
const SHA = /^[0-9a-f]{40}$/;

export function runProblems({ repository, ref, eventName, sha, expectedSha, target, onBranch }) {
  const p = [];
  if (repository !== REPOSITORY) p.push(`the repository is not ${REPOSITORY}`);
  if (eventName !== 'workflow_dispatch') p.push('the run was not started manually (workflow_dispatch)');
  if (ref !== `refs/heads/${BRANCH}`) p.push(`the run is not on ${BRANCH}`);
  if (!TARGETS.includes(target)) p.push('the target is not a wa-preview target');
  if (typeof expectedSha !== 'string' || !SHA.test(expectedSha)) p.push('expected_sha is not a full 40-character lower-case commit hash');
  else if (expectedSha !== sha) p.push('expected_sha does not equal the commit this run checked out (github.sha)');
  else if (onBranch !== true) p.push(`expected_sha is not a commit of ${BRANCH}`);
  return p;
}

export function environmentProblems(env, policies) {
  const p = [];
  if (!env || typeof env !== 'object' || env.name !== ENVIRONMENT) return [`the environment ${ENVIRONMENT} does not exist or could not be read`];
  const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
  const reviewerRules = rules.filter((r) => r?.type === 'required_reviewers');
  const reviewers = reviewerRules.flatMap((r) => (Array.isArray(r.reviewers) ? r.reviewers : []));
  if (!reviewers.some((r) => r?.type === 'User' && r?.reviewer?.login === FOUNDER)) p.push(`${FOUNDER} is not a required reviewer of ${ENVIRONMENT}`);
  if (reviewerRules.some((r) => r?.prevent_self_review === true)) p.push(`${ENVIRONMENT} prevents self-review, so the founder could never approve the run they start`);
  if (env.can_admins_bypass !== false) p.push(`administrators may bypass the protection of ${ENVIRONMENT} ("Allow administrators to bypass" must be off)`);
  const dbp = env.deployment_branch_policy;
  if (!dbp || dbp.custom_branch_policies !== true || dbp.protected_branches !== false) p.push(`${ENVIRONMENT} is not limited to selected branches`);
  const list = Array.isArray(policies?.branch_policies) ? policies.branch_policies : null;
  if (!list || list.length !== 1 || list[0]?.name !== BRANCH || (list[0]?.type !== undefined && list[0].type !== 'branch')) {
    p.push(`${ENVIRONMENT} must allow exactly one deployment branch: ${BRANCH}`);
  }
  return p;
}

async function getJson(path) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  for (const auth of [process.env.GITHUB_TOKEN ? `Bearer ${process.env.GITHUB_TOKEN}` : null, null]) {
    try {
      const res = await fetch(`${api}${path}`, { headers: auth ? { ...headers, authorization: auth } : headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
    } catch { /* try without the token, then give up */ }
  }
  return null;
}

async function main() {
  const expectedSha = process.env.EXPECTED_SHA ?? '';
  let onBranch = false;
  if (SHA.test(expectedSha)) {
    try { execFileSync('git', ['merge-base', '--is-ancestor', expectedSha, `refs/remotes/origin/${BRANCH}`], { stdio: 'ignore' }); onBranch = true; } catch { onBranch = false; }
  }
  const problems = runProblems({ repository: process.env.GITHUB_REPOSITORY ?? '', ref: process.env.GITHUB_REF, eventName: process.env.GITHUB_EVENT_NAME,
    sha: process.env.GITHUB_SHA, expectedSha, target: process.env.TARGET, onBranch });
  if (problems.length === 0) {
    const base = `/repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
    problems.push(...environmentProblems(await getJson(base), await getJson(`${base}/deployment-branch-policies`)));
  }
  for (const p of problems) console.log(`::error::GATE REFUSED: ${p}`);
  console.log(problems.length ? `GATE REFUSED (${problems.length} problem(s)); the wa-preview environment was not entered` : `GATE PASSED: ${process.env.TARGET} at ${expectedSha}; the wa-preview job now waits for ${FOUNDER}'s approval`);
  return problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();

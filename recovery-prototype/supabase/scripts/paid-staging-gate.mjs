#!/usr/bin/env node
// Gate for the paid-staging GitHub Actions job. Runs in a job WITHOUT any environment or secret,
// before the job that receives SUPABASE_ACCESS_TOKEN and KIMI_API_KEY may start. Exit 0 only if:
//   * the run is a manual dispatch, in INVESTOR-bnb/conversation-intelligence-engine, on the
//     authorised branch;
//   * the target is one of the fixed paid targets and expected_sha is a full 40-character commit
//     hash equal to the commit the run checked out (github.sha), and that commit is on the branch;
//   * the protected environment "staging-paid" exists with: the repository owner as a required
//     reviewer, administrators NOT allowed to bypass, self-review allowed (the owner starts and
//     approves the run), and deployments limited to exactly the authorised branch.
// It prints problems only (no token, no value). Inputs come from the environment, never a command line.

import { execFileSync } from 'node:child_process';

export const REPOSITORY = 'INVESTOR-bnb/conversation-intelligence-engine';
export const OWNER = 'INVESTOR-bnb';
export const BRANCH = 'claude/revenue-recovery-engine-stage-1-8xg8vf';
export const ENVIRONMENT = 'staging-paid';
export const TARGETS = ['paid-readiness', 'paid-activate', 'paid-deactivate', 'paid-deactivate-and-remove-key', 'paid-diagnose'];
const SHA = /^[0-9a-f]{40}$/;

/** Problems with the run itself (no network). */
export function runProblems({ repository, ref, eventName, sha, expectedSha, target, onBranch }) {
  const p = [];
  if (repository !== REPOSITORY) p.push(`the repository is not ${REPOSITORY}`);
  if (eventName !== 'workflow_dispatch') p.push('the run was not started manually (workflow_dispatch)');
  if (ref !== `refs/heads/${BRANCH}`) p.push(`the run is not on the authorised branch ${BRANCH}`);
  if (!TARGETS.includes(target)) p.push('the target is not one of the paid-staging targets');
  if (typeof expectedSha !== 'string' || !SHA.test(expectedSha)) p.push('expected_sha is not a full 40-character lower-case commit hash');
  else if (expectedSha !== sha) p.push('expected_sha does not equal the commit this run checked out (github.sha)');
  else if (onBranch !== true) p.push(`expected_sha is not a commit of ${BRANCH}`);
  return p;
}

/** Problems with the environment's protection (GitHub API answers, parsed). */
export function environmentProblems(env, policies) {
  const p = [];
  if (!env || typeof env !== 'object' || env.name !== ENVIRONMENT) return [`the environment ${ENVIRONMENT} does not exist or could not be read`];
  const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
  const reviewers = rules.filter((r) => r?.type === 'required_reviewers').flatMap((r) => (Array.isArray(r.reviewers) ? r.reviewers : []));
  if (!reviewers.some((r) => r?.type === 'User' && r?.reviewer?.login === OWNER)) p.push(`${OWNER} is not a required reviewer of ${ENVIRONMENT}`);
  if (rules.some((r) => r?.type === 'required_reviewers' && r?.prevent_self_review === true)) {
    p.push(`${ENVIRONMENT} prevents self-review, so the owner could never approve the run they start`);
  }
  if (env.can_admins_bypass !== false) p.push(`administrators may bypass the protection of ${ENVIRONMENT}`);
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
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const expectedSha = process.env.EXPECTED_SHA ?? '';
  let onBranch = false;
  if (SHA.test(expectedSha)) {
    try { execFileSync('git', ['merge-base', '--is-ancestor', expectedSha, `refs/remotes/origin/${BRANCH}`], { stdio: 'ignore' }); onBranch = true; } catch { onBranch = false; }
  }
  const problems = runProblems({ repository, ref: process.env.GITHUB_REF, eventName: process.env.GITHUB_EVENT_NAME, sha: process.env.GITHUB_SHA,
    expectedSha, target: process.env.TARGET, onBranch });
  if (problems.length === 0) {
    const base = `/repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
    problems.push(...environmentProblems(await getJson(base), await getJson(`${base}/deployment-branch-policies`)));
  }
  for (const p of problems) console.log(`::error::GATE REFUSED: ${p}`);
  console.log(problems.length ? `GATE REFUSED (${problems.length} problem(s)); no secret was made available` : `GATE PASSED: ${process.env.TARGET} at ${expectedSha}`);
  return problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();

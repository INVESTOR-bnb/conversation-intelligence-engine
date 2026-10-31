// The paid-staging jobs of the "Deploy recovery prototype" GitHub Actions workflow (they live in
// that already-registered workflow so they can be started manually from the development branch):
// what they may and may not do, and that the frontend job is unchanged by them.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = readFileSync(fileURLToPath(new URL('../../../.github/workflows/deploy-recovery-prototype.yml', import.meta.url)), 'utf8');
const section = (from: string, to?: string) => FILE.slice(FILE.indexOf(from), to ? FILE.indexOf(to) : undefined);
const FRONTEND = section('\n  deploy:\n', '\n  # ------------------------------------------------------------------ paid staging');
const PAID = section('\n  # ------------------------------------------------------------------ paid staging');
const GATE = section('\n  paid-gate:\n', '\n  paid-staging:\n');
const JOB = section('\n  paid-staging:\n');
const noComments = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

/** Every shell command in a section (single-line `run:` and `run: |` blocks). */
function runBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s+)run: (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] !== '|' && m[2] !== '>') { blocks.push(m[2]); continue; }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) body.push(lines[j]);
    blocks.push(body.join('\n'));
  }
  return blocks;
}
const ifOf = (job: string) => /\n {4}if: >-\n((?: {6}.*\n)+)/.exec(job)?.[1].replace(/\s+/g, ' ').trim() ?? '';

test('manual only: no push, pull request, fork, schedule or other trigger; read-only repository permissions everywhere', () => {
  expect(FILE).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
  expect(FILE).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch|issue_comment):/m);
  expect(FILE).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(FILE).not.toMatch(/:\s*write\b/);
  for (const job of [GATE, JOB]) expect(job).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
  expect(FILE).toContain('options: [frontend, paid-readiness, paid-activate, paid-deactivate, paid-deactivate-and-remove-key]');
  expect(FILE).toMatch(/expected_sha:\n {8}description: [^\n]+\n {8}type: string\n/);
});

test('only this repository, this branch and a manual dispatch; the secret job needs the gate and the exact SHA', () => {
  for (const job of [GATE, JOB]) {
    const cond = ifOf(job);
    expect(cond).toContain("github.repository == 'INVESTOR-bnb/conversation-intelligence-engine'");
    expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    expect(cond).toContain("github.ref == 'refs/heads/claude/revenue-recovery-engine-stage-1-8xg8vf'");
    expect(cond).toContain("startsWith(inputs.target, 'paid-')");
  }
  expect(JOB).toMatch(/\n {4}needs: paid-gate\n/);
  expect(ifOf(JOB)).toContain('github.sha == inputs.expected_sha');
  expect(ifOf(JOB)).toContain("needs.paid-gate.result == 'success'");
  expect(GATE).toContain('run: node supabase/scripts/paid-staging-gate.mjs');
});

test('the gate job has no environment and no secret; secrets exist only in the paid job, in exactly three steps, as environment variables', () => {
  expect(GATE).not.toMatch(/environment:|secrets\./);
  expect(JOB).toMatch(/\n {4}environment: staging-paid\n/);
  const secretLines = noComments(PAID).split('\n').filter((l) => l.includes('secrets.'));
  expect(secretLines.map((l) => l.trim())).toEqual([
    "HAS_SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN != '' }}",
    "HAS_KIMI_API_KEY: ${{ secrets.KIMI_API_KEY != '' }}",
    'SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}',
    'SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}',
    'KIMI_API_KEY: ${{ secrets.KIMI_API_KEY }}',
  ]);
  expect(FRONTEND).not.toMatch(/SUPABASE_ACCESS_TOKEN|KIMI_API_KEY/);
});

test('no third-party action in the paid jobs (so nothing to pin); any action used there would have to be a full commit SHA', () => {
  const uses = [...PAID.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
  expect(uses).toEqual([]);
  for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
});

test('checkout persists no credential and fetches only the authorised branch, at exactly expected_sha', () => {
  const runs = runBlocks(PAID).join('\n');
  expect(runs.match(/git fetch -q --no-tags origin "\+refs\/heads\/\$BRANCH:refs\/remotes\/origin\/\$BRANCH"/g)).toHaveLength(2);
  expect(runs.match(/git checkout -q -B "\$BRANCH" "\$EXPECTED_SHA"/g)).toHaveLength(2);
  expect(runs).not.toMatch(/extraheader|credential|x-access-token|GITHUB_TOKEN|git config/);
  expect(PAID).not.toMatch(/persist-credentials: true|actions\/checkout/);
  expect(runs).toContain('[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] && [ "$EXPECTED_SHA" = "$GITHUB_SHA" ]');
});

test('one paid-staging operation at a time, never cancelled once started; timeouts on both jobs', () => {
  expect(JOB).toMatch(/\n {4}concurrency:\n {6}group: paid-staging-supabase-aqwdwswpmbnzmkvyuqil\n {6}cancel-in-progress: false\n/);
  expect(FILE.match(/group: paid-staging-supabase-aqwdwswpmbnzmkvyuqil/g)).toHaveLength(1);
  expect(GATE).toMatch(/\n {4}timeout-minutes: 15\n/);
  expect(JOB).toMatch(/\n {4}timeout-minutes: 20\n/);
  expect(FRONTEND).toMatch(/\n {4}concurrency:\n {6}group: cloudflare-pages-revenue-recovery-v0\n {6}cancel-in-progress: false\n/);
});

test('no input or secret is interpolated into a shell command; the target maps through a fixed list', () => {
  const runs = runBlocks(PAID);
  expect(runs.length).toBeGreaterThanOrEqual(8);
  for (const r of runs) expect(r, r).not.toMatch(/\$\{\{/);
  const last = runs[runs.length - 1];
  expect(last).toMatch(/case "\$TARGET" in\n\s+paid-readiness\) action=readiness ;;\n\s+paid-activate\) action=activate ;;\n\s+paid-deactivate\) action=deactivate ;;\n\s+paid-deactivate-and-remove-key\) action=deactivate-and-remove-key ;;\n\s+\*\) echo "::error::unknown target"; exit 1 ;;\n\s+esac\n\s+node supabase\/scripts\/paid-staging\.mjs "\$action"/);
});

test('no tracing, no artifact, no cache, no install scripts in the gate, and no install at all in the secret job', () => {
  expect(PAID).not.toMatch(/set -x|set -o xtrace|ACTIONS_STEP_DEBUG|upload-artifact|actions\/cache|cache:|printenv|env \|/);
  expect(GATE).toContain('npm ci --no-audit --no-fund --ignore-scripts');
  expect(JOB).not.toMatch(/npm ci|npm install|npx playwright/);
});

test('the paid job deploys code without touching the provider, configures Kimi through the tool, and never starts an analysis', () => {
  const code = noComments(PAID);
  expect(code).toContain('run: bash supabase/scripts/deploy-analyze-case-2a6d.sh\n');
  expect(code).not.toMatch(/--set-fake|--rollback|ANALYSIS_PROVIDER=fake|ALLOW_FAKE_PROVIDER/);
  expect(code).not.toMatch(/paid-pipeline-e2e|fake-pipeline-e2e|functions\/v1|analyze-case-live-check|moonshot/i);
});

test('the frontend job runs only for target frontend and carries no Supabase or Kimi secret', () => {
  expect(FRONTEND).toContain("if: github.ref == 'refs/heads/claude/revenue-recovery-engine-stage-1-8xg8vf' && (inputs.target == 'frontend' || inputs.target == '')");
  expect(FRONTEND).not.toMatch(/environment:|paid-staging|deploy-analyze-case/);
  expect(FRONTEND).toContain('npx --yes wrangler@4.141.0 pages deploy dist');
});

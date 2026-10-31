// The paid-staging job of the "Deploy recovery prototype" GitHub Actions workflow (it lives in
// that already-registered workflow so it can be started manually from the development branch):
// what it may and may not do, and that the frontend job is unchanged by it.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = readFileSync(fileURLToPath(new URL('../../../.github/workflows/deploy-recovery-prototype.yml', import.meta.url)), 'utf8');
/** The paid-staging job only. */
const WF = FILE.slice(FILE.indexOf('\n  paid-staging:\n'));
const FRONTEND = FILE.slice(FILE.indexOf('\n  deploy:\n'), FILE.indexOf('\n  paid-staging:\n'));
const code = WF.split('\n').filter((l) => !l.trim().startsWith('#'));
/** Every shell command the workflow runs (single-line `run:` and `run: |` blocks). */
function runBlocks(): string[] {
  const lines = WF.split('\n');
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

test('manual only, from the development branch only, in the protected staging-paid environment, read-only repository access', () => {
  expect(FILE).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
  expect(FILE).not.toMatch(/^\s+(push|pull_request|schedule|workflow_run|repository_dispatch):/m);
  expect(FILE).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(FILE).toContain('default: frontend');
  expect(FILE).toContain('options: [frontend, paid-readiness, paid-activate, paid-deactivate, paid-deactivate-and-remove-key]');
  expect(WF).toContain("if: github.ref == 'refs/heads/claude/revenue-recovery-engine-stage-1-8xg8vf' && startsWith(inputs.target, 'paid-')");
  expect(WF).toMatch(/^ {4}environment: staging-paid$/m);
});

test('the frontend job runs only for target frontend and is otherwise unchanged (no Supabase or Kimi secret)', () => {
  expect(FRONTEND).toContain("if: github.ref == 'refs/heads/claude/revenue-recovery-engine-stage-1-8xg8vf' && (inputs.target == 'frontend' || inputs.target == '')");
  expect(FRONTEND).not.toMatch(/SUPABASE_ACCESS_TOKEN|KIMI_API_KEY|environment:|paid-staging\.mjs|deploy-analyze-case/);
  expect(FRONTEND).toContain('npx --yes wrangler@4.141.0 pages deploy dist');
});

test('secrets reach steps only as environment variables (never a command line), with no shell tracing or echo of a value', () => {
  const secretLines = code.filter((l) => l.includes('secrets.'));
  expect(secretLines.length).toBeGreaterThan(0);
  for (const l of secretLines) expect(l, l).toMatch(/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+( != '')? \}\}$/);
  const runs = runBlocks();
  expect(runs.length).toBeGreaterThanOrEqual(5);
  for (const r of runs) expect(r, r).not.toMatch(/secrets\.|\$\{\{/);
  expect(WF).not.toMatch(/set -x|set -o xtrace|ACTIONS_STEP_DEBUG|echo "?\$(SUPABASE_ACCESS_TOKEN|KIMI_API_KEY)/);
  expect(WF).toContain('persist-credentials: false');
});

test('it deploys code without touching the provider, configures Kimi through the tool, and never starts an analysis', () => {
  expect(WF).toContain('run: bash supabase/scripts/deploy-analyze-case-2a6d.sh\n');
  expect(code.join('\n')).not.toMatch(/--set-fake|--rollback|ANALYSIS_PROVIDER=fake|ALLOW_FAKE_PROVIDER/);
  expect(WF).toContain('run: node supabase/scripts/paid-staging.mjs "${TARGET#paid-}"');
  expect(code.join('\n')).not.toMatch(/paid-pipeline-e2e|fake-pipeline-e2e|functions\/v1|analyze-case-live-check|moonshot/i);
});

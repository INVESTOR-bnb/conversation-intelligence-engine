// Stage 2A-6d — the deployment safeguards, offline:
//   * function-source-guard.mjs on the real tree, the previous fake-only tree and injected violations;
//   * the paid script's price table equals the code allowlist (and so the 2A-6c migration);
//   * deploy-analyze-case-2a6d.sh run for real against a throwaway clone with a FAKE Supabase CLI
//     (records its arguments; makes no connection): refusals, the fake-only deployment, rollback.
// No network, no credentials (synthetic token shapes only), no provider.

import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ANTHROPIC_MODELS } from '../../supabase/functions/_shared/edge/anthropicProvider.ts';
import { deployedProblems, readTree, sourceProblems } from '../../supabase/scripts/function-source-guard.mjs';

const APP = fileURLToPath(new URL('../..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const FUNCTIONS = join(APP, 'supabase', 'functions');
const BRANCH = 'claude/revenue-recovery-engine-stage-1-8xg8vf';
const REF = 'aqwdwswpmbnzmkvyuqil';
const TOKEN = `sbp_${'0123456789abcdef'.repeat(2)}0123456789`;

type File = { path: string; text: string };
const tree = () => readTree(FUNCTIONS) as File[];
const edit = (files: File[], path: string, f: (t: string) => string) => files.map((x) => (x.path === path ? { ...x, text: f(x.text) } : x));
function oldTree(): File[] {
  const git = (...a: string[]) => spawnSync('git', a, { cwd: FUNCTIONS, encoding: 'utf8', maxBuffer: 20_000_000 }).stdout;
  return git('ls-tree', '-r', '--name-only', '9ee3767', '--', '.').split('\n').filter(Boolean).map((p) => ({ path: p, text: git('show', `9ee3767:./${p}`) }));
}

// ---------------------------------------------------------------- the source guard

test('source guard: the current function code passes; the previous fake-only code is not the reviewed Anthropic-capable version', () => {
  expect(sourceProblems(tree())).toEqual([]);
  const old = sourceProblems(oldTree());
  expect(old).toContain('analyze-case/index.ts does not import the pinned SDK npm:@anthropic-ai/sdk@0.133.0');
  expect(old).toContain('a reviewed safeguard is missing: CAP_NOT_APPROVED');
});

test('source guard: each forbidden pattern is caught', () => {
  const t = tree();
  const cases: [string, File[], RegExp][] = [
    ['a key literal', [...t, { path: '_shared/edge/k.ts', text: `export const K = 'sk-ant-api03-${'A'.repeat(40)}';` }], /shaped like an Anthropic key/],
    ['another npm library', edit(t, '_shared/edge/handler.ts', (s) => `import x from 'npm:openai@4.0.0';\n${s}`), /imports "npm:openai@4.0.0"|mentions OpenAI/],
    ['a jsr import', edit(t, '_shared/edge/handler.ts', (s) => `import { y } from 'jsr:@std/http';\n${s}`), /imports "jsr:@std\/http"/],
    ['a URL import', edit(t, '_shared/edge/handler.ts', (s) => `import 'https://esm.sh/x';\n${s}`), /imports "https:\/\/esm.sh\/x"/],
    ['a bare import', edit(t, '_shared/edge/config.ts', (s) => `import a from '@anthropic-ai/sdk';\n${s}`), /imports "@anthropic-ai\/sdk"/],
    ['the SDK imported outside the entry point', edit(t, '_shared/edge/handler.ts', (s) => `import A from 'npm:@anthropic-ai/sdk@0.133.0';\n${s}`), /handler.ts: imports "npm:@anthropic-ai\/sdk@0.133.0"/],
    ['another SDK version', edit(t, 'analyze-case/index.ts', (s) => s.replace('@0.133.0', '@0.134.0')), /does not import the pinned SDK/],
    ['a dynamic import', edit(t, '_shared/edge/handler.ts', (s) => `${s}\nconst m = await import('npm:x');`), /dynamic import/],
    ['the endpoint elsewhere', edit(t, '_shared/edge/handler.ts', (s) => `${s}\n// https://api.anthropic.com/v1/messages`), /handler.ts: names the Anthropic endpoint/],
    ['retries', edit(t, '_shared/edge/anthropicProvider.ts', (s) => s.replace('maxRetries: 0, timeout: SDK_TIMEOUT_MS, logLevel', 'maxRetries: 2, timeout: SDK_TIMEOUT_MS, logLevel')), /maxRetries above 0/],
    ['a fallbacks parameter', edit(t, '_shared/edge/anthropicProvider.ts', (s) => s.replace("    inference_geo: 'global',", "    inference_geo: 'global',\n    fallbacks: ['x'],")), /fallbacks parameter/],
    ['the staging-only guard weakened', edit(t, '_shared/edge/config.ts', (s) => s.replace("'https://aqwdwswpmbnzmkvyuqil.supabase.co'", "'https://other.supabase.co'")), /safeguard is missing: STAGING_URL/],
    // markers are a fingerprint of the reviewed version (behaviour is proven by the pipeline tests): removed everywhere
    ['the unsafe-environment refusal removed', t.map((f) => ({ ...f, text: f.text.replaceAll('PROVIDER_ENV_UNSAFE', 'X') })), /safeguard is missing: PROVIDER_ENV_UNSAFE/],
    ['the approved-cap check removed', edit(t, '_shared/analysis-pipeline/pipeline.ts', (s) => s.replaceAll('CAP_NOT_APPROVED', 'X')), /safeguard is missing: CAP_NOT_APPROVED/],
  ];
  for (const [name, files, want] of cases) expect(sourceProblems(files).join('\n'), name).toMatch(want);
});

test('deployed-bundle guard: the reviewed code passes (even bundled with SDK text); a key, or the old code, does not', () => {
  const bundle = tree().map((f) => `// ${f.path}\n${f.text}`).join('\n');
  expect(deployedProblems(`${bundle}\n// sdk: x-api-key api.anthropic.com ANTHROPIC_API_KEY`)).toEqual([]);
  expect(deployedProblems(`${bundle}\nconst k = "sk-ant-api03-${'b'.repeat(30)}";`)).toContain('the deployed source contains something shaped like an Anthropic key');
  expect(deployedProblems(oldTree().map((f) => f.text).join('\n')).join('\n')).toMatch(/not the reviewed Anthropic-capable version/);
  expect(deployedProblems('')).toEqual(['the deployed source could not be read']);
});

test('the paid script\'s price table equals the code allowlist (and so the 2A-6c migration)', () => {
  const src = readFileSync(join(APP, 'supabase', 'scripts', 'paid-pipeline-e2e.mjs'), 'utf8');
  const rows = Object.fromEntries([...src.matchAll(/'(claude-[a-z0-9-]+)': Object\.freeze\(\{ in: ([0-9.]+), out: ([0-9.]+), cap: ([0-9]+) \}\)/g)]
    .map((m) => [m[1], { in: Number(m[2]), out: Number(m[3]), cap: Number(m[4]) }]));
  expect(rows).toEqual(Object.fromEntries(Object.entries(ANTHROPIC_MODELS).map(([k, v]) => [k, { in: v.inputPerMTok, out: v.outputPerMTok, cap: v.approvedOutputCap }])));
  expect(src).toMatch(/const RUN_BUDGET_MAX_USD = 3;/);
  expect(src).toMatch(/const EVAL_CEILING_USD = 15;/);
});

test('scripts: the staging project is the only target; no JWT bypass, no prune, no provider key written by the deploy script', () => {
  const deploy = readFileSync(join(APP, 'supabase', 'scripts', 'deploy-analyze-case-2a6d.sh'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  expect(deploy).toMatch(/^REF=aqwdwswpmbnzmkvyuqil$/m);
  expect(deploy.match(/--project-ref/g)).toHaveLength(1);
  expect(deploy).not.toMatch(/--no-verify-jwt|--prune|verify_jwt = false|ANTHROPIC_API_KEY=|ANALYSIS_PROVIDER=anthropic|ALLOW_PAID_PROVIDER=/);
  expect(deploy).toContain('cli secrets set ANALYSIS_PROVIDER=fake ALLOW_FAKE_PROVIDER=staging-only');
  const paid = readFileSync(join(APP, 'supabase', 'scripts', 'paid-pipeline-e2e.mjs'), 'utf8');
  expect(paid).toMatch(/^const REF = 'aqwdwswpmbnzmkvyuqil';$/m);
  expect(paid.match(/\/v1\/projects\/\$\{REF\}/g)).toHaveLength(1);
  const off = readFileSync(join(APP, 'supabase', 'deploy', 'stage2a6d_paid_off.sql'), 'utf8').split('\n').filter((l) => !l.startsWith('--'));
  expect(off.filter((l) => /^\s*(update|delete|insert|alter|drop|create|grant|revoke|truncate)\b/i.test(l))).toEqual([
    'update private.ai_spend_config set enabled = false, updated_at = now() where id;',
    "update private.ai_model_prices set active = false where model in ('claude-opus-5-5', 'claude-sonnet-5-5');",
  ]);
});

// ---------------------------------------------------------------- the deploy script, run for real (fake CLI)

/**
 * A throwaway clone of the pushed branch with THIS working tree's function code and Stage 2A-6d
 * scripts committed and pushed to a local bare origin; a fake `npx` that records every CLI call.
 */
function deployEnv(opts: { secrets?: unknown; failOn?: string; extraFile?: [string, string]; at?: string; branch?: string; dirty?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-2a6d-'));
  const clone = join(dir, 'clone');
  const r = spawnSync('git', ['clone', '-q', '--branch', BRANCH, REPO, clone], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const g = (...a: string[]) => spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
  if (opts.at) g('reset', '-q', '--hard', opts.at);
  const app = join(clone, 'recovery-prototype');
  if (!opts.at) {
    rmSync(join(app, 'supabase', 'functions'), { recursive: true, force: true });
    cpSync(FUNCTIONS, join(app, 'supabase', 'functions'), { recursive: true });
    for (const f of ['deploy-analyze-case-2a6d.sh', 'function-source-guard.mjs']) cpSync(join(APP, 'supabase', 'scripts', f), join(app, 'supabase', 'scripts', f));
  } else {
    for (const f of ['deploy-analyze-case-2a6d.sh', 'function-source-guard.mjs']) cpSync(join(APP, 'supabase', 'scripts', f), join(app, 'supabase', 'scripts', f));
  }
  if (opts.extraFile) writeFileSync(join(app, opts.extraFile[0]), opts.extraFile[1]);
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@synthetic.invalid', 'commit', '-q', '--allow-empty', '-m', 'the working tree under test');
  spawnSync('git', ['clone', '-q', '--bare', clone, `${clone}.git`]);
  g('remote', 'set-url', 'origin', `${clone}.git`);
  if (opts.branch) g('checkout', '-q', '-b', opts.branch);
  if (opts.dirty) writeFileSync(join(app, 'supabase', 'functions', 'stray.ts'), '// local change\n');
  const bin = join(dir, 'bin');
  const log = join(dir, 'npx.jsonl');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const wd = args.includes('--workdir') ? args[args.indexOf('--workdir') + 1] : process.cwd();
const cfg = path.join(wd, 'supabase', 'config.toml');
if (args.includes('init')) { fs.mkdirSync(path.join(process.cwd(), 'supabase'), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), 'supabase', 'config.toml'), 'project_id = "x"\\n'); }
const has = (p) => fs.existsSync(path.join(wd, 'supabase', 'functions', p));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, tokenInEnv: process.env.SUPABASE_ACCESS_TOKEN === ${JSON.stringify(TOKEN)},
  anthropicCode: has('_shared/edge/anthropicProvider.ts'), fakeCode: has('_shared/edge/fakeProvider.ts'),
  verifyJwtOn: fs.existsSync(cfg) && /\\[functions\\.analyze-case\\]\\nverify_jwt = true\\n/.test(fs.readFileSync(cfg, 'utf8')) }) + '\\n');
if (args.includes('secrets') && args.includes('list')) process.stdout.write(${JSON.stringify(typeof opts.secrets === 'string' ? opts.secrets : JSON.stringify(opts.secrets ?? [{ name: 'ANALYSIS_PROVIDER', value: 'x' }, { name: 'ALLOW_FAKE_PROVIDER', value: 'y' }]))});
process.exit(${JSON.stringify(opts.failOn ?? '')} && args.includes(${JSON.stringify(opts.failOn ?? '')}) ? 1 : 0);
`);
  chmodSync(join(bin, 'npx'), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const deploy = (input: string, ...args: string[]) => {
    const res = spawnSync('bash', ['supabase/scripts/deploy-analyze-case-2a6d.sh', ...args], { cwd: app, input, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 60_000 });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  };
  return { app, calls, deploy, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const OK = `${REF}\n${TOKEN}\n`;
type Call = { args: string[]; tokenInEnv: boolean; anthropicCode: boolean; fakeCode: boolean; verifyJwtOn: boolean };
const cli = (c: Call) => c.args.slice(2).filter((a) => a !== '--project-ref' && a !== REF && a !== '--workdir' && !a.startsWith('/')).join(' ');

test('deploy: the Anthropic-capable code, analyze-case only, JWT check on, settings set to the fake provider only', () => {
  const d = deployEnv();
  try {
    const { code, out } = d.deploy(OK);
    expect(code, out).toBe(0);
    const calls = d.calls() as Call[];
    expect(calls.map(cli)).toEqual(['init', 'secrets list -o json', 'functions deploy analyze-case --use-api', 'secrets set ANALYSIS_PROVIDER=fake ALLOW_FAKE_PROVIDER=staging-only']);
    const dep = calls[2];
    expect(dep.anthropicCode && dep.fakeCode && dep.verifyJwtOn && dep.tokenInEnv).toBe(true);
    expect(calls.slice(1).every((c) => c.tokenInEnv && c.args.includes(REF))).toBe(true);
    expect(out).not.toContain(TOKEN);
    expect(JSON.stringify(calls)).not.toMatch(/no-verify-jwt|--prune|ANTHROPIC|ALLOW_PAID|anthropic\b/);
  } finally { d.cleanup(); }
});

test('rollback: redeploys the previous fake-only code (9ee3767) with the fake settings', () => {
  const d = deployEnv();
  try {
    const { code, out } = d.deploy(OK, '--rollback');
    expect(code, out).toBe(0);
    const calls = d.calls() as Call[];
    expect(calls.map(cli)).toEqual(['init', 'secrets list -o json', 'functions deploy analyze-case --use-api', 'secrets set ANALYSIS_PROVIDER=fake ALLOW_FAKE_PROVIDER=staging-only']);
    expect(calls[2].anthropicCode).toBe(false);
    expect(calls[2].fakeCode && calls[2].verifyJwtOn).toBe(true);
    expect(out).toContain('the previous fake-only code (9ee3767)');
  } finally { d.cleanup(); }
});

test('deploy and rollback refuse while a paid-provider setting is present (nothing deployed)', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'ALLOW_PAID_PROVIDER', 'ANALYST_MODEL', 'REVIEWER_MODEL', 'ANTHROPIC_BASE_URL']) {
    for (const args of [[], ['--rollback']]) {
      const d = deployEnv({ secrets: [{ name: 'ANALYSIS_PROVIDER', value: 'x' }, { name, value: 'digest' }] });
      try {
        const { code, out } = d.deploy(OK, ...args);
        expect(code, `${name} ${args}`).toBe(2);
        expect(out).toContain('a paid-provider setting is present');
        expect(out).toContain('paid-pipeline-e2e.sh --paid-off');
        expect((d.calls() as Call[]).map(cli)).toEqual(['init', 'secrets list -o json']);
      } finally { d.cleanup(); }
    }
  }
});

test('deploy refuses unreadable settings, a wrong reference, a malformed token, and code failing the source guard', () => {
  const cases: [string, Parameters<typeof deployEnv>[0], string, string][] = [
    ['unreadable settings list', { secrets: 'not json' }, OK, 'could not read the function settings'],
    ['settings list not a list', { secrets: { name: 'x' } }, OK, 'could not read the function settings'],
    ['wrong project reference', {}, `productionref0000000000\n${TOKEN}\n`, 'the project reference was not confirmed'],
    ['a malformed token', {}, `${REF}\nnot-a-token\n`, 'not a Supabase personal access token'],
    ['a key literal committed in the function code', { extraFile: ['supabase/functions/_shared/edge/leak.ts', `export const K = 'sk-ant-api03-${'C'.repeat(40)}';\n`] }, OK, 'failed the source guard'],
    ['another library committed', { extraFile: ['supabase/functions/_shared/edge/other.ts', "import x from 'npm:left-pad@1.3.0';\nexport default x;\n"] }, OK, 'failed the source guard'],
  ];
  for (const [name, opts, input, want] of cases) {
    const d = deployEnv(opts);
    try {
      const { code, out } = d.deploy(input);
      expect(code, name).toBe(2);
      expect(out, name).toContain(want);
      expect((d.calls() as Call[]).some((c) => c.args.includes('deploy') || c.args.includes('set')), name).toBe(false);
      expect(out, name).not.toContain(TOKEN);
    } finally { d.cleanup(); }
  }
});

test('deploy refuses the wrong branch, a dirty checkout, an unpushed commit, a checkout without Stage 2A-6c, and unknown options', () => {
  const run = (opts: Parameters<typeof deployEnv>[0], tweak: (d: ReturnType<typeof deployEnv>) => void, args: string[] = []) => {
    const d = deployEnv(opts);
    try { tweak(d); return d.deploy(OK, ...args); } finally { d.cleanup(); }
  };
  expect(run({ branch: 'other' }, () => {})).toMatchObject({ code: 2, out: expect.stringContaining('not on claude/revenue-recovery-engine-stage-1-8xg8vf') });
  expect(run({ dirty: true }, () => {})).toMatchObject({ code: 2, out: expect.stringContaining('uncommitted or untracked') });
  expect(run({}, (d) => { spawnSync('git', ['-C', d.app, '-c', 'user.name=t', '-c', 'user.email=t@x.invalid', 'commit', '-q', '--allow-empty', '-m', 'unpushed']); }))
    .toMatchObject({ code: 2, out: expect.stringContaining('differs from the pushed branch') });
  expect(run({ at: '2c0c70dbc28cb11cd1e39e3f6681bb889376daf3' }, () => {})).toMatchObject({ code: 2, out: expect.stringContaining('does not contain Stage 2A-6c') });
  expect(run({}, () => {}, ['--prune'])).toMatchObject({ code: 2, out: expect.stringContaining('unknown option') });
});

test('a failed deployment sets no settings', () => {
  const d = deployEnv({ failOn: 'deploy' });
  try {
    const { code, out } = d.deploy(OK);
    expect(code).toBe(1);
    expect(out).toContain('DEPLOY FAILED');
    expect((d.calls() as Call[]).some((c) => c.args.includes('set'))).toBe(false);
  } finally { d.cleanup(); }
});

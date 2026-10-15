#!/usr/bin/env node
// Stage 2A-6d (Kimi-aware since 2A-6e) — ONE guarded, PAID, synthetic analysis on the STAGING
// project, through the deployed analyze-case function and ONE paid provider, chosen explicitly
// with PAID_PROVIDER: 'anthropic' (Anthropic API, Stage 2A-6c prices) or 'kimi' (Moonshot
// kimi-k3 for both analyst and reviewer, Stage 2A-6e price). Anything else is refused. Run it yourself, only after a separate
// founder approval (Android: GitHub Codespace): bash supabase/scripts/paid-pipeline-e2e.sh
// Recovery (paid provider OFF; nothing else is changed):
//   bash supabase/scripts/paid-pipeline-e2e.sh --paid-off
//
// What it does, in this order:
//  1. Read-only audit (Management API, scoped access token), refusing on any surprise:
//     spending DISABLED; the only active model is the free fake; the chosen provider's price
//     rows exist exactly as reviewed (2A-6c / 2A-6e) and are INACTIVE; no unsettled reservation;
//     analyze-case ACTIVE with verify_jwt ON, its deployed source the reviewed version
//     (function-source-guard.mjs; for Kimi also the Kimi-capable adapter); its settings fake,
//     with no provider key or paid setting (Anthropic or Kimi). Three synthetic accounts sign
//     in; client A creates and submits ONE synthetic text case. The database's own estimate of the most this case can
//     cost with the chosen models must be within the run budget (at most USD 3), the database's
//     USD 1 per-analysis limit and the provider-side spending limit you state.
//  2. Two typed confirmations: PROVIDER-LIMIT-CONFIRMED (the provider account of this key has a
//     spending limit — for Kimi, a prepaid balance — of at most the amount you stated,
//     independently set by you), then RUN-ONE-PAID-ANALYSIS. Anything else ends the run with
//     nothing changed.
//  3. The window:
//     a. function settings (read back by name): Anthropic — ANALYSIS_PROVIDER=anthropic,
//        ALLOW_PAID_PROVIDER=staging-only, ANTHROPIC_API_KEY, the two models,
//        ANTHROPIC_EFFORT=medium; Kimi — ANALYSIS_PROVIDER=kimi, ALLOW_PAID_PROVIDER=staging-only,
//        KIMI_API_KEY (the model is fixed in the code: kimi-k3, reasoning effort low);
//     b. ONE guarded SQL statement activates exactly the chosen model(s) and enables spending,
//        only if spending is still off, the rows still have the reviewed prices and caps, and
//        no other paid model is active (otherwise nothing changes);
//     c. ONE founder call to analyze-case;
//     d. IMMEDIATELY after the call: one statement disables spending and deactivates every
//        paid models (retried, then read back); then the paid settings are deleted and the fake
//        settings restored (read back by name).
//     The same restore runs on any failure, Ctrl-C, SIGTERM, SIGHUP or crash of this process.
//     It CANNOT run if the Codespace itself dies: then run --paid-off (or the SQL file
//     supabase/deploy/stage2a6d_paid_off.sql and delete the key in the dashboard).
//  4. Verification (everything already off): the analysis was made by the paid model(s); one
//     new ledger row; reserved within the run budget; settled from reported usage (or HELD:
//     reconcile); no overrun; spending, models and settings off; founder-only access.
//     The analysis content is NOT printed: read it in the founder workspace.
//
// Exit codes: 0 all pass; 1 a check failed (all restored); 2 refused or stopped (nothing
// changed, or restored); 3 the platform rejected the founder's JWT (restored; do NOT redeploy
// with --no-verify-jwt); 4 something could NOT be confirmed off — follow the printed steps now;
// 130 interrupted (restored).
//
// Credentials (access token, provider key, passwords) come only from the environment (hidden
// prompts in the .sh wrapper) and are never printed or written anywhere: every line this script
// prints passes through a redactor. No file is written.

import { createInterface } from 'node:readline';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createClient } from '@supabase/supabase-js';
import { deployedProblems, kimiDeployedProblems } from './function-source-guard.mjs';
import { publishableKeyProblem, stagingUrlProblem } from './live-guards.mjs';

const REF = 'aqwdwswpmbnzmkvyuqil';
const MGMT = 'https://api.supabase.com';
const FN = 'analyze-case';
const FAKE_MODEL = 'FAKE-PROVIDER-NOT-AI';
/**
 * Must equal ANTHROPIC_MODELS (anthropicProvider.ts) and the 2A-6c migration, and KIMI_MODELS
 * (kimiProvider.ts) and the 2A-6e migration (tests compare them).
 */
const PAID_MODELS = Object.freeze({
  'claude-opus-5-5': Object.freeze({ in: 4, out: 20, cap: 8000 }),
  'claude-sonnet-5-5': Object.freeze({ in: 2, out: 10, cap: 8000 }),
  'kimi-k3': Object.freeze({ in: 3, out: 15, cap: 8000 }),
});
/** The two paid providers this run can use, and what each needs. */
const PROVIDERS = Object.freeze({
  anthropic: Object.freeze({ label: 'Anthropic', console: 'the Anthropic console', keyEnv: 'ANTHROPIC_API_KEY', models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    keyOk: (k) => /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(k), keyShape: 'an Anthropic API key (sk-ant-…)' }),
  kimi: Object.freeze({ label: 'Kimi', console: 'the Kimi (Moonshot) platform console', keyEnv: 'KIMI_API_KEY', models: ['kimi-k3'],
    keyOk: (k) => /^sk-[A-Za-z0-9_-]{20,300}$/.test(k) && !k.startsWith('sk-ant-'), keyShape: 'a Kimi API key (sk-…)' }),
});
const PAID_MODEL_LIST = Object.keys(PAID_MODELS).map((m) => `'${m}'`).join(', ');
const RUN_BUDGET_MAX_USD = 3;
const EVAL_CEILING_USD = 15;
const LIMIT_PHRASE = 'PROVIDER-LIMIT-CONFIRMED';
const RUN_PHRASE = 'RUN-ONE-PAID-ANALYSIS';
const PAID_SECRET_NAMES = ['ANTHROPIC_API_KEY', 'KIMI_API_KEY', 'ALLOW_PAID_PROVIDER', 'ANALYST_MODEL', 'REVIEWER_MODEL', 'ANTHROPIC_EFFORT'];
const PAID_SECRET = /^(ANTHROPIC_[A-Z0-9_]*|KIMI_[A-Z0-9_]*|ALLOW_PAID_PROVIDER|ANALYST_MODEL|REVIEWER_MODEL)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAID_OFF_SQL = `update private.ai_spend_config set enabled = false, updated_at = now() where id; update private.ai_model_prices set active = false where model in (${PAID_MODEL_LIST});`;
const recoveryOnly = process.argv.includes('--paid-off');

// ---------------------------------------------------------------- output: never a credential
const secrets = [];
const redact = (s) => { let t = String(s); for (const v of secrets) if (v) t = t.split(v).join('[REDACTED]'); return t; };
const out = (...a) => console.log(redact(a.join(' ')));
const err = (...a) => console.error(redact(a.join(' ')));
const env = (k) => {
  const v = process.env[k];
  if (!v) { err(`missing environment variable ${k}`); process.exit(2); }
  secrets.push(v);
  return v;
};
const TOKEN = env('SUPABASE_ACCESS_TOKEN');
if (!/^sbp_[A-Za-z0-9_]{20,}$/.test(TOKEN)) { err('refused: SUPABASE_ACCESS_TOKEN is not a Supabase personal access token (sbp_…).'); process.exit(2); }

// ---------------------------------------------------------------- Management API (fixed statements only)
class Stop extends Error {}
class PlatformJwtRejected extends Error {}

async function mgmt(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`${MGMT}/v1/projects/${REF}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Stop(`Management API unreachable (${e?.name ?? 'error'})`);
  }
  if (res.status === 401) throw new Stop('the access token was rejected (401): expired, revoked or mistyped');
  if (res.status === 403) {
    let missing = [];
    try { const j = await res.json(); missing = Array.isArray(j?.missing_permissions) ? j.missing_permissions.filter((p) => /^[a-z_:]{1,60}$/.test(p)) : []; } catch { /* no body */ }
    throw new Stop(`the access token lacks a permission for ${method} ${path.split('?')[0]}${missing.length ? `: ${missing.join(', ')}` : ''} (see the runbook's token permissions)`);
  }
  if (!res.ok) throw new Stop(`Management API answered HTTP ${res.status} for ${method} ${path.split('?')[0]}`);
  if (raw) return new Uint8Array(await res.arrayBuffer());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function sql(tag, query) {
  const rows = await mgmt('/database/query', { method: 'POST', body: { query: `/* rre:${tag} */ ${query}` } });
  if (!Array.isArray(rows)) throw new Stop(`unexpected Management API answer to ${tag} (not a list of rows)`);
  return rows;
}
const secretNames = async () => {
  const list = await mgmt('/secrets');
  if (!Array.isArray(list)) throw new Stop('unexpected answer when listing the function settings');
  return list.map((s) => String(s?.name ?? ''));
};

const STATE_SQL = `select json_build_object(
    'enabled', (select enabled from private.ai_spend_config where id),
    'limits', (select json_build_object('budget', budget_usd, 'stop', stop_at_usd, 'max', max_reservation_usd) from private.ai_spend_config where id),
    'committed', private.ai_committed_usd(),
    'ledger_rows', (select count(*) from private.ai_spend_ledger),
    'unsettled', (select count(*) from private.ai_spend_ledger where status in ('RESERVED', 'HELD')),
    'overruns', (select count(*) from private.ai_spend_ledger where overrun),
    'models', (select coalesce(json_agg(json_build_object('model', model, 'in', input_usd_per_mtok, 'out', output_usd_per_mtok, 'cap', max_output_tokens, 'active', active) order by model), '[]'::json)
               from private.ai_model_prices)) as state`;
const state = async () => {
  const s = (await sql('state', STATE_SQL))[0]?.state;
  if (!s || typeof s !== 'object' || typeof s.enabled !== 'boolean' || !Array.isArray(s.models)) throw new Stop('could not read the spending state');
  return s;
};
const reviewedRow = (m, row) => row && Number(row.in) === PAID_MODELS[m].in && Number(row.out) === PAID_MODELS[m].out && Number(row.cap) === PAID_MODELS[m].cap;

/** Activates exactly the chosen models and enables spending, atomically, only under the reviewed conditions. */
function enableSql(models) {
  const list = models.map((m) => `'${m}'`).join(', ');
  const exact = models.map((m) => `(model = '${m}' and input_usd_per_mtok = ${PAID_MODELS[m].in} and output_usd_per_mtok = ${PAID_MODELS[m].out} and max_output_tokens = ${PAID_MODELS[m].cap})`).join(' or ');
  const ok = `(select not enabled from private.ai_spend_config where id)
      and (select count(*) from private.ai_model_prices where model in (${list}) and not active and (${exact})) = ${models.length}
      and not exists (select 1 from private.ai_model_prices where active and model <> '${FAKE_MODEL}')
      and not exists (select 1 from private.ai_spend_ledger where status in ('RESERVED', 'HELD'))`;
  return `with ok as (select ${ok} as go),
    act as (update private.ai_model_prices set active = true where model in (${list}) and (select go from ok) returning model),
    en as (update private.ai_spend_config set enabled = true, updated_at = now() where id and (select go from ok) returning enabled)
    select (select count(*) from act) as activated, (select count(*) from en) as enabled`;
}
const OFF_SQL = `with en as (update private.ai_spend_config set enabled = false, updated_at = now() where id returning enabled),
    act as (update private.ai_model_prices set active = false where model in (${PAID_MODEL_LIST}) and active returning model)
    select (select count(*) from en) as disabled, (select count(*) from act) as deactivated`;

// ---------------------------------------------------------------- restore (the whole point)
let dbArmed = false;       // from just before the enable statement until spending and models are confirmed off
let secretsArmed = false;  // from just before the paid settings are written until they are confirmed gone
async function restoreDb() {
  for (const w of [0, 1000, 2000, 4000, 8000]) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try { await sql('off', OFF_SQL); } catch { /* confirm below */ }
    try {
      const s = await state();
      if (s.enabled === false && !s.models.some((m) => m.active && m.model !== FAKE_MODEL)) {
        dbArmed = false;
        out('      spending DISABLED and the paid models INACTIVE (confirmed by reading them back)');
        return true;
      }
    } catch { /* retry */ }
  }
  dbArmed = false;
  err('ALERT: spending / paid models could NOT be confirmed off. Run this in the Supabase SQL Editor NOW:');
  err(`       ${PAID_OFF_SQL}`);
  err('       (the same statements: supabase/deploy/stage2a6d_paid_off.sql) or: bash supabase/scripts/paid-pipeline-e2e.sh --paid-off');
  return false;
}
async function restoreSecrets() {
  for (const w of [0, 1000, 2000, 4000]) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try {
      const present = (await secretNames()).filter((n) => PAID_SECRET.test(n));
      if (present.length) await mgmt('/secrets', { method: 'DELETE', body: present });
      await mgmt('/secrets', { method: 'POST', body: [{ name: 'ANALYSIS_PROVIDER', value: 'fake' }, { name: 'ALLOW_FAKE_PROVIDER', value: 'staging-only' }] });
    } catch { /* confirm below */ }
    try {
      const names = await secretNames();
      if (!names.some((n) => PAID_SECRET.test(n)) && names.includes('ANALYSIS_PROVIDER') && names.includes('ALLOW_FAKE_PROVIDER')) {
        secretsArmed = false;
        out('      provider settings back to FAKE; the provider key and paid settings DELETED (confirmed by listing them)');
        return true;
      }
    } catch { /* retry */ }
  }
  secretsArmed = false;
  err('ALERT: the paid provider settings could NOT be confirmed removed. NOW: Supabase dashboard → Edge Functions → Secrets:');
  err(`       delete ${PAID_SECRET_NAMES.join(', ')}; set ANALYSIS_PROVIDER=fake. Then revoke the provider key in its console (Anthropic or Kimi).`);
  err('       or: bash supabase/scripts/paid-pipeline-e2e.sh --paid-off');
  return false;
}

// ---------------------------------------------------------------- recovery-only mode
if (recoveryOnly) {
  out(`== Recovery: paid provider OFF on ${REF} (spending disabled, paid models inactive, paid settings deleted; nothing else)`);
  let ok = false;
  try { const a = await restoreDb(); const b = await restoreSecrets(); ok = a && b; } catch (e) { err(`stopped: ${e.message}`); }
  process.exit(ok ? 0 : 4);
}

// ---------------------------------------------------------------- full run: inputs
const urlProblem = stagingUrlProblem(env('RRE_SUPABASE_URL'));
if (urlProblem) { err(`refused: ${urlProblem}.`); process.exit(2); }
const URL_ = process.env.RRE_SUPABASE_URL.replace(/\/$/, '');
const KEY = env('RRE_PUBLISHABLE_KEY');
const keyProblem = publishableKeyProblem(KEY);
if (keyProblem) { err(`refused: ${keyProblem}. Use the publishable key (sb_publishable_…) only.`); process.exit(2); }
const ACCOUNTS = Object.fromEntries(['CLIENT_A', 'CLIENT_B', 'FOUNDER'].map((p) => [p, { email: env(`${p}_EMAIL`), password: env(`${p}_PASSWORD`) }]));
const PROVIDER_NAME = process.env.PAID_PROVIDER ?? '';
if (!Object.hasOwn(PROVIDERS, PROVIDER_NAME)) { err(`refused: PAID_PROVIDER must be exactly one of ${Object.keys(PROVIDERS).join(', ')}.`); process.exit(2); }
const P = PROVIDERS[PROVIDER_NAME];
const PROVIDER_KEY = env(P.keyEnv);
if (!P.keyOk(PROVIDER_KEY)) { err(`refused: that is not shaped like ${P.keyShape}.`); process.exit(2); }
// Kimi: one model, fixed in the code for both stages. Anthropic: the two models you choose.
const ANALYST = PROVIDER_NAME === 'kimi' ? 'kimi-k3' : process.env.PAID_ANALYST_MODEL ?? '';
const REVIEWER = PROVIDER_NAME === 'kimi' ? 'kimi-k3' : process.env.PAID_REVIEWER_MODEL ?? '';
if (!P.models.includes(ANALYST) || !P.models.includes(REVIEWER)) {
  err(`refused: the analyst and reviewer models must each be one of ${P.models.join(', ')}.`); process.exit(2);
}
const LIMIT = Number(process.env.PROVIDER_LIMIT_USD);
if (!Number.isFinite(LIMIT) || LIMIT <= 0 || LIMIT > EVAL_CEILING_USD) {
  err(`refused: the provider-side spending limit must be a number above 0 and at most USD ${EVAL_CEILING_USD} (the absolute evaluation ceiling).`); process.exit(2);
}
const BUDGET = Number(process.env.RUN_BUDGET_USD ?? RUN_BUDGET_MAX_USD);
if (!Number.isFinite(BUDGET) || BUDGET <= 0 || BUDGET > RUN_BUDGET_MAX_USD) {
  err(`refused: the run budget must be above 0 and at most USD ${RUN_BUDGET_MAX_USD}.`); process.exit(2);
}
const MODELS = [...new Set([ANALYST, REVIEWER])];

const results = [];
const record = (status, name, detail = '') => { results.push({ status, name }); out(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`); };
const expectOk = (name, ok, detail) => record(ok ? 'PASS' : 'FAIL', name, detail);
const refused = (r) => Boolean(r.error) || (Array.isArray(r.data) && r.data.length === 0) || r.data === null;
const sessions = [];
const created = [];

async function signIn(prefix) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword(ACCOUNTS[prefix]);
  if (error) throw new Stop(`${prefix}: sign-in failed: ${error.message}`);
  sessions.push({ prefix, c });
  secrets.push(data.session?.access_token, data.session?.refresh_token);
  return { c, who: (await c.rpc('whoami')).data, token: data.session?.access_token ?? '' };
}
async function signOutAll() {
  for (const { prefix, c } of sessions.splice(0)) {
    const { error } = await c.auth.signOut({ scope: 'local' }).catch((e) => ({ error: e }));
    out(error ? `WARN  ${prefix}: sign-out failed — ${error.message}` : `      ${prefix}: signed out (this session only)`);
  }
}

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  let exit = code;
  if (dbArmed && !(await restoreDb())) exit = 4;
  if (secretsArmed && !(await restoreSecrets())) exit = 4;
  if (created.length) out(`Synthetic case created: ${created.join(', ')} (kept for the record).`);
  await signOutAll();
  process.exit(exit);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => { err(`interrupted (${sig}): ${dbArmed || secretsArmed ? 'turning the paid provider off, then ' : ''}signing out before exiting`); void finish(130); });
}
process.on('uncaughtException', (e) => { err(`crashed: ${e?.message ?? e}`); void finish(2); });
process.on('unhandledRejection', (e) => { err(`crashed: ${e?.message ?? e}`); void finish(2); });

const lines = [];
let waiting = null;
let inputClosed = false;
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
rl.on('close', () => { inputClosed = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
/** One typed line; an empty answer if the input has ended (which cancels). */
function ask(prompt) {
  process.stdout.write(prompt);
  if (lines.length) return Promise.resolve(lines.shift());
  if (inputClosed) return Promise.resolve('');
  return new Promise((resolve) => { waiting = resolve; });
}

function decodeBody(bytes) {
  const b = Buffer.from(bytes);
  for (const t of [
    () => (b.subarray(0, 4).toString('latin1') === 'EZBR' ? brotliDecompressSync(b.subarray(4)) : null),
    () => (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : null),
    () => b,
  ]) {
    try { const r = t(); if (r) { const text = r.toString('latin1'); if (text.includes(FAKE_MODEL)) return text; } } catch { /* next */ }
  }
  return null;
}

/** A synthetic sales conversation (invented business and people; no real numbers or names). */
function syntheticConversation(stamp) {
  return [
    `[02/10/2026, 10:02] Synthetic Prospect ${stamp}: Hello, I saw the synthetic 2019 hatchback on your site. Is it still for sale?`,
    '[02/10/2026, 10:15] Synthetic Autos A: Yes it is! Great car, one owner, full service history.',
    '[02/10/2026, 10:17] Synthetic Prospect: Good. What is the best price? The listing says 9,500.',
    '[02/10/2026, 13:40] Synthetic Autos A: 9,500 is already a very good price. Lots of people are asking about it.',
    '[02/10/2026, 13:42] Synthetic Prospect: I understand. I need to check with my partner and my bank first.',
    '[04/10/2026, 09:05] Synthetic Autos A: Any news? Someone else wants to see it this weekend.',
    '[06/10/2026, 18:30] Synthetic Prospect: Sorry, busy week. Could I come on Saturday morning to see it?',
    '[09/10/2026, 08:50] Synthetic Autos A: Hello? Are you still interested?',
  ].join('\n');
}

async function run() {
  // ---- 1. read-only audit
  out('== Read-only audit (Management API, scoped token)');
  const probe = await sql('probe', 'select 1 as ok');
  if (probe.length !== 1 || probe[0]?.ok !== 1) throw new Stop('unexpected Management API answer to a read-only probe; nothing was changed');
  const before = await state();
  if (before.enabled !== false) throw new Stop('spending is already ENABLED. Not touching it. If that is a leftover from an interrupted run: --paid-off');
  const active = before.models.filter((m) => m.active);
  if (active.length !== 1 || active[0].model !== FAKE_MODEL || Number(active[0].in) !== 0 || Number(active[0].out) !== 0) {
    throw new Stop(`the active models are not exactly ${FAKE_MODEL} at USD 0/0. Not changing anything.`);
  }
  for (const m of P.models) {
    const row = before.models.find((x) => x.model === m);
    if (!reviewedRow(m, row)) throw new Stop(`the price row for ${m} is missing or differs from the reviewed price and cap (Stage ${PROVIDER_NAME === 'kimi' ? '2A-6e' : '2A-6c'})`);
  }
  if (Number(before.unsettled) !== 0) throw new Stop(`${before.unsettled} reservation(s) are RESERVED or HELD: reconcile them first`);
  record('PASS', `spending disabled; only the free fake active; ${P.models.join(', ')} priced as reviewed and inactive; nothing unsettled`,
    `committed ${before.committed} USD, ${before.ledger_rows} ledger rows; limits ${before.limits?.budget}/${before.limits?.stop}/${before.limits?.max}`);

  const fn = await mgmt(`/functions/${FN}`);
  if (fn?.status !== 'ACTIVE' || fn?.verify_jwt !== true) throw new Stop(`the deployed ${FN} is not ACTIVE with verify_jwt ON`);
  const src = decodeBody(await mgmt(`/functions/${FN}/body`, { raw: true }));
  const srcProblems = [...deployedProblems(src ?? ''), ...(PROVIDER_NAME === 'kimi' ? kimiDeployedProblems(src ?? '') : [])];
  if (src === null || srcProblems.length) throw new Stop(`the deployed function is not the reviewed version: ${srcProblems[0] ?? 'unreadable'} (deploy it with deploy-analyze-case-2a6d.sh first)`);
  record('PASS', `${FN} ACTIVE, JWT check ON, deployed source is the reviewed ${P.label}-capable version`);
  const names0 = await secretNames();
  if (names0.some((n) => PAID_SECRET.test(n))) throw new Stop('a paid-provider setting is already present among the function settings: run --paid-off first');
  if (!names0.includes('ANALYSIS_PROVIDER') || !names0.includes('ALLOW_FAKE_PROVIDER')) throw new Stop('the fake settings ANALYSIS_PROVIDER / ALLOW_FAKE_PROVIDER are missing');
  record('PASS', 'function settings: fake provider, no provider key or paid setting');

  const A = await signIn('CLIENT_A');
  const B = await signIn('CLIENT_B');
  const F = await signIn('FOUNDER');
  if (A.who?.role !== 'CLIENT' || B.who?.role !== 'CLIENT' || F.who?.role !== 'FOUNDER' || A.who.business_id === B.who.business_id) {
    throw new Stop('accounts must be: two CLIENTS of different businesses, and the FOUNDER');
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const ref = `E2E-PAID-${stamp}`;
  const text = syntheticConversation(stamp);
  const bytes = Buffer.byteLength(text, 'utf8');
  const est = Number((await sql('estimate', `select (private.ai_estimate_usd(${bytes}, 1, 0, a, r, c) ->> 'usd')::numeric as usd
      from private.ai_model_prices a, private.ai_model_prices r, private.ai_spend_config c
      where a.model = '${ANALYST}' and r.model = '${REVIEWER}' and c.id`))[0]?.usd);
  const maxPerAnalysis = Number(before.limits?.max);
  if (!Number.isFinite(est) || est <= 0) throw new Stop('could not compute the database\'s estimate for this case');
  if (est > BUDGET || est > maxPerAnalysis || est > LIMIT) {
    throw new Stop(`the most this case can cost (USD ${est}) exceeds the run budget (USD ${BUDGET}), the per-analysis limit (USD ${maxPerAnalysis}) or your provider limit (USD ${LIMIT})`);
  }
  record('PASS', `worst case for this run: USD ${est} (analyst ${ANALYST}, reviewer ${REVIEWER})`, `within run budget USD ${BUDGET}, per-analysis limit USD ${maxPerAnalysis}, provider limit USD ${LIMIT}`);

  const mk = await A.c.rpc('client_create_case', { p_idempotency_key: crypto.randomUUID(), p_reference: ref, p_product_service: 'Synthetic paid evaluation',
    p_lead_source: 'Other', p_conversation_source: 'TEXT', p_conversation_text: text });
  if (mk.error || !UUID.test(String(mk.data))) throw new Stop(`could not create the synthetic case: ${mk.error?.message ?? 'no id'}`);
  created.push(ref);
  const caseId = String(mk.data);
  const sub = await A.c.rpc('client_submit_case', { p_case_id: caseId });
  if (sub.error) throw new Stop(`could not submit the synthetic case: ${sub.error.message}`);
  record('PASS', `synthetic case ${ref} created by client A and SUBMITTED (${bytes} bytes, synthetic text only)`);

  // ---- 2. confirmations
  out('');
  out(`Provider-side limit: you stated USD ${LIMIT}. This script cannot read it: only you can confirm it in ${P.console}.`);
  const c1 = await ask(PROVIDER_NAME === 'kimi'
    ? `Type ${LIMIT_PHRASE} to confirm the Kimi account of this key holds at most USD ${LIMIT} of credit (or has a spending limit of at most that): `
    : `Type ${LIMIT_PHRASE} to confirm the Anthropic workspace of this key has a spending limit of at most USD ${LIMIT} and allows global inference: `);
  if (c1 !== LIMIT_PHRASE) throw new Stop('the provider-side spending limit was not confirmed: nothing was changed');
  out(`About to: switch ${FN} to ${P.label} (${ANALYST} / ${REVIEWER}), activate ${MODELS.join(' and ')}, enable spending, call ${FN} ONCE for ${ref},`);
  out(`then turn all of it off immediately. Most this can cost: USD ${est}.`);
  const c2 = await ask(`Type ${RUN_PHRASE} to run exactly one paid analysis (anything else cancels): `);
  if (c2 !== RUN_PHRASE) throw new Stop('not approved: nothing was changed');

  // ---- 3. the window
  out(`== Paid window (${P.label})`);
  secretsArmed = true;
  const paidSettings = PROVIDER_NAME === 'kimi'
    ? [{ name: 'ANALYSIS_PROVIDER', value: 'kimi' }, { name: 'ALLOW_PAID_PROVIDER', value: 'staging-only' }, { name: 'KIMI_API_KEY', value: PROVIDER_KEY }]
    : [{ name: 'ANALYSIS_PROVIDER', value: 'anthropic' }, { name: 'ALLOW_PAID_PROVIDER', value: 'staging-only' }, { name: 'ANTHROPIC_API_KEY', value: PROVIDER_KEY },
      { name: 'ANALYST_MODEL', value: ANALYST }, { name: 'REVIEWER_MODEL', value: REVIEWER }, { name: 'ANTHROPIC_EFFORT', value: 'medium' }];
  await mgmt('/secrets', { method: 'POST', body: paidSettings });
  const names1 = await secretNames();
  if (!paidSettings.filter((x) => x.name !== 'ANALYSIS_PROVIDER').every((x) => names1.includes(x.name))) throw new Stop('the paid settings could not be confirmed written');
  out(`      function settings: ${P.label} (key set; value never shown)`);
  dbArmed = true;
  const en = await sql('enable', enableSql(MODELS));
  if (Number(en[0]?.activated) !== MODELS.length || Number(en[0]?.enabled) !== 1) {
    dbArmed = false; // the guarded statement changed nothing
    throw new Stop('the database refused to activate the model(s) and enable spending (state changed since the audit); nothing was changed there');
  }
  out(`      ${MODELS.join(' and ')} ACTIVE; spending ENABLED (guarded)`);
  let res = null;
  let callError = null;
  try {
    res = await fetch(`${URL_}/functions/v1/${FN}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150_000),
      headers: { apikey: KEY, authorization: `Bearer ${F.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ case_id: caseId }) });
  } catch (e) { callError = e?.name ?? 'error'; }
  let reply = null;
  if (res) { try { reply = JSON.parse(await res.text()); } catch { /* not JSON */ } }
  // Off IMMEDIATELY after the single call, before any result is read.
  const dbOff = await restoreDb();
  const secretsOff = await restoreSecrets();
  if (!dbOff || !secretsOff) throw Object.assign(new Stop('the paid provider could not be confirmed off'), { exitCode: 4 });

  // ---- 4. verification (everything is off)
  out('== Result');
  const own = reply && typeof reply === 'object' && JSON.stringify(Object.keys(reply)) === '["outcome","code","analysis_id"]';
  if (res && res.status === 401 && !own) throw new PlatformJwtRejected();
  const analysisId = own && UUID.test(String(reply.analysis_id)) ? String(reply.analysis_id) : null;
  record(res?.status === 200 && own && reply.outcome === 'COMPLETED' ? 'PASS' : 'WARN', 'the founder call', callError ? `call failed (${callError})`
    : `HTTP ${res?.status} ${own ? `${reply.outcome} / ${reply.code}` : '(not the function\'s response)'}`);
  const after = await state();
  expectOk('spending disabled, paid models inactive, limits unchanged, no overrun',
    after.enabled === false && !after.models.some((m) => m.active && m.model !== FAKE_MODEL)
      && JSON.stringify(after.limits) === JSON.stringify(before.limits) && Number(after.overruns) === Number(before.overruns));
  const names2 = await secretNames();
  expectOk('function settings back to fake: no provider key, no paid setting', !names2.some((n) => PAID_SECRET.test(n)) && names2.includes('ANALYSIS_PROVIDER'));
  expectOk('exactly one new ledger row', Number(after.ledger_rows) === Number(before.ledger_rows) + 1, `${before.ledger_rows} -> ${after.ledger_rows}`);
  if (!analysisId) { record('FAIL', 'an analysis was recorded', 'no analysis id returned'); return; }

  const a = (await F.c.from('analyses').select('status, model, input_tokens, output_tokens, estimated_cost_usd, error').eq('id', analysisId).maybeSingle()).data;
  expectOk('the analysis was made by the chosen paid models (not the fake)', a?.model === `analyst:${ANALYST}|reviewer:${REVIEWER}`,
    a?.model?.includes(FAKE_MODEL) ? 'the function still ran the FAKE (the settings change was not picked up): cost 0' : `status ${a?.status}${a?.error ? `, ${String(a.error).slice(0, 80)}` : ''}`);
  const l = (await sql('ledger', `select row_to_json(l) as l from private.ai_spend_ledger l where analysis_id = '${analysisId}'`))[0]?.l;
  expectOk(`reserved within the run budget (USD ${BUDGET}) and the database estimate`, l && Number(l.reserved_usd) <= BUDGET && Number(l.reserved_usd) <= est, `reserved USD ${l?.reserved_usd}`);
  expectOk('settled from reported usage (not HELD); actual within the reservation; no overrun',
    l?.status === 'SETTLED' && l.settled_by === 'REPORTED_USAGE' && Number(l.actual_usd) <= Number(l.reserved_usd) && l.overrun === false,
    l?.status === 'HELD' ? `HELD: usage unknown — reconcile it against ${P.console} (runbook)` : `actual USD ${l?.actual_usd}`);
  out(`      tokens: analyst ${l?.analyst_input_tokens ?? '?'} in / ${l?.analyst_output_tokens ?? '?'} out; reviewer ${l?.reviewer_input_tokens ?? '?'} in / ${l?.reviewer_output_tokens ?? '?'} out`);
  expectOk(`committed spend grew by at most the run budget (USD ${BUDGET})`, Number(after.committed) - Number(before.committed) <= BUDGET,
    `${before.committed} -> ${after.committed}`);

  out('== Founder-only access');
  expectOk('the founder reads the analysis', (await F.c.from('analyses').select('id').eq('id', analysisId)).data?.length === 1);
  const anon = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const [who, c] of [['client A (case owner)', A.c], ['client B', B.c], ['anonymous', anon]]) {
    expectOk(`${who}: no analysis, audit trail or spending information`, refused(await c.from('analyses').select('id, output').eq('id', analysisId))
      && refused(await c.from('audit_log').select('id').eq('case_id', caseId)) && Boolean((await c.rpc('founder_ai_spend_summary')).error)
      && refused(await c.schema('private').from('ai_spend_ledger').select('analysis_id')));
  }
  const view = await A.c.rpc('client_get_case', { p_case_id: caseId });
  expectOk('client A\'s own case view carries nothing from the analysis or spending',
    !view.error && !JSON.stringify(view.data ?? {}).includes(analysisId) && !/adversarial|hypothes|recommendation|verdict|reserved|usd|SPEND|claude|kimi|moonshot/i.test(JSON.stringify(view.data ?? {})));
  out(`Read the analysis in the founder workspace (case ${ref}). Its text is not printed here.`);
}

let code;
try {
  await run();
  const failed = results.filter((x) => x.status === 'FAIL').length;
  out(`== ${results.filter((x) => x.status === 'PASS').length} pass, ${failed} fail, ${results.filter((x) => x.status === 'WARN').length} warn`);
  code = failed ? 1 : 0;
} catch (e) {
  if (e instanceof PlatformJwtRejected) {
    err('STOP: the platform rejected the founder\'s valid session token (HTTP 401). The paid provider was turned off again.');
    err('      Do NOT redeploy with --no-verify-jwt. Report this output.');
    code = 3;
  } else {
    err(e instanceof Stop ? `stopped: ${e.message}` : `stopped by an unexpected error: ${e?.message ?? e}`);
    code = e?.exitCode ?? 2;
  }
}
rl.close();
await finish(code);

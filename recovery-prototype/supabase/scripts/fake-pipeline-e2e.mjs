#!/usr/bin/env node
// Stage 2A-5d-4d — guarded END-TO-END test of the deployed analyze-case function with
// the FAKE provider, on the synthetic STAGING project. Run it yourself (Android:
// GitHub Codespace): bash supabase/scripts/fake-pipeline-e2e.sh
// Recovery only (turns spending off, nothing else):
//   bash supabase/scripts/fake-pipeline-e2e.sh --disable-spending-only
//
// What it does, in this order:
//  1. Read-only audit through the Supabase Management API (scoped access token):
//     spending is DISABLED; the only active priced model is FAKE-PROVIDER-NOT-AI at
//     USD 0/0; the deployed function is ACTIVE with verify_jwt ON, its downloaded
//     source matches its recorded hash, contains the fake provider and the spending
//     controls and no AI-provider SDK/endpoint/key; its secrets include the fake
//     settings and no provider key. Three synthetic accounts sign in. Client A creates
//     and submits ONE synthetic WhatsApp-style text case.
//  2. Your approval: you must type ENABLE-FAKE-SPENDING exactly. Anything else ends the
//     run with spending untouched.
//  3. The window: one guarded SQL statement enables spending only if it is still off
//     and the fake is still the only (zero-priced) active model; ONE founder call to
//     analyze-case; spending is disabled IMMEDIATELY after the call returns (before
//     any result is read), with retries, and confirmed by reading it back. The same
//     restore runs on any failure, Ctrl-C, SIGTERM, SIGHUP or crash of this process.
//     It CANNOT run if the Codespace itself is killed: then spending stays enabled
//     (exposure: USD 0 — only the free fake model is priced and the function can only
//     run the fake) until --disable-spending-only or the SQL Editor turns it off.
//  4. Verification (spending already off): evidence integrity, analysis completion,
//     adversarial review, ledger settlement at USD 0, case-state transitions and the
//     audit trail, founder-only access (both businesses and anonymous see nothing),
//     and spending totals unchanged.
//
// Exit codes: 0 all pass; 1 a check failed (spending restored); 2 refused or stopped
// (spending never enabled, or restored); 3 the platform rejected the founder's JWT
// (restored; do NOT redeploy with --no-verify-jwt); 4 spending could NOT be confirmed
// disabled — run the printed SQL now; 130 interrupted (restored).
//
// Credentials come only from the environment (hidden prompts in the .sh wrapper) and
// are never printed or written anywhere: every line this script prints is passed
// through a redactor first. No file is written.

import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';
import { deployedProblems } from './function-source-guard.mjs';
import { accessToken, publishableKeyProblem, stagingUrlProblem } from './live-guards.mjs';

const REF = 'aqwdwswpmbnzmkvyuqil';
const MGMT = 'https://api.supabase.com';
const FN = 'analyze-case';
const FAKE_MODEL = 'FAKE-PROVIDER-NOT-AI';
const FAKE_MARK = '[FAKE PROVIDER — pipeline test, NOT an AI analysis]';
const PHRASE = 'ENABLE-FAKE-SPENDING';
const PROVIDER_MARKERS = /@anthropic-ai|api\.anthropic\.com|sk-ant-|ANTHROPIC_API_KEY|openai|x-api-key/i;
const PROVIDER_SECRET_NAME = /ANTHROPIC|OPENAI|CLAUDE|GEMINI|MISTRAL|COHERE|GROQ|LLM|(^|_)API_KEY$|PROVIDER_KEY|^ALLOW_PAID_PROVIDER$|^(ANALYST|REVIEWER)_MODEL$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESTORE_SQL = 'update private.ai_spend_config set enabled = false, updated_at = now() where id;';
const recoveryOnly = process.argv.includes('--disable-spending-only');

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
const pat = accessToken(env('SUPABASE_ACCESS_TOKEN'));
if (pat.problem) { err(`refused: SUPABASE_ACCESS_TOKEN is not a Supabase personal access token (sbp_…): ${pat.problem}.`); process.exit(2); }
const TOKEN = pat.token;
secrets.push(TOKEN);

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
  return raw ? new Uint8Array(await res.arrayBuffer()) : res.json();
}

/** Runs one of this script's fixed statements; returns its rows (the API answers a JSON array). */
async function sql(tag, query) {
  const rows = await mgmt('/database/query', { method: 'POST', body: { query: `/* rre:${tag} */ ${query}` } });
  if (!Array.isArray(rows)) throw new Stop(`unexpected Management API answer to ${tag} (not a list of rows)`);
  return rows;
}

const ENABLE_SQL = `update private.ai_spend_config set enabled = true, updated_at = now()
  where id and not enabled
    and exists (select 1 from private.ai_model_prices where active and model = '${FAKE_MODEL}' and input_usd_per_mtok = 0 and output_usd_per_mtok = 0)
    and not exists (select 1 from private.ai_model_prices where active and (model <> '${FAKE_MODEL}' or input_usd_per_mtok <> 0 or output_usd_per_mtok <> 0))
  returning enabled`;
const DISABLE_SQL = 'update private.ai_spend_config set enabled = false, updated_at = now() where id returning enabled';
const STATE_SQL = `select json_build_object(
    'enabled', (select enabled from private.ai_spend_config where id),
    'committed', private.ai_committed_usd(),
    'ledger_rows', (select count(*) from private.ai_spend_ledger),
    'open', (select count(*) from private.ai_spend_ledger where status = 'RESERVED'),
    'held', (select count(*) from private.ai_spend_ledger where status = 'HELD'),
    'overruns', (select count(*) from private.ai_spend_ledger where overrun),
    'active_models', (select coalesce(json_agg(json_build_object('model', model, 'in', input_usd_per_mtok, 'out', output_usd_per_mtok, 'cap', max_output_tokens) order by model), '[]'::json)
                      from private.ai_model_prices where active)) as state`;
const state = async () => {
  const s = (await sql('state', STATE_SQL))[0]?.state;
  if (!s || typeof s !== 'object' || typeof s.enabled !== 'boolean' || !Array.isArray(s.active_models)) throw new Stop('could not read the spending state');
  return s;
};

// ---------------------------------------------------------------- restore (the whole point)
let armed = false; // true from just before the enable statement until spending is confirmed off
async function restoreSpending() {
  const waits = [0, 1000, 2000, 4000, 8000];
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try { await sql('disable', DISABLE_SQL); } catch { /* still confirm below: a refused statement changed nothing */ }
    try {
      const s = await state();
      if (s.enabled === false) { armed = false; out('      spending is DISABLED (confirmed by reading it back)'); return true; }
    } catch { /* retry */ }
  }
  armed = false; // already tried: do not repeat on exit
  err('ALERT: spending could NOT be confirmed disabled. Run this in the Supabase SQL Editor NOW:');
  err(`       ${RESTORE_SQL}`);
  err('       or: bash supabase/scripts/fake-pipeline-e2e.sh --disable-spending-only');
  return false;
}

// ---------------------------------------------------------------- recovery-only mode
if (recoveryOnly) {
  out(`== Recovery: disabling spending on ${REF} (nothing else is changed)`);
  let ok = false;
  try { ok = await restoreSpending(); } catch (e) { err(`stopped: ${e.message}`); }
  process.exit(ok ? 0 : 4);
}

// ---------------------------------------------------------------- full run: account and URL guards
const urlProblem = stagingUrlProblem(env('RRE_SUPABASE_URL'));
if (urlProblem) { err(`refused: ${urlProblem}.`); process.exit(2); }
const URL_ = process.env.RRE_SUPABASE_URL.replace(/\/$/, '');
const KEY = env('RRE_PUBLISHABLE_KEY');
const keyProblem = publishableKeyProblem(KEY);
if (keyProblem) { err(`refused: ${keyProblem}. Use the publishable key (sb_publishable_…) only.`); process.exit(2); }
const ACCOUNTS = Object.fromEntries(['CLIENT_A', 'CLIENT_B', 'FOUNDER'].map((p) => [p, { email: env(`${p}_EMAIL`), password: env(`${p}_PASSWORD`) }]));

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
  if (armed && !(await restoreSpending())) exit = 4;
  if (created.length) out(`Synthetic case created: ${created.join(', ')} (kept for the record).`);
  await signOutAll();
  process.exit(exit);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => { err(`interrupted (${sig}): ${armed ? 'disabling spending, then ' : ''}signing out before exiting`); void finish(130); });
}
process.on('uncaughtException', (e) => { err(`crashed: ${e?.message ?? e}`); void finish(2); });
process.on('unhandledRejection', (e) => { err(`crashed: ${e?.message ?? e}`); void finish(2); });

function askPhrase() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    process.stdout.write(`Type ${PHRASE} to enable spending for this single fake run (anything else cancels): `);
    let done = false;
    rl.once('line', (line) => { done = true; rl.close(); resolve(line); });
    rl.once('close', () => { if (!done) resolve(''); });
  });
}

/** The deployed function's source: the EZBR (brotli eszip) body, decoded for scanning. */
function decodeBody(bytes) {
  const b = Buffer.from(bytes);
  const tries = [
    () => (b.subarray(0, 4).toString('latin1') === 'EZBR' ? brotliDecompressSync(b.subarray(4)) : null),
    () => (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : null),
    () => b,
  ];
  for (const t of tries) {
    try { const r = t(); if (r) { const text = r.toString('latin1'); if (text.includes(FAKE_MODEL)) return text; } } catch { /* next */ }
  }
  return null;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const isZero = (v) => Number(v) === 0;

/** A synthetic WhatsApp export (invented names, no real numbers). */
function whatsappText(stamp) {
  return [
    `[13/10/2026, 09:14:02] Synthetic Prospect ${stamp}: Hi, is the synthetic 2019 hatchback still available?`,
    '[13/10/2026, 09:20:45] Synthetic Autos A: Yes, it is. Would you like to come and view it?',
    '[13/10/2026, 09:22:10] Synthetic Prospect: Maybe. The price feels a bit high for me.',
    '[14/10/2026, 18:03:31] Synthetic Autos A: Understood. We can talk about it when you visit.',
    '[16/10/2026, 11:47:09] Synthetic Prospect: I will let you know.',
  ].join('\n');
}

async function run() {
  // ---- 1. read-only audit
  out('== Read-only audit (Management API, scoped token)');
  const probe = await sql('probe', 'select 1 as ok');
  if (probe.length !== 1 || probe[0]?.ok !== 1) throw new Stop('unexpected Management API answer to a read-only probe; nothing was changed');
  const before = await state();
  if (before.enabled !== false) throw new Stop('spending is already ENABLED. Not touching it. If that is a leftover from an interrupted run: --disable-spending-only');
  record('PASS', 'spending is disabled before the test', `committed ${before.committed} USD, ${before.ledger_rows} ledger rows, ${before.open} open, ${before.held} held`);
  const models = before.active_models;
  if (models.length !== 1 || models[0].model !== FAKE_MODEL || !isZero(models[0].in) || !isZero(models[0].out)) {
    throw new Stop(`the active priced models are not exactly ${FAKE_MODEL} at USD 0/0 (${models.length} active). Not enabling anything.`);
  }
  record('PASS', `the only active priced model is ${FAKE_MODEL}, at USD 0 input / 0 output`, `output cap ${models[0].cap}`);

  const fn = await mgmt(`/functions/${FN}`);
  if (fn?.status !== 'ACTIVE' || fn?.verify_jwt !== true) throw new Stop(`the deployed ${FN} is not ACTIVE with verify_jwt ON (status ${fn?.status ?? '?'}, verify_jwt ${fn?.verify_jwt ?? '?'})`);
  record('PASS', `${FN} is ACTIVE with the platform JWT check ON`, `version ${Number.isInteger(fn.version) ? fn.version : '?'}`);
  const body = await mgmt(`/functions/${FN}/body`, { raw: true });
  const hashMatches = typeof fn.ezbr_sha256 === 'string' && fn.ezbr_sha256 === createHash('sha256').update(body).digest('hex');
  const src = decodeBody(body);
  if (src === null) throw new Stop('the deployed function source could not be read to verify it (live preflight blocker: see the runbook)');
  // Stage 2A-6d: the Anthropic-CAPABLE code is accepted only if it is the reviewed version (the
  // source guard); with no provider key or paid setting among the secrets (checked below) it can
  // only run the fake. Any other provider code is refused.
  if (PROVIDER_MARKERS.test(src) && deployedProblems(src).length > 0) throw new Stop('the DEPLOYED function source contains an AI-provider SDK, endpoint or key');
  if (!src.includes('internal_reserve_ai_spend') || !src.includes('ALLOW_FAKE_PROVIDER')) throw new Stop('the deployed function is not the reviewed version (no spending controls or fake guard)');
  record('PASS', PROVIDER_MARKERS.test(src) ? 'deployed source: the reviewed Anthropic-capable version (fake provider configured), spending controls present'
    : 'deployed source: the fake provider and the spending controls, no AI-provider SDK, endpoint or key',
    hashMatches ? 'download matches the recorded deployment hash' : 'download encoding differs from the recorded upload hash; content checked');

  const list = await mgmt('/secrets');
  if (!Array.isArray(list)) throw new Stop('unexpected answer when listing the function secrets');
  const names = list.map((s) => String(s?.name ?? ''));
  const providerNames = names.filter((n) => !n.startsWith('SUPABASE_') && PROVIDER_SECRET_NAME.test(n));
  if (providerNames.length) throw new Stop(`function secrets include an AI-provider key name (${providerNames.length}); values not shown`);
  if (!names.includes('ANALYSIS_PROVIDER') || !names.includes('ALLOW_FAKE_PROVIDER')) throw new Stop('the function secrets ANALYSIS_PROVIDER / ALLOW_FAKE_PROVIDER are missing');
  const provider = list.find((s) => s?.name === 'ANALYSIS_PROVIDER')?.value;
  const looksFake = provider === 'fake' || provider === sha256('fake');
  record(looksFake ? 'PASS' : 'WARN', 'function secrets: fake settings present, no provider key', looksFake ? 'ANALYSIS_PROVIDER = fake' : 'ANALYSIS_PROVIDER value could not be confirmed from its digest (the function only accepts fake)');

  const A = await signIn('CLIENT_A');
  const B = await signIn('CLIENT_B');
  const F = await signIn('FOUNDER');
  if (A.who?.role !== 'CLIENT' || B.who?.role !== 'CLIENT' || F.who?.role !== 'FOUNDER' || A.who.business_id === B.who.business_id) {
    throw new Stop('accounts must be: two CLIENTS of different businesses, and the FOUNDER');
  }
  const summary0 = await F.c.rpc('founder_ai_spend_summary');
  if (summary0.data?.enabled !== false) throw new Stop('the founder spending summary does not say disabled');

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const ref = `E2E-FAKE-${stamp}`;
  const text = whatsappText(stamp);
  const mk = await A.c.rpc('client_create_case', { p_idempotency_key: crypto.randomUUID(), p_reference: ref, p_product_service: 'Synthetic end-to-end test',
    p_lead_source: 'Other', p_conversation_source: 'TEXT', p_conversation_text: text });
  if (mk.error || !UUID.test(String(mk.data))) throw new Stop(`could not create the synthetic case: ${mk.error?.message ?? 'no id'}`);
  created.push(ref);
  const caseId = String(mk.data);
  const sub = await A.c.rpc('client_submit_case', { p_case_id: caseId });
  if (sub.error) throw new Stop(`could not submit the synthetic case: ${sub.error.message}`);
  const st0 = (await F.c.from('cases').select('workflow_state, evidence_version').eq('id', caseId).maybeSingle()).data;
  const n0 = (await F.c.from('analyses').select('id').eq('case_id', caseId)).data;
  if (st0?.workflow_state !== 'SUBMITTED' || n0?.length !== 0) throw new Stop('the synthetic case is not SUBMITTED with no analysis');
  record('PASS', `synthetic WhatsApp-style case ${ref} created by client A and SUBMITTED`);

  // ---- 2. approval
  out('');
  out(`About to: enable spending on ${REF} (only ${FAKE_MODEL} is priced, at USD 0), call ${FN} ONCE as the founder for ${ref},`);
  out('then disable spending immediately. Nothing else is changed.');
  const answer = await askPhrase();
  if (answer !== PHRASE) throw new Stop('not approved: spending was not touched');

  // ---- 3. the window
  out('== Spending window');
  armed = true;
  const en = await sql('enable', ENABLE_SQL);
  if (en.length !== 1 || en[0]?.enabled !== true) {
    armed = false; // the guarded statement changed nothing: leave the state exactly as found
    throw new Stop('the database refused to enable spending (the guard found it already on, or another priced model); nothing was changed');
  }
  out('      spending ENABLED (guarded)');
  let res = null;
  let callError = null;
  try {
    res = await fetch(`${URL_}/functions/v1/${FN}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150_000),
      headers: { apikey: KEY, authorization: `Bearer ${F.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ case_id: caseId }) });
  } catch (e) { callError = e?.name ?? 'error'; }
  let reply = null;
  if (res) { try { reply = JSON.parse(await res.text()); } catch { /* not JSON */ } }
  // Disabled IMMEDIATELY after the single call, before any result is read.
  if (!(await restoreSpending())) { throw Object.assign(new Stop('spending could not be confirmed disabled'), { exitCode: 4 }); }

  // ---- 4. verification (spending is off)
  out('== Result');
  const own = reply && typeof reply === 'object' && JSON.stringify(Object.keys(reply)) === '["outcome","code","analysis_id"]';
  if (res && res.status === 401 && !own) throw new PlatformJwtRejected();
  const analysisId = own && UUID.test(String(reply.analysis_id)) ? String(reply.analysis_id) : null;
  expectOk('one founder call: 200 COMPLETED / OK with the analysis id', res?.status === 200 && own && reply.outcome === 'COMPLETED' && reply.code === 'OK' && analysisId !== null,
    callError ? `call failed (${callError})` : `HTTP ${res?.status} ${own ? reply.code : '(not the function\'s response)'}`);
  if (!analysisId) return;

  const a = (await F.c.from('analyses').select('status, model, output, ai_classification, ai_proposed_message, input_tokens, output_tokens, estimated_cost_usd, evidence_version, evidence_manifest, error')
    .eq('id', analysisId).maybeSingle()).data;
  const o = a?.output ?? {};
  out('== Evidence integrity');
  const m = a?.evidence_manifest ?? {};
  const msgs = (await F.c.from('case_messages').select('id, kind, body').eq('case_id', caseId)).data ?? [];
  expectOk('snapshot: manifest version 2, at the case\'s evidence version, no screenshots, no restrictions',
    m.manifest_version === 2 && a?.evidence_version === st0.evidence_version && m.evidence_version === st0.evidence_version
      && Array.isArray(m.screenshots) && m.screenshots.length === 0 && Array.isArray(m.restrictions) && m.restrictions.length === 0);
  const mm = Array.isArray(m.messages) ? m.messages : [];
  expectOk('snapshot holds exactly the one pasted conversation', mm.length === 1 && msgs.length === 1 && mm[0].id === msgs[0].id && mm[0].kind === 'PASTED_CONVERSATION');
  expectOk('its SHA-256 equals the hash of the exact text submitted (and of the stored text)', mm[0]?.body_sha256 === sha256(text) && msgs[0]?.body === text);

  out('== Analysis and adversarial review');
  expectOk('stored as INSUFFICIENT_EVIDENCE under contract rre-analysis/2', a?.status === 'INSUFFICIENT_EVIDENCE' && o.contract_version === 'rre-analysis/2' && a.error === null);
  expectOk(`model is the fake for both roles; 0 tokens; cost 0`, a?.model === `analyst:${FAKE_MODEL}|reviewer:${FAKE_MODEL}` && a.input_tokens === 0 && a.output_tokens === 0 && isZero(a.estimated_cost_usd));
  const texts = [o.evidence_assessment?.summary, ...(o.evidence_assessment?.missing_evidence ?? []), o.recommendation?.next_action?.text,
    ...(o.unknowns ?? []).map((u) => u?.question), o.adversarial_review?.verdict_rationale, ...(o.adversarial_review?.challenges ?? []).map((c) => c?.challenge)];
  expectOk('every text is labelled as a fake pipeline test', texts.length >= 6 && texts.every((t) => typeof t === 'string' && t.includes(FAKE_MARK)));
  expectOk('no findings: no hypotheses, classification, message or contact recommendation',
    Array.isArray(o.hypotheses) && o.hypotheses.length === 0 && a.ai_classification === null && a.ai_proposed_message === null
      && o.recommendation?.pursue === 'UNKNOWN' && o.recommendation?.next_action?.type === 'WAIT');
  expectOk('adversarial review present: UPHOLD_WITH_CONCERNS with its challenge', o.adversarial_review?.verdict === 'UPHOLD_WITH_CONCERNS'
    && Array.isArray(o.adversarial_review.challenges) && o.adversarial_review.challenges.length === 1);

  out('== Ledger and spending (zero actual provider spend)');
  const l = (await sql('ledger', `select row_to_json(l) as l from private.ai_spend_ledger l where analysis_id = '${analysisId}'`))[0]?.l;
  expectOk('ledger: SETTLED from reported usage, reserved 0, actual 0, no overrun', l?.status === 'SETTLED' && l.settled_by === 'REPORTED_USAGE'
    && isZero(l.reserved_usd) && isZero(l.actual_usd) && l.overrun === false);
  expectOk('both calls dispatched (analyst first), 0 tokens each, both the fake at price 0',
    !!l?.analyst_dispatched_at && !!l.reviewer_dispatched_at && Date.parse(l.analyst_dispatched_at) <= Date.parse(l.reviewer_dispatched_at)
      && [l.analyst_input_tokens, l.analyst_output_tokens, l.reviewer_input_tokens, l.reviewer_output_tokens].every((t) => t === 0)
      && l.analyst_model === FAKE_MODEL && l.reviewer_model === FAKE_MODEL
      && [l.analyst_in_price, l.analyst_out_price, l.reviewer_in_price, l.reviewer_out_price].every(isZero));
  const after = await state();
  expectOk('spending totals: disabled, committed unchanged, exactly one new ledger row, nothing open, held or overrun',
    after.enabled === false && Number(after.committed) === Number(before.committed) && Number(after.ledger_rows) === Number(before.ledger_rows) + 1
      && Number(after.open) === Number(before.open) && Number(after.held) === Number(before.held) && Number(after.overruns) === Number(before.overruns));

  out('== Case states and audit trail');
  const st1 = (await F.c.from('cases').select('workflow_state').eq('id', caseId).maybeSingle()).data;
  expectOk('case: SUBMITTED before, AWAITING_ADMIN_REVIEW after', st1?.workflow_state === 'AWAITING_ADMIN_REVIEW');
  const trail = ((await F.c.from('audit_log').select('id, action').eq('case_id', caseId).order('id')).data ?? []).map((x) => x.action);
  const want = ['CASE_CREATED', 'CASE_SUBMITTED', 'ANALYSIS_STARTED', 'AI_SPEND_RESERVED', 'ANALYSIS_COMPLETED', 'AI_SPEND_SETTLED'];
  expectOk('audit trail, in order: created, submitted, started, reserved, completed, settled', JSON.stringify(trail) === JSON.stringify(want), trail.join(' > '));
  expectOk('exactly one analysis attempt on the case', ((await F.c.from('analyses').select('id').eq('case_id', caseId)).data ?? []).length === 1);

  out('== Founder-only access');
  expectOk('the founder reads the analysis and its review', (await F.c.from('analyses').select('id, output').eq('id', analysisId)).data?.length === 1);
  const anon = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const [who, c] of [['client A (case owner)', A.c], ['client B', B.c], ['anonymous', anon]]) {
    expectOk(`${who}: the analysis is invisible (by id and in any list)`, refused(await c.from('analyses').select('id, output').eq('id', analysisId))
      && refused(await c.from('analyses').select('id')));
    expectOk(`${who}: no audit trail, restrictions or spending information`, refused(await c.from('audit_log').select('id').eq('case_id', caseId))
      && refused(await c.from('contact_restrictions').select('id')) && Boolean((await c.rpc('founder_ai_spend_summary')).error)
      && refused(await c.schema('private').from('ai_spend_ledger').select('analysis_id')));
  }
  const view = await A.c.rpc('client_get_case', { p_case_id: caseId });
  const vt = JSON.stringify(view.data ?? {});
  expectOk('client A\'s own case view carries nothing from the analysis or spending',
    !view.error && !vt.includes(analysisId) && !/FAKE PROVIDER|adversarial|hypothes|recommendation|verdict|reserved|usd|SPEND/i.test(vt));
  expectOk('client B cannot read client A\'s case', refused(await B.c.rpc('client_get_case', { p_case_id: caseId })));
}

let code;
try {
  await run();
  const failed = results.filter((x) => x.status === 'FAIL').length;
  out(`== ${results.filter((x) => x.status === 'PASS').length} pass, ${failed} fail, ${results.filter((x) => x.status === 'WARN').length} warn`);
  code = failed ? 1 : 0;
} catch (e) {
  if (e instanceof PlatformJwtRejected) {
    err('STOP: the platform rejected the founder\'s valid session token (HTTP 401, platform response). Spending was disabled again.');
    err('      Do NOT redeploy with --no-verify-jwt. Report this output.');
    code = 3;
  } else {
    err(e instanceof Stop ? `stopped: ${e.message}` : `stopped by an unexpected error: ${e?.message ?? e}`);
    code = e?.exitCode ?? 2;
  }
}
await finish(code);

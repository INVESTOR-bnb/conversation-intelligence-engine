#!/usr/bin/env node
// Stage 2A-5d-4c — REAL checks of the deployed analyze-case Edge Function on the
// STAGING project, signed in as three SYNTHETIC accounts (two clients of different
// businesses and the founder), exactly like storage-live-check.mjs.
//
// It creates one synthetic TEXT case named AC-LIVE-<time> as client A and submits
// it. It never enables spending and never runs with spending enabled: it stops
// before calling the function if the founder's spending summary says enabled.
// With spending disabled the function must refuse before any provider call, so no
// AI (not even the fake) reads anything and nothing is reserved.
//
// Checked:
//   * platform JWT check: the founder's session reaches the function's own code.
//     If the platform rejects it, the run STOPS (exit 3) — do not redeploy with
//     --no-verify-jwt; report the output.
//   * unauthenticated callers, API keys and forged tokens: 401; client A on its
//     own case and client B: 403; another site's Origin: 403; nothing started.
//   * invalid requests (founder): wrong method, type, JSON, shape, size, unknown case.
//   * spending disabled: FAILED / SPENDING_DISABLED, analysis recorded as ERROR with
//     no output, lock released (case back to SUBMITTED), spending summary unchanged.
//   * businesses (and anonymous callers) cannot read analyses, the spending
//     summary, the private spending tables, or call the spending functions; the
//     client's own case view carries nothing from the analysis. The founder can
//     read the analysis (so "nothing visible" is not just "nothing there").
//
// Run: bash supabase/scripts/analyze-case-live-check.sh (prompts, hidden), or with
//   RRE_SUPABASE_URL, RRE_PUBLISHABLE_KEY, CLIENT_A_EMAIL, CLIENT_A_PASSWORD,
//   CLIENT_B_EMAIL, CLIENT_B_PASSWORD, FOUNDER_EMAIL, FOUNDER_PASSWORD set.
// Safety, before any connection: staging URL only, publishable key only, every
// value present. Nothing here prints an email, password, key, token or response
// body (only HTTP statuses and fixed codes). Every session this run signs in is
// signed out at the end (also on failure or Ctrl-C), with scope 'local' only.

import { createClient } from '@supabase/supabase-js';
import { publishableKeyProblem, stagingUrlProblem } from './live-guards.mjs';

const env = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing environment variable ${k}`); process.exit(2); }
  return v;
};
const urlProblem = stagingUrlProblem(env('RRE_SUPABASE_URL'));
if (urlProblem) { console.error(`refused: ${urlProblem}.`); process.exit(2); }
const URL_ = env('RRE_SUPABASE_URL').replace(/\/$/, '');
const KEY = env('RRE_PUBLISHABLE_KEY');
const keyProblem = publishableKeyProblem(KEY);
if (keyProblem) { console.error(`refused: ${keyProblem}. Use the publishable key (sb_publishable_…) only.`); process.exit(2); }
const ACCOUNTS = Object.fromEntries(['CLIENT_A', 'CLIENT_B', 'FOUNDER'].map((p) => [p, { email: env(`${p}_EMAIL`), password: env(`${p}_PASSWORD`) }]));

const FUNCTION_URL = `${URL_}/functions/v1/analyze-case`;
const SITE = 'https://revenue-recovery-v0.pages.dev';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const results = [];
const record = (status, name, detail = '') => { results.push({ status, name }); console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`); };
const expectOk = (name, ok, detail) => record(ok ? 'PASS' : 'FAIL', name, detail);
const refused = (r) => Boolean(r.error) || (Array.isArray(r.data) && r.data.length === 0) || r.data === null;

class Stop extends Error {}
// The platform rejected the founder's session token before the function ran (exit 3).
class PlatformJwtRejected extends Error {}
const sessions = [];
const created = [];

async function signIn(prefix) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword(ACCOUNTS[prefix]);
  if (error) throw new Stop(`${prefix}: sign-in failed: ${error.message}`);
  sessions.push({ prefix, c });
  const who = await c.rpc('whoami');
  return { c, who: who.data, token: data.session?.access_token ?? '' };
}

async function signOutAll() {
  for (const { prefix, c } of sessions.splice(0)) {
    const { error } = await c.auth.signOut({ scope: 'local' }).catch((e) => ({ error: e }));
    console.log(error ? `WARN  ${prefix}: sign-out failed — ${error.message}` : `      ${prefix}: signed out (this session only)`);
  }
}

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  if (created.length) console.log(`Synthetic cases created: ${created.join(', ')} (for cleanup).`);
  await signOutAll();
  process.exit(code);
}
process.once('SIGINT', () => { console.error('interrupted: signing out before exiting'); void finish(130); });

/**
 * Calls the function. Returns only the status, whether the body has the function's own
 * shape ({outcome, code, analysis_id} and nothing else), and its code if it is a plain
 * code. The body itself is never printed.
 */
async function invoke({ token = null, body = '{}', method = 'POST', type = 'application/json', origin = null } = {}) {
  const headers = { apikey: KEY };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (type) headers['content-type'] = type;
  if (origin) headers.origin = origin;
  const res = await fetch(FUNCTION_URL, { method, headers, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(150_000) });
  let parsed = null;
  try { parsed = JSON.parse(await res.text()); } catch { /* not JSON */ }
  const own = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && JSON.stringify(Object.keys(parsed)) === '["outcome","code","analysis_id"]';
  const code = own && /^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.code) ? parsed.code : null;
  const analysisId = own && typeof parsed.analysis_id === 'string' && UUID.test(parsed.analysis_id) ? parsed.analysis_id : null;
  return { status: res.status, own, code, outcome: own ? parsed.outcome : null, analysisId, hasAnalysis: own && parsed.analysis_id !== null };
}
const show = (r) => `HTTP ${r.status}${r.code ? ` ${r.code}` : r.own ? '' : ' (platform response)'}`;
/** A refusal: the expected status, and no analysis id handed out. */
const refusal = (name, r, status, code) =>
  expectOk(name, r.status === status && !r.hasAnalysis && (code === undefined || r.code === code), show(r));

async function run() {
  const A = await signIn('CLIENT_A');
  const B = await signIn('CLIENT_B');
  const F = await signIn('FOUNDER');
  if (A.who?.role !== 'CLIENT' || B.who?.role !== 'CLIENT' || F.who?.role !== 'FOUNDER' || A.who.business_id === B.who.business_id) {
    throw new Stop('accounts must be: two CLIENTS of different businesses, and the FOUNDER');
  }

  console.log('== Spending must be disabled (this check never enables it)');
  const before = await F.c.rpc('founder_ai_spend_summary');
  if (before.error || typeof before.data?.enabled !== 'boolean') throw new Stop('the founder cannot read the spending summary (is Stage 2A-5d-3a deployed?)');
  if (before.data.enabled !== false) throw new Stop('spending is ENABLED on staging; this check only runs with spending disabled. Disable it first.');
  record('PASS', 'spending is disabled', `committed ${before.data.committed_usd} USD`);

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const ref = `AC-LIVE-${stamp}`;
  const mk = await A.c.rpc('client_create_case', {
    p_idempotency_key: crypto.randomUUID(), p_reference: ref, p_product_service: 'Synthetic live check', p_lead_source: 'Other',
    p_conversation_source: 'TEXT', p_conversation_text: 'Prospect: SYNTHETIC live check, the price feels high. Business: Synthetic reply.',
  });
  if (mk.error || !mk.data) throw new Stop(`could not create the synthetic case: ${mk.error?.message}`);
  created.push(ref);
  const caseId = mk.data;
  const sub = await A.c.rpc('client_submit_case', { p_case_id: caseId });
  if (sub.error) throw new Stop(`could not submit the synthetic case: ${sub.error.message}`);
  const caseBody = JSON.stringify({ case_id: caseId });
  const analysesOfCase = async () => (await F.c.from('analyses').select('id').eq('case_id', caseId)).data?.length ?? -1;

  console.log('== Platform JWT check: the founder\'s session must reach the function');
  const gate = await invoke({ token: F.token, body: '{"case_id": 1}' });
  if (!gate.own && gate.status === 401) throw new PlatformJwtRejected();
  if (gate.own && gate.status === 401) throw new Stop('the function could not verify the founder\'s session with Supabase Auth (401 UNAUTHENTICATED)');
  if (gate.own && gate.status === 503) throw new Stop(`the function refuses to run: ${gate.code} (check its settings: ANALYSIS_PROVIDER=fake, ALLOW_FAKE_PROVIDER=staging-only)`);
  if (!gate.own) throw new Stop(`unexpected response from the function: ${show(gate)} (is analyze-case deployed?)`);
  refusal('founder session accepted by the platform; malformed body refused by the function', gate, 400, 'INVALID_REQUEST');

  console.log('== Unauthenticated and unauthorised callers (nothing may start)');
  refusal('no Authorization header', await invoke({ body: caseBody }), 401);
  refusal('the publishable key used as a Bearer token', await invoke({ token: KEY, body: caseBody }), 401);
  refusal('a forged JWT-shaped token', await invoke({ token: `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`, body: caseBody }), 401);
  refusal('client A on its OWN case (businesses cannot run analyses)', await invoke({ token: A.token, body: caseBody }), 403, 'FORBIDDEN');
  refusal('client B (another business) on that case', await invoke({ token: B.token, body: caseBody }), 403, 'FORBIDDEN');
  refusal('the founder from another website (Origin)', await invoke({ token: F.token, body: caseBody, origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
  expectOk('no analysis was started by any of those calls', (await analysesOfCase()) === 0);

  console.log('== Invalid requests (founder)');
  refusal('GET instead of POST', await invoke({ token: F.token, method: 'GET', type: null }), 405, 'METHOD_NOT_ALLOWED');
  refusal('text/plain instead of JSON', await invoke({ token: F.token, body: caseBody, type: 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  refusal('a body that is not JSON', await invoke({ token: F.token, body: 'not json' }), 400, 'INVALID_JSON');
  refusal('an extra field', await invoke({ token: F.token, body: JSON.stringify({ case_id: caseId, provider: 'anthropic' }) }), 400, 'INVALID_REQUEST');
  refusal('a body over 1 KiB', await invoke({ token: F.token, body: JSON.stringify({ case_id: caseId, pad: 'x'.repeat(2000) }) }), 413, 'BODY_TOO_LARGE');
  refusal('an unknown case', await invoke({ token: F.token, body: JSON.stringify({ case_id: '00000000-0000-4000-8000-000000000000' }) }), 404, 'NOT_FOUND');
  expectOk('still no analysis started', (await analysesOfCase()) === 0);

  console.log('== Founder run with spending disabled');
  const r = await invoke({ token: F.token, body: caseBody });
  expectOk('the founder\'s run is refused for spending: FAILED / SPENDING_DISABLED, with its analysis id',
    r.status === 200 && r.outcome === 'FAILED' && r.code === 'SPENDING_DISABLED' && r.analysisId !== null, show(r));
  const id = r.analysisId;
  const row = id ? await F.c.from('analyses').select('status, error, output, ai_classification, ai_proposed_message, model').eq('id', id).maybeSingle() : { data: null };
  expectOk('founder reads the analysis: ERROR, PIPELINE_ERROR: SPENDING_DISABLED, no output, classification or message',
    row.data?.status === 'ERROR' && row.data.error === 'PIPELINE_ERROR: SPENDING_DISABLED' && row.data.output === null
      && row.data.ai_classification === null && row.data.ai_proposed_message === null);
  const kase = await F.c.from('cases').select('workflow_state').eq('id', caseId).maybeSingle();
  expectOk('the lock was released: the case is SUBMITTED again', kase.data?.workflow_state === 'SUBMITTED', kase.data?.workflow_state);
  const after = await F.c.rpc('founder_ai_spend_summary');
  expectOk('spending unchanged: still disabled, nothing reserved, held or committed by this run',
    after.data?.enabled === false && after.data.committed_usd === before.data.committed_usd
      && after.data.open_reservations === before.data.open_reservations && after.data.held_reservations === before.data.held_reservations);
  const again = await invoke({ token: F.token, body: caseBody });
  expectOk('a second run is accepted (lock released) and refused for spending again', again.status === 200 && again.code === 'SPENDING_DISABLED', show(again));

  console.log('== Businesses and anonymous callers see no analysis and no spending information');
  const anon = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const [who, c] of [['client A (case owner)', A.c], ['client B', B.c], ['anonymous', anon]]) {
    expectOk(`${who}: no rows from analyses`, refused(await c.from('analyses').select('id, output, error')));
    if (id) expectOk(`${who}: the analysis is invisible by id`, refused(await c.from('analyses').select('id').eq('id', id)));
    expectOk(`${who}: no rows from contact_restrictions`, refused(await c.from('contact_restrictions').select('id')));
    expectOk(`${who}: spending summary refused`, Boolean((await c.rpc('founder_ai_spend_summary')).error));
    expectOk(`${who}: private spending tables unreachable`, refused(await c.schema('private').from('ai_spend_ledger').select('analysis_id')));
    for (const [fn, args] of [
      ['internal_reserve_ai_spend', { p_analysis_id: id, p_analyst_model: 'FAKE-PROVIDER-NOT-AI', p_reviewer_model: 'FAKE-PROVIDER-NOT-AI' }],
      ['internal_ai_dispatch', { p_analysis_id: id, p_role: 'ANALYST' }],
      ['internal_ai_report_usage', { p_analysis_id: id, p_role: 'ANALYST', p_input_tokens: 0, p_output_tokens: 0 }],
      ['internal_complete_analysis', { p_analysis_id: id, p_status: 'ERROR', p_error: 'synthetic' }],
    ]) {
      expectOk(`${who}: ${fn} refused`, Boolean((await c.rpc(fn, args)).error));
    }
  }
  const own = await A.c.rpc('client_get_case', { p_case_id: caseId });
  const text = JSON.stringify(own.data ?? {});
  expectOk('client A\'s own case view carries nothing from the analysis or spending',
    !own.error && !(id && text.includes(id)) && !/PIPELINE_ERROR|SPENDING|reserved|usd|adversarial|hypothes|recommendation|FAKE PROVIDER/i.test(text));
  expectOk('client B cannot read client A\'s case', refused(await B.c.rpc('client_get_case', { p_case_id: caseId })));
  const fRead = id ? await F.c.from('analyses').select('id').eq('id', id) : { data: [] };
  expectOk('control: the founder CAN read that analysis', fRead.data?.length === 1);
}

let code;
try {
  await run();
  const failed = results.filter((x) => x.status === 'FAIL').length;
  console.log(`== ${results.filter((x) => x.status === 'PASS').length} pass, ${failed} fail, ${results.filter((x) => x.status === 'WARN').length} warn, ${results.filter((x) => x.status === 'INFO').length} info`);
  code = failed ? 1 : 0;
} catch (e) {
  if (e instanceof PlatformJwtRejected) {
    console.error('STOP: the platform rejected the founder\'s valid session token before the function ran (HTTP 401, platform response).');
    console.error('      Do NOT redeploy with --no-verify-jwt. Report this output; the function refuses every call, so nothing is exposed.');
    code = 3;
  } else {
    console.error(e instanceof Stop ? `stopped: ${e.message}` : `stopped by an unexpected error: ${e?.message ?? e}`);
    code = 2;
  }
}
await finish(code);

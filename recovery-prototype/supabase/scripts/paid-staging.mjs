#!/usr/bin/env node
// Durable paid (Kimi) configuration of the Supabase STAGING project, for direct founder-dashboard
// analyses. Run by the "Supabase staging — paid analysis" GitHub Actions workflow (protected
// environment staging-paid); never by a schedule, never automatically.
//
//   node supabase/scripts/paid-staging.mjs readiness                  read-only check (no provider call)
//   node supabase/scripts/paid-staging.mjs activate                   Kimi settings + spending ON (USD 3 allowance)
//   node supabase/scripts/paid-staging.mjs deactivate                 spending OFF (the Kimi key is kept)
//   node supabase/scripts/paid-staging.mjs deactivate-and-remove-key  spending OFF and the paid settings deleted
//
// Environment: SUPABASE_ACCESS_TOKEN (all), KIMI_API_KEY (activate; readiness compares its digest).
// Neither is ever printed: every line of output passes through redact().
//
// What it NEVER does: call the Kimi (Moonshot) API, start an analysis, send anything to a
// prospect, raise a limit, or touch any project but staging. The only function request it makes
// carries NO credential (to prove the platform JWT check refuses it before the function runs).
//
// Every database change is ONE atomic statement (a DO block) keyed on the configuration table's
// exact singleton key (id = true; the schema is inspected first), asserting the number of rows
// each update changed; any failed assertion raises and the whole change rolls back.

import { createHash } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { deployedProblems, kimiDeployedProblems } from './function-source-guard.mjs';
import { accessToken, providerKeyProblem, trimEdges } from './live-guards.mjs';
import { scenarioText, SCENARIOS } from './synthetic-scenarios.mjs';

export const REF = 'aqwdwswpmbnzmkvyuqil';
const MGMT = 'https://api.supabase.com';
const FUNCTION_URL = `https://${REF}.supabase.co/functions/v1/analyze-case`;
export const FRONTEND_URL = 'https://revenue-recovery-v0.pages.dev';
const FN = 'analyze-case';
const FAKE_MODEL = 'FAKE-PROVIDER-NOT-AI';
export const KIMI = Object.freeze({ model: 'kimi-k3', in: 3, out: 15, cap: 8000 });
export const PER_ANALYSIS_CAP_USD = 1;
export const ALLOWANCE_USD = 3;
/** What the deployed bundle must contain besides the reviewed safeguards: the fixed model and the contract-id fix (9f5bf4c). */
export const DEPLOYED_MARKERS = ["KIMI_MODEL = 'kimi-k3'", 'rre-6f-analyst-v3+reviewer-v3'];
/** What the live frontend must contain: the founder's paid action, its confirmation, and the spending gate. */
export const FRONTEND_MARKERS = ['Run paid analysis', 'The total permitted cost is capped at $1.', 'founder_ai_spend_summary'];
const PAID_SETTINGS = ['ANALYSIS_PROVIDER', 'ALLOW_PAID_PROVIDER', 'KIMI_API_KEY'];
/** Settings that must be ABSENT while Kimi is the provider (another provider, the fake, model overrides). */
const FORBIDDEN_WITH_KIMI = /^(ALLOW_FAKE_PROVIDER|ANTHROPIC_[A-Z0-9_]*|ANALYST_MODEL|REVIEWER_MODEL)$/;
const ANALYSABLE = ['SUBMITTED', 'PROSPECT_REPLIED', 'REANALYZING'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- output: never a credential
const secrets = [];
const redact = (s) => { let t = String(s); for (const v of secrets) if (v) t = t.split(v).join('[REDACTED]'); return t; };
const summary = [];
const out = (...a) => { const l = redact(a.join(' ')); console.log(l); summary.push(l); };
class Stop extends Error {}
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  out(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const must = (name, ok, detail) => { if (!check(name, ok, detail)) throw new Stop(name); };

// ---------------------------------------------------------------- Management API
let TOKEN = '';
async function mgmt(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`${MGMT}/v1/projects/${REF}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Stop(`Management API unreachable (${e?.name ?? 'error'})`);
  }
  const where = `${method} ${path.split('?')[0]}`;
  if (res.status === 401) throw new Stop(`the access token was rejected (401) for ${where}: expired, revoked or wrong`);
  if (res.status === 403) throw new Stop(`the access token lacks a permission for ${where}`);
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = typeof j?.message === 'string' ? j.message : ''; } catch { /* no body */ }
    // Only our own raised messages (RRE_…) are shown in full; anything else by status only.
    const own = /RRE_[A-Z]+: [^\n]{0,300}/.exec(msg)?.[0];
    throw new Stop(`Management API answered HTTP ${res.status} for ${where}${own ? `: ${own}` : ''}`);
  }
  if (raw) return new Uint8Array(await res.arrayBuffer());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
/** A read query: exactly one row with one json column `r`. */
async function read(tag, query) {
  const rows = await mgmt('/database/query', { method: 'POST', body: { query: `/* rre:${tag} */ select (${query}) as r` } });
  if (!Array.isArray(rows) || rows.length !== 1 || !('r' in rows[0])) throw new Stop(`unexpected answer to ${tag}`);
  return typeof rows[0].r === 'string' ? JSON.parse(rows[0].r) : rows[0].r;
}
/** A change: one DO block (atomic; any raise rolls the whole block back). */
async function change(tag, doBlock) {
  if (!/^do \$rre\$[\s\S]*\$rre\$;$/.test(doBlock)) throw new Stop(`internal: ${tag} is not a single DO block`);
  await mgmt('/database/query', { method: 'POST', body: { query: `/* rre:${tag} */ ${doBlock}` } });
}

// ---------------------------------------------------------------- schema and state
export const SCHEMA_SQL = `json_build_object(
  'id_type', (select data_type from information_schema.columns where table_schema = 'private' and table_name = 'ai_spend_config' and column_name = 'id'),
  'pk', (select coalesce(json_agg(a.attname order by a.attname), '[]'::json) from pg_index i
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
          where i.indrelid = 'private.ai_spend_config'::regclass and i.indisprimary),
  'id_check', exists (select 1 from pg_constraint where conrelid = 'private.ai_spend_config'::regclass and contype = 'c'
                        and pg_get_constraintdef(oid) = 'CHECK (id)'),
  'rows', (select count(*) from private.ai_spend_config),
  'key_rows', (select count(*) from private.ai_spend_config where id = true))`;

/** The singleton key is exactly `id = true`: a boolean primary key constrained to true, one row. */
export function schemaProblem(s) {
  if (!s || s.id_type !== 'boolean') return 'private.ai_spend_config.id is not a boolean column';
  if (JSON.stringify(s.pk) !== '["id"]') return 'private.ai_spend_config primary key is not exactly (id)';
  if (s.id_check !== true) return 'private.ai_spend_config has no CHECK (id) constraint';
  if (Number(s.rows) !== 1 || Number(s.key_rows) !== 1) return `private.ai_spend_config must hold exactly one row with id = true (rows ${s.rows}, id = true ${s.key_rows})`;
  return null;
}

export const STATE_SQL = `json_build_object(
  'enabled', (select enabled from private.ai_spend_config where id = true),
  'budget', (select budget_usd from private.ai_spend_config where id = true),
  'stop', (select stop_at_usd from private.ai_spend_config where id = true),
  'max', (select max_reservation_usd from private.ai_spend_config where id = true),
  'limits', (select json_build_object('founder_24h', founder_attempts_24h, 'case_24h', case_attempts_24h, 'case_total', case_attempts_total)
               from private.ai_spend_config where id = true),
  'committed', private.ai_committed_usd(),
  'unsettled', (select count(*) from private.ai_spend_ledger where status in ('RESERVED', 'HELD')),
  'models', (select coalesce(json_agg(json_build_object('model', model, 'in', input_usd_per_mtok, 'out', output_usd_per_mtok,
               'cap', max_output_tokens, 'active', active) order by model), '[]'::json) from private.ai_model_prices))`;

const kimiRow = (s) => s.models.find((m) => m.model === KIMI.model);
const reviewedKimi = (r) => !!r && Number(r.in) === KIMI.in && Number(r.out) === KIMI.out && Number(r.cap) === KIMI.cap;

// ---------------------------------------------------------------- the database changes
export const ACTIVATE_SQL = `do $rre$
declare
  v_cfg private.ai_spend_config;
  v_price private.ai_model_prices;
  v_committed numeric;
  v_stop numeric;
  v_budget numeric;
  v_n integer;
begin
  if (select count(*) from private.ai_spend_config) <> 1 then
    raise exception 'RRE_ACTIVATE: expected exactly one spending configuration row';
  end if;
  select * into v_cfg from private.ai_spend_config where id = true for update;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'RRE_ACTIVATE: no spending configuration row with id = true'; end if;
  if v_cfg.max_reservation_usd <> ${PER_ANALYSIS_CAP_USD} then
    raise exception 'RRE_ACTIVATE: the per-analysis cap is not USD ${PER_ANALYSIS_CAP_USD} (found %)', v_cfg.max_reservation_usd;
  end if;
  select * into v_price from private.ai_model_prices where model = '${KIMI.model}' for update;
  if not found or v_price.input_usd_per_mtok <> ${KIMI.in} or v_price.output_usd_per_mtok <> ${KIMI.out} or v_price.max_output_tokens <> ${KIMI.cap} then
    raise exception 'RRE_ACTIVATE: the ${KIMI.model} price row is not the reviewed USD ${KIMI.in} / ${KIMI.out} per million tokens with an output cap of ${KIMI.cap}';
  end if;
  if exists (select 1 from private.ai_model_prices where active and model not in ('${KIMI.model}', '${FAKE_MODEL}')) then
    raise exception 'RRE_ACTIVATE: another paid model is active';
  end if;
  if exists (select 1 from private.ai_spend_ledger where status in ('RESERVED', 'HELD')) then
    raise exception 'RRE_ACTIVATE: a spending reservation is RESERVED or HELD; reconcile it first';
  end if;
  -- The allowance is lowered to USD ${ALLOWANCE_USD}, never raised.
  v_stop := least(v_cfg.stop_at_usd, ${ALLOWANCE_USD});
  v_budget := least(v_cfg.budget_usd, ${ALLOWANCE_USD});
  v_committed := private.ai_committed_usd();
  if v_committed + v_cfg.max_reservation_usd > v_stop then
    raise exception 'RRE_ACTIVATE: committed spending (USD %) leaves no room for a USD ${PER_ANALYSIS_CAP_USD} analysis under the USD % allowance', v_committed, v_stop;
  end if;
  update private.ai_model_prices set active = true where model = '${KIMI.model}';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'RRE_ACTIVATE: activating the ${KIMI.model} price changed % rows', v_n; end if;
  update private.ai_spend_config set budget_usd = v_budget, stop_at_usd = v_stop, enabled = true, updated_at = now() where id = true;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'RRE_ACTIVATE: the configuration update changed % rows', v_n; end if;
end $rre$;`;

export const DEACTIVATE_SQL = `do $rre$
declare
  v_n integer;
begin
  update private.ai_spend_config set enabled = false, updated_at = now() where id = true;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'RRE_DEACTIVATE: the configuration update changed % rows', v_n; end if;
  update private.ai_model_prices set active = false where model = '${KIMI.model}';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'RRE_DEACTIVATE: deactivating the ${KIMI.model} price changed % rows', v_n; end if;
end $rre$;`;

// ---------------------------------------------------------------- the deployed function
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
async function checkFunction() {
  const fn = await mgmt(`/functions/${FN}`);
  must(`${FN} is ACTIVE with the platform JWT check ON`, fn?.status === 'ACTIVE' && fn?.verify_jwt === true,
    `status ${fn?.status}, verify_jwt ${fn?.verify_jwt}`);
  const src = decodeBody(await mgmt(`/functions/${FN}/body`, { raw: true }));
  const problems = [...deployedProblems(src ?? ''), ...kimiDeployedProblems(src ?? ''),
    ...DEPLOYED_MARKERS.filter((m) => !(src ?? '').includes(m)).map((m) => `missing: ${m}`)];
  must('the deployed code is the reviewed Kimi-capable version (model fixed to kimi-k3; contract-id fix present)', problems.length === 0,
    problems[0] ?? `version ${fn?.version ?? '?'}`);
  return { version: fn?.version ?? null, updatedAt: fn?.updated_at ?? null };
}

// ---------------------------------------------------------------- function settings (secrets)
async function settings() {
  const list = await mgmt('/secrets');
  if (!Array.isArray(list)) throw new Stop('unexpected answer when listing the function settings');
  return new Map(list.map((s) => [String(s?.name ?? ''), typeof s?.value === 'string' ? s.value : '']));
}
/** Proves the settings select Kimi, without reading any value: names, and SHA-256 digests where the API gives them. */
function checkSettings(s, kimiKey) {
  must('Kimi settings present: ANALYSIS_PROVIDER, ALLOW_PAID_PROVIDER, KIMI_API_KEY (values not shown)', PAID_SETTINGS.every((n) => s.has(n)));
  const forbidden = [...s.keys()].filter((n) => FORBIDDEN_WITH_KIMI.test(n));
  must('no fake-provider, Anthropic or model-override setting is present', forbidden.length === 0, forbidden.length ? forbidden.join(', ') : '');
  const hex = (v) => /^[0-9a-f]{64}$/.test(v);
  if ([...PAID_SETTINGS].every((n) => hex(s.get(n)))) {
    must('ANALYSIS_PROVIDER is "kimi" (digest)', s.get('ANALYSIS_PROVIDER') === sha('kimi'));
    must('ALLOW_PAID_PROVIDER is "staging-only" (digest)', s.get('ALLOW_PAID_PROVIDER') === sha('staging-only'));
    if (kimiKey) must('KIMI_API_KEY equals the protected GitHub secret (digest; value not shown)', s.get('KIMI_API_KEY') === sha(kimiKey));
  } else {
    // Without digests: with no fake or Anthropic setting, any ANALYSIS_PROVIDER other than kimi refuses every call.
    check('provider digests unavailable from the API; with no fake or Anthropic setting, only Kimi can run (anything else refuses every call)', true);
  }
}
async function writeKimiSettings(kimiKey) {
  await mgmt('/secrets', { method: 'POST', body: [
    { name: 'ANALYSIS_PROVIDER', value: 'kimi' }, { name: 'ALLOW_PAID_PROVIDER', value: 'staging-only' }, { name: 'KIMI_API_KEY', value: kimiKey },
  ] });
  const stale = [...(await settings()).keys()].filter((n) => FORBIDDEN_WITH_KIMI.test(n));
  if (stale.length) await mgmt('/secrets', { method: 'DELETE', body: stale });
}

// ---------------------------------------------------------------- the synthetic acceptance case
const CASE_PREFIX = 'DASH-PAID-';
const BUSINESS_SQL = `(select json_build_object('business_id', b.id, 'business_name', b.name, 'member', m.user_id)
   from public.businesses b join public.business_members m on m.business_id = b.id
  where b.name like 'Synthetic %'
  order by (b.name = 'Synthetic Autos A') desc, b.created_at, m.user_id limit 1)`;
const caseSql = (prefix) => `(select json_build_object('id', c.id, 'reference', c.reference, 'state', c.workflow_state, 'business', b.name,
     'analyses', (select count(*) from public.analyses a where a.case_id = c.id))
   from public.cases c join public.businesses b on b.id = c.business_id
  where c.reference like '${prefix}%' and c.workflow_state in (${ANALYSABLE.map((s) => `'${s}'`).join(', ')})
    and not exists (select 1 from public.analyses a where a.case_id = c.id)
  order by c.created_at desc limit 1)`;

async function prepareCase() {
  const existing = await read('case', caseSql(CASE_PREFIX));
  if (existing) return existing;
  const biz = await read('business', BUSINESS_SQL);
  if (!biz || !UUID.test(String(biz.member)) || !UUID.test(String(biz.business_id))) {
    throw new Stop('no synthetic test business (name starting "Synthetic ") with a member exists on staging');
  }
  const scenario = /academy/i.test(biz.business_name) ? 'academy-price' : 'car-price';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const ref = `${CASE_PREFIX}${stamp}`;
  const text = scenarioText(scenario, stamp, biz.business_name);
  if (!text || text.includes('$rre_text$')) throw new Stop('internal: the synthetic conversation cannot be quoted');
  const key = crypto.randomUUID();
  // Serialised and re-checked inside the statement: two concurrent runs never both create a case.
  await change('casecreate', `do $rre$
declare v_case uuid;
begin
  perform pg_advisory_xact_lock(hashtext('rre-dash-paid-case'));
  if exists (select 1 from public.cases c where c.reference like '${CASE_PREFIX}%'
               and c.workflow_state in (${ANALYSABLE.map((x) => `'${x}'`).join(', ')})
               and not exists (select 1 from public.analyses a where a.case_id = c.id)) then
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', '${biz.member}', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_case := public.client_create_case('${key}'::uuid, '${ref}', '${SCENARIOS[scenario].title.replace(/'/g, '')}', 'Other', 'TEXT', $rre_text$${text}$rre_text$);
  perform public.client_submit_case(v_case);
  execute 'reset role';
end $rre$;`);
  const made = await read('case', caseSql(CASE_PREFIX));
  if (!made) throw new Stop('the synthetic case was not found after creating it');
  return made;
}

/** As the founder and as the case's business, through the same functions and RLS the dashboard uses. Read-only. */
const accessSql = (caseId) => `do $rre$
declare
  v_founder uuid;
  v_member uuid;
  v_j jsonb;
  v_n integer;
begin
  if (select count(*) from public.founders) <> 1 then raise exception 'RRE_READY: expected exactly one founder'; end if;
  select user_id into v_founder from public.founders;
  select m.user_id into v_member from public.business_members m join public.cases c on c.business_id = m.business_id
   where c.id = '${caseId}' order by m.user_id limit 1;
  if v_member is null then raise exception 'RRE_READY: the case''s business has no member'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_founder, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  if (public.founder_ai_spend_summary() ->> 'enabled') is distinct from 'true' then
    raise exception 'RRE_READY: the founder''s spending summary does not say enabled (the Run paid analysis button would be hidden)';
  end if;
  if not exists (select 1 from public.cases where id = '${caseId}' and workflow_state in (${ANALYSABLE.map((s) => `'${s}'`).join(', ')})) then
    raise exception 'RRE_READY: the founder cannot see the case in an analysable state';
  end if;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', v_member, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from public.analyses;
  if v_n <> 0 then raise exception 'RRE_READY: a business account can read % analyses', v_n; end if;
  v_j := public.client_get_case('${caseId}');
  if v_j ?| array['output', 'observations', 'hypotheses', 'adversarial_review', 'recommendation', 'ai_proposed_message', 'model', 'analysis_id'] then
    raise exception 'RRE_READY: the business case view carries an internal field';
  end if;
  begin
    perform public.founder_ai_spend_summary();
    raise exception 'RRE_READY: a business account can read the spending summary';
  exception when others then if sqlerrm like 'RRE_READY:%' then raise; end if;
  end;
  begin
    perform public.founder_start_analysis('${caseId}');
    raise exception 'RRE_READY: a business account can start an analysis';
  exception when others then if sqlerrm like 'RRE_READY:%' then raise; end if;
  end;
  execute 'reset role';
end $rre$;`;

// ---------------------------------------------------------------- public endpoints (no credential sent)
async function checkPlatformJwt() {
  let status = 0;
  let own = false;
  try {
    const res = await fetch(FUNCTION_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"case_id": "00000000-0000-4000-8000-000000000000"}',
      redirect: 'error', signal: AbortSignal.timeout(30_000) });
    status = res.status;
    try { const j = await res.json(); own = JSON.stringify(Object.keys(j ?? {})) === '["outcome","code","analysis_id"]'; } catch { /* platform text */ }
  } catch { status = -1; }
  must('a request with no credential is refused by the platform before the function runs (no analysis, no provider call)', status === 401 && !own, `HTTP ${status}`);
}
async function checkFrontend() {
  let html = '';
  try { html = await (await fetch(`${FRONTEND_URL}/`, { signal: AbortSignal.timeout(30_000) })).text(); } catch { /* below */ }
  const scripts = [...html.matchAll(/<script[^>]+src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  let js = '';
  for (const s of scripts) {
    try { js += await (await fetch(`${FRONTEND_URL}${s}`, { signal: AbortSignal.timeout(30_000) })).text(); } catch { /* below */ }
  }
  const missing = FRONTEND_MARKERS.filter((m) => !js.includes(m));
  must(`the live frontend (${FRONTEND_URL}) has the founder's "Run paid analysis" action, its $1 confirmation and the spending gate`,
    scripts.length > 0 && missing.length === 0, missing.length ? `missing: ${missing.join(' | ')}` : `${scripts.length} script(s)`);
}

// ---------------------------------------------------------------- the commands
async function readState() {
  const schema = await read('schema', SCHEMA_SQL);
  const problem = schemaProblem(schema);
  must('spending configuration schema: singleton key is exactly id = true (boolean primary key, CHECK (id), one row)', !problem, problem ?? '');
  const s = await read('state', STATE_SQL);
  if (!s || typeof s.enabled !== 'boolean' || !Array.isArray(s.models)) throw new Stop('could not read the spending state');
  return s;
}
const fmtState = (s) => `enabled ${s.enabled}; per-analysis cap USD ${Number(s.max)}; allowance (stop) USD ${Number(s.stop)} of budget USD ${Number(s.budget)}; `
  + `committed USD ${Number(s.committed)}; limits ${s.limits?.founder_24h}/founder/24h, ${s.limits?.case_24h}/case/24h, ${s.limits?.case_total}/case total`;

async function readiness(kimiKey) {
  out('== Readiness (read-only; no provider call, no analysis)');
  const fn = await checkFunction();
  checkSettings(await settings(), kimiKey);
  const s = await readState();
  out(`      ${fmtState(s)}`);
  must('spending is enabled', s.enabled === true);
  must(`the per-analysis cap is USD ${PER_ANALYSIS_CAP_USD}`, Number(s.max) === PER_ANALYSIS_CAP_USD);
  must(`the allowance is at most USD ${ALLOWANCE_USD} and leaves room for one USD ${PER_ANALYSIS_CAP_USD} analysis`,
    Number(s.stop) <= ALLOWANCE_USD && Number(s.committed) + PER_ANALYSIS_CAP_USD <= Number(s.stop), `committed USD ${Number(s.committed)}`);
  must(`${KIMI.model} is active at the reviewed USD ${KIMI.in} / ${KIMI.out} per million tokens, cap ${KIMI.cap}`, reviewedKimi(kimiRow(s)) && kimiRow(s).active === true);
  must('no other paid model is active', !s.models.some((m) => m.active && m.model !== KIMI.model && m.model !== FAKE_MODEL));
  must('no reservation is RESERVED or HELD', Number(s.unsettled) === 0);
  const c = await read('case', caseSql(CASE_PREFIX));
  must('an eligible synthetic case exists (analysable state, no analysis yet)', !!c && UUID.test(String(c.id)), c ? `${c.reference} (${c.business}), ${c.state}` : 'none');
  await change('access', accessSql(c.id));
  check('as the founder: spending summary says enabled, the case is visible and analysable (the button shows)', true);
  check('as the business: no analysis readable, no internal field, no spending summary, cannot start an analysis', true);
  await checkPlatformJwt();
  await checkFrontend();
  return { fn, state: s, case: c };
}

async function activate(kimiKey) {
  out('== Activation (Kimi settings, then spending on; never a provider call)');
  const before = await readState();
  out(`      before: ${fmtState(before)}`);
  must(`the ${KIMI.model} price row is the reviewed USD ${KIMI.in} / ${KIMI.out}, cap ${KIMI.cap}`, reviewedKimi(kimiRow(before)), 'nothing changed');
  must('no reservation is RESERVED or HELD', Number(before.unsettled) === 0, 'nothing changed');
  must(`committed spending leaves room for one USD ${PER_ANALYSIS_CAP_USD} analysis under USD ${ALLOWANCE_USD}`,
    Number(before.committed) + PER_ANALYSIS_CAP_USD <= Math.min(Number(before.stop), ALLOWANCE_USD), `committed USD ${Number(before.committed)}; nothing changed`);
  await checkFunction();
  await writeKimiSettings(kimiKey);
  checkSettings(await settings(), kimiKey);
  await change('activate', ACTIVATE_SQL);
  const after = await readState();
  out(`      after:  ${fmtState(after)}`);
  must('spending enabled, cap USD 1, allowance at most USD 3, kimi-k3 active, limits unchanged',
    after.enabled === true && Number(after.max) === PER_ANALYSIS_CAP_USD && Number(after.stop) <= ALLOWANCE_USD && Number(after.budget) <= ALLOWANCE_USD
    && kimiRow(after)?.active === true && JSON.stringify(after.limits) === JSON.stringify(before.limits));
  const c = await prepareCase();
  out(`      synthetic case: ${c.reference} (${c.business}), ${c.state}`);
  return readiness(kimiKey);
}

async function deactivate(removeKey) {
  out(`== Deactivation (spending off${removeKey ? '; paid settings deleted' : '; the Kimi key is kept'})`);
  await readState();
  await change('deactivate', DEACTIVATE_SQL);
  const s = await readState();
  out(`      after: ${fmtState(s)}`);
  must('spending is disabled and kimi-k3 is inactive', s.enabled === false && kimiRow(s)?.active === false);
  const names = await settings();
  if (removeKey) {
    const paid = [...names.keys()].filter((n) => PAID_SETTINGS.includes(n) || FORBIDDEN_WITH_KIMI.test(n));
    if (paid.length) await mgmt('/secrets', { method: 'DELETE', body: paid });
    const left = [...(await settings()).keys()].filter((n) => PAID_SETTINGS.includes(n) || FORBIDDEN_WITH_KIMI.test(n));
    must('the paid provider settings are deleted (the function now refuses every call until a provider is configured)', left.length === 0, left.join(', '));
  } else {
    check('the Kimi key is kept (an ordinary shutdown never deletes it)', names.has('KIMI_API_KEY'), names.has('KIMI_API_KEY') ? '' : 'it was not present');
  }
}

async function main() {
  const cmd = process.argv[2];
  if (!['readiness', 'activate', 'deactivate', 'deactivate-and-remove-key'].includes(cmd ?? '')) {
    console.error('usage: paid-staging.mjs readiness|activate|deactivate|deactivate-and-remove-key');
    return 2;
  }
  const pat = accessToken(process.env.SUPABASE_ACCESS_TOKEN);
  if (pat.problem) { console.error(`refused: SUPABASE_ACCESS_TOKEN: ${pat.problem}`); return 2; }
  TOKEN = pat.token;
  secrets.push(TOKEN, process.env.SUPABASE_ACCESS_TOKEN);
  const kimiKey = trimEdges(process.env.KIMI_API_KEY ?? '');
  if (kimiKey) secrets.push(kimiKey, process.env.KIMI_API_KEY);
  if (cmd === 'activate') {
    const problem = providerKeyProblem('kimi', kimiKey);
    if (problem) { console.error(`refused: KIMI_API_KEY is ${problem}`); return 2; }
  }
  try {
    if (cmd === 'readiness') await readiness(kimiKey || null);
    else if (cmd === 'activate') await activate(kimiKey);
    else await deactivate(cmd === 'deactivate-and-remove-key');
    out(`RESULT: ${cmd.toUpperCase()} PASSED (${results.filter((r) => r.ok).length} checks)`);
    return 0;
  } catch (e) {
    out(`RESULT: ${cmd.toUpperCase()} FAILED — ${e instanceof Stop ? e.message : 'unexpected error'}`);
    return 1;
  } finally {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) { try { (await import('node:fs')).appendFileSync(file, `\n\`\`\`\n${summary.join('\n')}\n\`\`\`\n`); } catch { /* summary is optional */ } }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();

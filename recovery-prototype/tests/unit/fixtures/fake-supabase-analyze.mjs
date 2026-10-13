// Test-only preload (node --import) for analyze-case-live-check.mjs. Replaces fetch
// with an in-process fake of staging (Auth, the PostgREST calls the script makes, and
// a deployed analyze-case function), and makes every real network connection throw.
// Each request is appended to FAKE_SUPABASE_LOG as one JSON line.
//
// Scenarios (FAKE_SUPABASE_SCENARIO):
//   correct            behaves like a correct deployment (every check passes)
//   platform-rejects   the platform's JWT check rejects the founder's session (401, platform body)
//   not-configured     the function answers 503 PROVIDER_NOT_CONFIGURED
//   spending-enabled   the spending summary says enabled
//   leaky              client A can read analyses rows (RLS broken)
//   business-allowed   the function lets client A run an analysis
//   hang               the function never answers (for Ctrl-C)
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const LOG = process.env.FAKE_SUPABASE_LOG;
const SCENARIO = process.env.FAKE_SUPABASE_SCENARIO ?? 'correct';
const log = (entry) => fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);

const block = (name) => function blocked() { log({ network: name }); throw new Error(`real network blocked by test: ${name}`); };
net.connect = net.createConnection = block('net.connect');
net.Socket.prototype.connect = block('net.Socket.connect');
tls.connect = block('tls.connect');
http.request = http.get = block('http.request');
https.request = https.get = block('https.request');

const USERS = {
  'client-a@synthetic.invalid': { role: 'CLIENT', business_id: '10000000-0000-4000-8000-00000000000a' },
  'client-b@synthetic.invalid': { role: 'CLIENT', business_id: '10000000-0000-4000-8000-00000000000b' },
  'founder@synthetic.invalid': { role: 'FOUNDER' },
};
const tokens = new Map(); // fake access token -> email
const cases = new Map(); // case id -> { owner, state }
const analyses = new Map(); // analysis id -> { case_id, status, error }
const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const fnBody = (status, outcome, code, analysis_id = null) => json(status, { outcome, code, analysis_id });
const role = (email) => USERS[email]?.role ?? null;

function rows(table, url, who) {
  const eq = (k) => url.searchParams.get(k)?.replace(/^eq\./, '');
  if (table === 'analyses') {
    if (role(who) !== 'FOUNDER' && !(SCENARIO === 'leaky' && who === 'client-a@synthetic.invalid')) return [];
    return [...analyses.entries()].filter(([id, a]) => (!eq('id') || eq('id') === id) && (!eq('case_id') || eq('case_id') === a.case_id))
      .map(([id, a]) => ({ id, case_id: a.case_id, status: a.status, error: a.error, output: null, ai_classification: null, ai_proposed_message: null, model: null }));
  }
  if (table === 'cases') {
    if (role(who) !== 'FOUNDER') return [];
    const c = cases.get(eq('id'));
    return c ? [{ workflow_state: c.state }] : [];
  }
  return []; // contact_restrictions and anything else: nothing visible here
}

async function analyzeCase(req, who, entry) {
  const h = req.headers;
  const auth = h.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  // The platform's verify_jwt check (only real session tokens pass).
  if (!bearer || !tokens.has(bearer)) return json(401, { code: 401, message: 'Invalid JWT' });
  if (SCENARIO === 'platform-rejects') return json(401, { code: 401, message: 'Invalid JWT' });
  if (SCENARIO === 'hang') return new Promise(() => { setInterval(() => {}, 1000); });
  if (SCENARIO === 'not-configured') return fnBody(503, 'NOT_STARTED', 'PROVIDER_NOT_CONFIGURED');
  // The function's own handler.
  if (h.get('origin') && h.get('origin') !== 'https://revenue-recovery-v0.pages.dev') return fnBody(403, 'NOT_STARTED', 'ORIGIN_NOT_ALLOWED');
  if (req.method !== 'POST') return fnBody(405, 'NOT_STARTED', 'METHOD_NOT_ALLOWED');
  if (role(who) !== 'FOUNDER' && !(SCENARIO === 'business-allowed' && who === 'client-a@synthetic.invalid')) return fnBody(403, 'NOT_STARTED', 'FORBIDDEN');
  if ((h.get('content-type') ?? '').split(';')[0] !== 'application/json') return fnBody(415, 'NOT_STARTED', 'UNSUPPORTED_MEDIA_TYPE');
  const text = await req.text();
  if (text.length > 1024) return fnBody(413, 'NOT_STARTED', 'BODY_TOO_LARGE');
  let v;
  try { v = JSON.parse(text); } catch { return fnBody(400, 'NOT_STARTED', 'INVALID_JSON'); }
  if (!v || typeof v !== 'object' || Object.keys(v).length !== 1 || typeof v.case_id !== 'string') return fnBody(400, 'NOT_STARTED', 'INVALID_REQUEST');
  const c = cases.get(v.case_id);
  if (!c) return fnBody(404, 'NOT_STARTED', 'NOT_FOUND');
  const id = crypto.randomUUID();
  analyses.set(id, { case_id: v.case_id, status: 'ERROR', error: 'PIPELINE_ERROR: SPENDING_DISABLED' });
  entry.analysisStarted = true;
  return fnBody(200, 'FAILED', 'SPENDING_DISABLED', id);
}

globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const who = tokens.get((req.headers.get('authorization') ?? '').replace(/^Bearer /i, '')) ?? null;
  const entry = { host: url.host, method: req.method, path: url.pathname, as: who, apikey: req.headers.get('apikey') };

  if (url.pathname === '/auth/v1/token') {
    const { email } = await req.json();
    log({ ...entry, signIn: email });
    const n = tokens.size + 1;
    const token = `fake-access-token-${n}.${'x'.repeat(12)}.${'y'.repeat(12)}`;
    tokens.set(token, email);
    const now = Math.floor(Date.now() / 1000);
    return json(200, {
      access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `fake-refresh-token-${n}`,
      user: { id: `00000000-0000-4000-8000-00000000000${n}`, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
    });
  }
  if (url.pathname === '/auth/v1/logout') {
    log({ ...entry, signOut: url.searchParams.get('scope') });
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/functions/v1/analyze-case') {
    log({ ...entry, fnStart: true });
    const res = await analyzeCase(req, who, entry);
    log({ ...entry, fn: true, status: res.status });
    return res;
  }
  log(entry);
  if (req.headers.get('accept-profile') === 'private') return json(406, { code: 'PGRST106', message: 'The schema must be one of the following: public, graphql_public' });
  const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
  if (rpc) {
    const fn = rpc[1];
    const args = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    if (fn === 'whoami') return json(200, USERS[who] ?? { role: 'NONE' });
    if (fn === 'founder_ai_spend_summary') {
      if (!who) return json(401, { code: '42501', message: 'permission denied for function founder_ai_spend_summary' });
      if (role(who) !== 'FOUNDER') return json(400, { code: '42501', message: 'FORBIDDEN: founder only' });
      return json(200, { enabled: SCENARIO === 'spending-enabled', budget_usd: 20, stop_at_usd: 18, committed_usd: 0, open_reservations: 0, held_reservations: 0 });
    }
    if (fn === 'client_create_case') {
      const id = crypto.randomUUID();
      cases.set(id, { owner: who, state: 'DRAFT' });
      return json(200, id);
    }
    if (fn === 'client_submit_case') { const c = cases.get(args.p_case_id); if (c) c.state = 'SUBMITTED'; return new Response(null, { status: 204 }); }
    if (fn === 'client_get_case') {
      const c = cases.get(args.p_case_id);
      if (!c || c.owner !== who) return json(400, { code: 'P0002', message: 'NOT_FOUND: case not found' });
      return json(200, { id: args.p_case_id, reference: 'AC-LIVE', status: 'UNDER_REVIEW' });
    }
    return json(who ? 403 : 401, { code: '42501', message: `permission denied for function ${fn}` });
  }
  const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
  if (table && req.method === 'GET') {
    const r = rows(table[1], url, who);
    if ((req.headers.get('accept') ?? '').includes('vnd.pgrst.object')) return r.length ? json(200, r[0]) : json(406, { code: 'PGRST116', message: 'no rows' });
    return json(200, r);
  }
  return json(400, { message: 'synthetic refusal' });
};

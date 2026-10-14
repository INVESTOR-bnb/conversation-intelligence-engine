// Stage 2A-5d-4b — the analyze-case Edge Function handler, end to end over HTTP:
// handler -> (fetch) -> local fake of Supabase's Auth/PostgREST/Storage APIs ->
// the REAL local database (RLS, grants, the analysis contract). Fake provider only.
// Run via supabase/scripts/test-pipeline-db.sh.

import { expect, test } from '@playwright/test';
import { sha256Hex } from '../../supabase/functions/_shared/analysis-pipeline/index.ts';
import { readConfig, STAGING_URL } from '../../supabase/functions/_shared/edge/config.ts';
import { FAKE_MARK } from '../../supabase/functions/_shared/edge/fakeProvider.ts';
import { createAnalyzeCaseHandler, sanitize } from '../../supabase/functions/_shared/edge/handler.ts';
import { BODY1, BODY2 } from './fakes';
import { FakeSupabase, LEGACY_SERVICE, PUBLISHABLE, SECRET } from './fakeSupabase';
import { BIZ_A, CLIENT_A, CLIENT_B, enableTestSpending, FOUNDER, makeRoomForCase, one, spend, sql } from './psqlDb';

const UNASSIGNED = '00000000-0000-4000-8000-00000000000e';
const ORIGIN = 'https://revenue-recovery-v0.pages.dev';
const fake = new FakeSupabase();
let logs: string[] = [];
let n = 0;

test.beforeAll(async () => {
  sql('select tests.seed() where not exists (select 1 from public.founders)');
  await fake.start();
});
test.afterAll(async () => { await fake.stop(); });
test.beforeEach(() => {
  enableTestSpending();
  logs = []; fake.requests = []; fake.secretKeyClaims = { role: 'service_role' }; fake.authDown = false; fake.failRpc.clear(); fake.storageDelayMs = 0; fake.beforeHandle = null;
});

function env(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    SUPABASE_URL: fake.url,
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
    ANALYSIS_PROVIDER: 'fake',
    ALLOW_FAKE_PROVIDER: 'staging-only',
    ...over,
  };
  return (k: string) => base[k];
}
const handler = (over: Record<string, string | undefined> = {}) =>
  createAnalyzeCaseHandler({ env: env(over), fetch: (i, init) => fetch(i, init), log: (l) => logs.push(l) });

async function call(opts: { token?: string | null; body?: string; method?: string; headers?: Record<string, string>; env?: Record<string, string | undefined> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const method = opts.method ?? 'POST';
  const res = await handler(opts.env)(new Request('https://edge.local/functions/v1/analyze-case', {
    method, headers, body: method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? undefined : (opts.body ?? '{}'),
  }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
}
const founder = () => fake.tokenFor(FOUNDER);
const caseBody = (c: string) => JSON.stringify({ case_id: c });

function textCase() {
  n += 1;
  makeRoomForCase();
  const c = one(`select public.client_create_case(gen_random_uuid(), :'ref', 'Synthetic car', 'Referral', 'TEXT', :'body')`,
    { ref: `EF-${n}`, body: BODY1 }, { role: 'authenticated', sub: CLIENT_A })!;
  sql(`select public.client_submit_case(:'c')`, { c }, { role: 'authenticated', sub: CLIENT_A });
  sql(`insert into public.case_messages (case_id, business_id, kind, body) values (:'c', :'b', 'PROSPECT_RESPONSE', :'body')`, { c, b: BIZ_A, body: BODY2 });
  return c;
}
/** A submitted SCREENSHOTS case whose files exist in (fake) Storage, with storage.objects rows. */
async function shotCase(count: number) {
  n += 1;
  makeRoomForCase();
  const c = one(`select public.client_create_case(gen_random_uuid(), :'ref', 'Synthetic car', 'Referral', 'SCREENSHOTS')`,
    { ref: `ES-${n}` }, { role: 'authenticated', sub: CLIENT_A })!;
  const paths: string[] = [];
  for (let p = 1; p <= count; p++) {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, p, 1, 2, 3]);
    const sha = await sha256Hex(bytes);
    const path = `${BIZ_A}/${c}/${p}-${sha}.png`;
    fake.storage.set(path, bytes);
    paths.push(path);
    sql(`begin; set local session_replication_role = replica;
         insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', :'path', :'u', '{"mimetype": "image/png"}');
         insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
           values (:'c', :'b', :'p', :'path', 'image/png', :'size', :'sha', :'u'); commit;`,
      { c, b: BIZ_A, p: String(p), path, size: String(bytes.length), sha, u: CLIENT_A });
  }
  sql(`update public.cases set workflow_state = 'SUBMITTED', evidence_version = 1 where id = :'c'`, { c });
  return { c, paths };
}
const analysis = (id: string) => JSON.parse(one(`select row_to_json(a) from public.analyses a where id = :'a'`, { a: id })!);
const analysesOf = (c: string) => Number(one(`select count(*) from public.analyses where case_id = :'c'`, { c }));
const caseState = (c: string) => one(`select workflow_state from public.cases where id = :'c'`, { c });

// ---------------------------------------------------------------- success with the clearly marked fake provider

test('founder: the run completes through the contract; the stored record is unmistakably a fake, not an analysis', async () => {
  const c = textCase();
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ outcome: 'COMPLETED', code: 'OK', analysis_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  const a = analysis(r.body.analysis_id);
  expect(a.status).toBe('INSUFFICIENT_EVIDENCE');
  expect(a.model).toBe('analyst:FAKE-PROVIDER-NOT-AI|reviewer:FAKE-PROVIDER-NOT-AI');
  expect([a.ai_classification, a.ai_proposed_message, a.input_tokens, a.output_tokens, Number(a.estimated_cost_usd)]).toEqual([null, null, 0, 0, 0]);
  expect(a.output.contract_version).toBe('rre-analysis/2');
  expect(a.output.hypotheses).toEqual([]);
  expect(a.output.recommendation.pursue).toBe('UNKNOWN');
  // Every text the founder can see says it is a fake.
  const texts = [a.output.evidence_assessment.summary, ...a.output.evidence_assessment.missing_evidence, a.output.recommendation.next_action.text,
    a.output.unknowns[0].question, a.output.adversarial_review.verdict_rationale, a.output.adversarial_review.challenges[0].challenge];
  for (const t of texts) expect(t).toContain(FAKE_MARK);
  expect(caseState(c)).toBe('AWAITING_ADMIN_REVIEW');
});

test('the service credential is used only for the spending calls and the completion, in order', async () => {
  const c = textCase();
  const r = await call({ token: founder(), body: caseBody(c) });
  const service = fake.requests.filter((x) => x.cred.startsWith('service'));
  expect(service.map((x) => x.path)).toEqual(['/rest/v1/rpc/internal_reserve_ai_spend', '/rest/v1/rpc/internal_ai_reservation_terms', '/rest/v1/rpc/internal_ai_dispatch', '/rest/v1/rpc/internal_ai_report_usage', '/rest/v1/rpc/internal_ai_dispatch', '/rest/v1/rpc/internal_ai_report_usage', '/rest/v1/rpc/internal_complete_analysis']);
  expect(service.every((x) => x.method === 'POST' && x.cred === 'service:secret')).toBe(true);
  expect(spend(r.body.analysis_id)).toBe('SETTLED:REPORTED_USAGE:0.0000');
  expect(fake.requests.filter((x) => !x.cred.startsWith('service')).every((x) => x.cred === `user:${FOUNDER}`)).toBe(true);
  expect(fake.requests.map((x) => x.path)).toEqual(expect.arrayContaining(['/auth/v1/user', '/rest/v1/rpc/whoami', '/rest/v1/rpc/founder_start_analysis']));
});

test('a legacy service_role JWT works too (apikey + Bearer), for the same service calls only', async () => {
  const c = textCase();
  const r = await call({ token: founder(), body: caseBody(c), env: { SUPABASE_SECRET_KEYS: undefined, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE } });
  expect(r.body.outcome).toBe('COMPLETED');
  expect(fake.requests.filter((x) => x.cred.startsWith('service')).map((x) => x.path)).toEqual(['/rest/v1/rpc/internal_reserve_ai_spend', '/rest/v1/rpc/internal_ai_reservation_terms', '/rest/v1/rpc/internal_ai_dispatch', '/rest/v1/rpc/internal_ai_report_usage', '/rest/v1/rpc/internal_ai_dispatch', '/rest/v1/rpc/internal_ai_report_usage', '/rest/v1/rpc/internal_complete_analysis']);
});

// ---------------------------------------------------------------- authentication and authorisation

test('unauthenticated or malformed credentials are refused before any database or storage access', async () => {
  for (const [name, headers] of [
    ['no Authorization', {}],
    ['publishable key as Bearer', { authorization: `Bearer ${PUBLISHABLE}` }],
    ['secret key as Bearer', { authorization: `Bearer ${SECRET}` }],
    ['Basic auth', { authorization: 'Basic Zm91bmRlcjpwYXNzd29yZA==' }],
    ['two-part token', { authorization: 'Bearer abcdefghijkl.mnopqrstuvwxyz' }],
    ['token with spaces', { authorization: 'Bearer aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc extra' }],
    ['huge token', { authorization: `Bearer ${'a'.repeat(5000)}.${'b'.repeat(5000)}.cccccccccccc` }],
  ] as const) {
    fake.requests = [];
    const r = await call({ headers: headers as Record<string, string>, body: caseBody(textCase()) });
    expect(r.status, name).toBe(401);
    expect(r.body, name).toEqual({ outcome: 'NOT_STARTED', code: 'UNAUTHENTICATED', analysis_id: null });
    expect(fake.requests, name).toEqual([]);
  }
});

test('a JWT that Supabase Auth does not accept (forged, expired, revoked) is refused', async () => {
  const forged = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: FOUNDER, role: 'authenticated' })).toString('base64url')}.forgedsignature000`;
  const c = textCase();
  const r = await call({ token: forged, body: caseBody(c) });
  expect([r.status, r.body.code]).toEqual([401, 'UNAUTHENTICATED']);
  expect(fake.requests.map((x) => x.path)).toEqual(['/auth/v1/user']);
  expect(analysesOf(c)).toBe(0);
});

test('signed-in business users and unassigned users are refused (403) and nothing is started', async () => {
  for (const user of [CLIENT_A, CLIENT_B, UNASSIGNED]) {
    const c = textCase();
    fake.requests = [];
    const r = await call({ token: fake.tokenFor(user), body: caseBody(c) });
    expect([r.status, r.body], user).toEqual([403, { outcome: 'NOT_STARTED', code: 'FORBIDDEN', analysis_id: null }]);
    expect(fake.requests.map((x) => x.path), user).toEqual(['/auth/v1/user', '/rest/v1/rpc/whoami']);
    expect(analysesOf(c), user).toBe(0);
  }
});

test('cross-tenant: another business cannot analyse, read or even learn about a case; results stay founder-only', async () => {
  const c = textCase();
  expect((await call({ token: fake.tokenFor(CLIENT_B), body: caseBody(c) })).body.code).toBe('FORBIDDEN');
  const done = await call({ token: founder(), body: caseBody(c) });
  for (const user of [CLIENT_A, CLIENT_B]) {
    const t = fake.tokenFor(user);
    for (const path of [`/rest/v1/analyses?select=id,output&case_id=eq.${c}`, `/rest/v1/contact_restrictions?select=id&case_id=eq.${c}`]) {
      const res = await fetch(`${fake.url}${path}`, { headers: { apikey: PUBLISHABLE, authorization: `Bearer ${t}` } });
      expect(await res.json(), `${user} ${path}`).toEqual([]);
    }
  }
  const anon = await fetch(`${fake.url}/rest/v1/analyses?select=id`, { headers: { apikey: PUBLISHABLE } });
  expect(anon.status).toBe(401);
  expect(done.body.outcome).toBe('COMPLETED');
});

test('an unknown case is NOT_FOUND (404), with no analysis created', async () => {
  const r = await call({ token: founder(), body: caseBody('0f0f0f0f-0000-4000-8000-000000000000') });
  expect([r.status, r.body.code]).toEqual([404, 'NOT_FOUND']);
});

test('Auth or database unavailable: 503, nothing started', async () => {
  fake.authDown = true;
  const c = textCase();
  expect(await call({ token: founder(), body: caseBody(c) })).toMatchObject({ status: 503, body: { code: 'AUTH_UNAVAILABLE' } });
  fake.authDown = false;
  fake.failRpc.add('whoami');
  expect(await call({ token: founder(), body: caseBody(c) })).toMatchObject({ status: 503, body: { code: 'AUTH_UNAVAILABLE' } });
  expect(analysesOf(c)).toBe(0);
});

// ---------------------------------------------------------------- strict request validation

test('malformed requests are refused and never start an analysis', async () => {
  const c = textCase();
  const t = founder();
  const cases: [string, Parameters<typeof call>[0], number, string][] = [
    ['GET', { method: 'GET' }, 405, 'METHOD_NOT_ALLOWED'],
    ['PUT', { method: 'PUT', body: caseBody(c) }, 405, 'METHOD_NOT_ALLOWED'],
    ['text/plain', { body: caseBody(c), headers: { 'content-type': 'text/plain' } }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['form', { body: `case_id=${c}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['too large', { body: JSON.stringify({ case_id: c, pad: 'x'.repeat(2000) }) }, 413, 'BODY_TOO_LARGE'],
    ['invalid JSON', { body: '{"case_id": ' }, 400, 'INVALID_JSON'],
    ['not UTF-8', { body: '�' }, 400, 'INVALID_JSON'],
    ['array', { body: JSON.stringify([c]) }, 400, 'INVALID_REQUEST'],
    ['string', { body: JSON.stringify(c) }, 400, 'INVALID_REQUEST'],
    ['empty object', { body: '{}' }, 400, 'INVALID_REQUEST'],
    ['extra key', { body: JSON.stringify({ case_id: c, analysis_id: c }) }, 400, 'INVALID_REQUEST'],
    ['not a uuid', { body: JSON.stringify({ case_id: 'abc' }) }, 400, 'INVALID_REQUEST'],
    ['filter injection', { body: JSON.stringify({ case_id: `${c},status.eq.ACTIVE` }) }, 400, 'INVALID_REQUEST'],
    ['sql-ish', { body: JSON.stringify({ case_id: "'; drop table public.analyses; --" }) }, 400, 'INVALID_REQUEST'],
    ['number', { body: JSON.stringify({ case_id: 42 }) }, 400, 'INVALID_REQUEST'],
    ['nested', { body: JSON.stringify({ case_id: { id: c } }) }, 400, 'INVALID_REQUEST'],
  ];
  for (const [name, opts, status, code] of cases) {
    const r = await call({ token: t, ...opts });
    expect([r.status, r.body.code], name).toEqual([status, code]);
    expect(Object.keys(r.body), name).toEqual(['outcome', 'code', 'analysis_id']);
  }
  expect(analysesOf(c)).toBe(0);
  expect(one(`select count(*) from public.analyses`)).not.toBeNull();
});

test('an upper-case uuid is accepted (normalised)', async () => {
  const c = textCase();
  expect((await call({ token: founder(), body: caseBody(c.toUpperCase()) })).body.outcome).toBe('COMPLETED');
});

test('CORS: only the configured site; preflight answered; other origins refused without CORS headers', async () => {
  const allowed = await call({ method: 'OPTIONS', headers: { origin: ORIGIN } });
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(allowed.headers.get('vary')).toBe('Origin');
  const evil = await call({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  expect(evil.status).toBe(403);
  expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  const c = textCase();
  const post = await call({ token: founder(), body: caseBody(c), headers: { origin: 'https://evil.example' } });
  expect([post.status, post.body.code]).toEqual([403, 'ORIGIN_NOT_ALLOWED']);
  expect(fake.requests).toEqual([]);
  const ok = await call({ token: founder(), body: caseBody(c), headers: { origin: ORIGIN } });
  expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(ok.headers.get('cache-control')).toBe('no-store');
});

// ---------------------------------------------------------------- configuration fails closed

test('configuration: no provider, no fake permission, a non-staging project, or bad keys -> refused before any call', async () => {
  const c = textCase();
  for (const [name, over, code] of [
    ['provider unset', { ANALYSIS_PROVIDER: undefined }, 'PROVIDER_NOT_CONFIGURED'],
    ['paid provider named without permission', { ANALYSIS_PROVIDER: 'anthropic' }, 'PAID_PROVIDER_NOT_ALLOWED'],
    ['another provider named', { ANALYSIS_PROVIDER: 'openai' }, 'PROVIDER_NOT_CONFIGURED'],
    ['paid provider allowed but no SDK client wired', { ANALYSIS_PROVIDER: 'anthropic', ALLOW_PAID_PROVIDER: 'staging-only',
      ANTHROPIC_API_KEY: 'sk-ant-TEST-ONLY-not-a-real-key-0000', ANALYST_MODEL: 'claude-opus-5-5', REVIEWER_MODEL: 'claude-sonnet-5-5' }, 'PROVIDER_NOT_CONFIGURED'],
    ['fake not allowed', { ALLOW_FAKE_PROVIDER: undefined }, 'FAKE_PROVIDER_NOT_ALLOWED'],
    ['fake flag wrong', { ALLOW_FAKE_PROVIDER: 'true' }, 'FAKE_PROVIDER_NOT_ALLOWED'],
    ['missing secret', { SUPABASE_SECRET_KEYS: undefined }, 'CONFIG_INVALID'],
    ['missing publishable', { SUPABASE_PUBLISHABLE_KEYS: '{}' }, 'CONFIG_INVALID'],
    ['same key twice', { SUPABASE_SECRET_KEYS: JSON.stringify({ default: PUBLISHABLE }) }, 'CONFIG_INVALID'],
    ['bad url', { SUPABASE_URL: 'not a url' }, 'CONFIG_INVALID'],
  ] as const) {
    fake.requests = [];
    const r = await call({ token: founder(), body: caseBody(c), env: over as Record<string, string | undefined> });
    expect([r.status, r.body.code], name).toEqual([503, code]);
    expect(fake.requests, name).toEqual([]);
  }
  expect(analysesOf(c)).toBe(0);
});

test('the fake provider is refused on any hosted project other than staging (it cannot write misleading records elsewhere)', () => {
  const e = (url: string, over: Record<string, string> = {}) => (k: string) => ({
    SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
    ANALYSIS_PROVIDER: 'fake', ALLOW_FAKE_PROVIDER: 'staging-only', ...over,
  } as Record<string, string>)[k];
  expect(readConfig(e(STAGING_URL))).toMatchObject({ ok: true });
  expect(readConfig(e('https://productionprojectref.supabase.co'))).toEqual({ ok: false, code: 'FAKE_PROVIDER_NOT_ALLOWED' });
  expect(readConfig(e('http://aqwdwswpmbnzmkvyuqil.supabase.co'))).toEqual({ ok: false, code: 'CONFIG_INVALID' });
  expect(readConfig(e('http://evil.example'))).toEqual({ ok: false, code: 'CONFIG_INVALID' });
  expect(readConfig(e(`${STAGING_URL}/rest/v1`))).toEqual({ ok: false, code: 'CONFIG_INVALID' });
  expect(readConfig(e(STAGING_URL, { ANALYZE_ALLOWED_ORIGINS: '*' }))).toEqual({ ok: false, code: 'CONFIG_INVALID' });
  expect(readConfig(e(STAGING_URL, { ANALYZE_DEADLINE_MS: '999999' }))).toMatchObject({ ok: true, config: { deadlineMs: 130000 } });
});

// ---------------------------------------------------------------- deleted screenshots and tampering

test('a screenshot deleted under retention before the run is excluded; only stored files are downloaded', async () => {
  const { c, paths } = await shotCase(2);
  sql(`update public.case_screenshots set file_deleted_at = now() where case_id = :'c' and position = 1`, { c });
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.body.outcome).toBe('COMPLETED');
  const downloads = fake.requests.filter((x) => x.path.startsWith('/storage/'));
  expect(downloads.map((x) => x.path)).toEqual([`/storage/v1/object/authenticated/case-screenshots/${paths[1]}`]);
  expect(downloads[0].cred).toBe(`user:${FOUNDER}`);
});

test('every screenshot deleted: the database refuses to start (409), nothing downloaded', async () => {
  const { c } = await shotCase(1);
  sql(`update public.case_screenshots set file_deleted_at = now() where case_id = :'c'`, { c });
  const r = await call({ token: founder(), body: caseBody(c) });
  expect([r.status, r.body.code]).toEqual([409, 'INSUFFICIENT_EVIDENCE']);
  expect(fake.requests.some((x) => x.path.startsWith('/storage/'))).toBe(false);
});

test('a stored file removed from storage after the snapshot: EVIDENCE_MISSING, recorded as ERROR, lock released', async () => {
  const { c, paths } = await shotCase(1);
  fake.storage.delete(paths[0]);
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.body).toMatchObject({ outcome: 'FAILED', code: 'EVIDENCE_MISSING' });
  expect(analysis(r.body.analysis_id)).toMatchObject({ status: 'ERROR', error: 'PIPELINE_ERROR: EVIDENCE_MISSING', output: null });
  expect(caseState(c)).toBe('SUBMITTED');
});

test('a screenshot deleted under retention DURING the run (after the snapshot) is not downloaded: EVIDENCE_MISSING', async () => {
  const { c } = await shotCase(1);
  fake.beforeHandle = (path) => {
    if (path === '/rest/v1/case_screenshots') { fake.beforeHandle = null; sql(`update public.case_screenshots set file_deleted_at = now() where case_id = :'c'`, { c }); }
  };
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.body).toMatchObject({ outcome: 'FAILED', code: 'EVIDENCE_MISSING' });
  expect(fake.requests.some((x) => x.path.startsWith('/storage/'))).toBe(false);
  expect(caseState(c)).toBe('SUBMITTED');
});

test('a file replaced in storage (same path, different bytes): EVIDENCE_HASH_MISMATCH', async () => {
  const { c, paths } = await shotCase(1);
  fake.storage.set(paths[0], new Uint8Array([9, 9, 9, 9]));
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.body).toMatchObject({ outcome: 'FAILED', code: 'EVIDENCE_HASH_MISMATCH' });
});

test("a screenshot row repointed to another case's file is never downloaded (path check)", async () => {
  const other = await shotCase(1);
  const { c } = await shotCase(1);
  // Simulate tampering after the snapshot (bypassing the staleness trigger, as a privileged actor could).
  const id = one(`select public.founder_start_analysis(:'c')`, { c }, { role: 'authenticated', sub: FOUNDER })!;
  sql(`select public.founder_abandon_analysis(:'a')`, { a: id }, { role: 'authenticated', sub: FOUNDER });
  // storage_path is unique, so a row cannot take another case's existing path; a crafted path in
  // another case's folder (with a real object there) is what the adapter's path check must refuse.
  const crafted = `${BIZ_A}/${other.c}/1-${'a'.repeat(64)}.png`;
  fake.storage.set(crafted, new Uint8Array([1]));
  sql(`begin; set local session_replication_role = replica;
       insert into storage.objects (bucket_id, name) values ('case-screenshots', :'p');
       update public.case_screenshots set storage_path = :'p' where case_id = :'c'; commit;`, { p: crafted, c });
  expect(() => sql(`update public.case_screenshots set storage_path = :'p' where case_id = :'c'`, { p: other.paths[0], c })).toThrow(/duplicate key/);
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.body).toMatchObject({ outcome: 'FAILED', code: 'EVIDENCE_MISSING' });
  expect(fake.requests.some((x) => x.path.includes(other.c))).toBe(false);
});

test('storage refuses a business user even for their own case file', async () => {
  const { paths } = await shotCase(1);
  const res = await fetch(`${fake.url}/storage/v1/object/authenticated/case-screenshots/${paths[0]}`,
    { headers: { apikey: PUBLISHABLE, authorization: `Bearer ${fake.tokenFor(CLIENT_A)}` } });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------- failure recovery

test('UNVERIFIED-CASE REHEARSAL: if a secret key does not carry the service_role claim, the run fails safe and the lock is released', async () => {
  fake.secretKeyClaims = null; // the gateway forwards no role claim: every internal_* function raises FORBIDDEN
  const c = textCase();
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ outcome: 'FAILED', code: 'SPEND_RESERVATION_FAILED_ABANDONED' });
  expect(spend(r.body.analysis_id)).toBe('NONE');
  expect(fake.requests.some((x) => x.path.endsWith('/internal_ai_dispatch'))).toBe(false);
  expect(analysis(r.body.analysis_id)).toMatchObject({ status: 'ERROR', error: 'Abandoned by founder', output: null });
  expect(caseState(c)).toBe('SUBMITTED');
  expect(logs.join('\n')).toContain('"event":"pipeline.record_failed"');
});

test('completion and abandonment both unreachable: LOCK_HELD (503) with the analysis id; founder_abandon_analysis recovers', async () => {
  fake.failRpc.add('internal_complete_analysis');
  fake.failRpc.add('founder_abandon_analysis');
  const c = textCase();
  const r = await call({ token: founder(), body: caseBody(c) });
  expect([r.status, r.body.outcome]).toEqual([503, 'LOCK_HELD']);
  expect(analysis(r.body.analysis_id).status).toBe('PENDING');
  expect(spend(r.body.analysis_id)).toBe('RESERVED:-:-'); // still committed while the lock is held
  expect((await call({ token: founder(), body: caseBody(c) })).body.code).toBe('INVALID_STATE');
  fake.failRpc.clear();
  const res = await fetch(`${fake.url}/rest/v1/rpc/founder_abandon_analysis`, { method: 'POST',
    headers: { apikey: PUBLISHABLE, authorization: `Bearer ${founder()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_analysis_id: r.body.analysis_id }) });
  expect(res.status).toBe(204);
  expect(caseState(c)).toBe('SUBMITTED');
  expect(spend(r.body.analysis_id)).toBe('SETTLED:REPORTED_USAGE:0.0000'); // manual abandon settles from the dispatch record
  expect((await call({ token: founder(), body: caseBody(c) })).body.outcome).toBe('COMPLETED');
});

test('a second request while an analysis is running is refused (409 INVALID_STATE)', async () => {
  const { c } = await shotCase(1);
  fake.storageDelayMs = 800;
  const first = call({ token: founder(), body: caseBody(c) });
  await expect.poll(() => fake.requests.some((x) => x.path.startsWith('/storage/'))).toBe(true);
  fake.storageDelayMs = 0;
  const second = await call({ token: founder(), body: caseBody(c) });
  expect([second.status, second.body.code]).toEqual([409, 'INVALID_STATE']);
  expect((await first).body.outcome).toBe('COMPLETED');
});

test('a restricted case is refused (409) before the analysis starts', async () => {
  const c = textCase();
  sql(`select public.founder_add_restriction(:'c', 'EXPLICIT_OPT_OUT', 'Synthetic opt-out.')`, { c }, { role: 'authenticated', sub: FOUNDER });
  const r = await call({ token: founder(), body: caseBody(c) });
  expect([r.status, r.body.code]).toEqual([409, 'CONTACT_RESTRICTED']);
  expect(analysesOf(c)).toBe(0);
});

test('an unexpected exception becomes a generic 500 with nothing leaked', async () => {
  const h = createAnalyzeCaseHandler({ env: () => { throw new Error(`boom ${SECRET}`); }, fetch, log: (l) => logs.push(l) });
  const res = await h(new Request('https://edge.local/x', { method: 'POST', body: '{}' }));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ outcome: 'ERROR', code: 'INTERNAL_ERROR', analysis_id: null });
  expect(logs.join('')).not.toContain(SECRET);
});

// ---------------------------------------------------------------- sanitised responses and logs

test('responses and logs never carry tokens, keys, evidence or analysis content', async () => {
  const c = textCase();
  const shots = await shotCase(1);
  fake.storage.set(shots.paths[0], new Uint8Array([7, 7]));
  const t = founder();
  const bodies = [
    (await call({ token: t, body: caseBody(c) })).text,
    (await call({ token: t, body: caseBody(shots.c) })).text,
    (await call({ token: fake.tokenFor(CLIENT_B), body: caseBody(c) })).text,
    (await call({ token: t, body: '{"case_id": "x"}' })).text,
  ];
  const all = bodies.join('\n') + '\n' + logs.join('\n');
  for (const secret of [t, SECRET, PUBLISHABLE, LEGACY_SERVICE, BODY1, BODY2, 'price feels high', FAKE_MARK, 'FAKE PROVIDER', 'Synthetic car', BIZ_A, CLIENT_B, FOUNDER]) {
    expect(all, secret.slice(0, 30)).not.toContain(secret);
  }
  for (const b of bodies) expect(Object.keys(JSON.parse(b))).toEqual(['outcome', 'code', 'analysis_id']);
  for (const line of logs) expect(Object.keys(JSON.parse(line)).every((k) => ['fn', 'event', 'code', 'analysisId', 'outcome', 'ms', 'role', 'ok',
    'inputTokens', 'outputTokens', 'stopReason', 'restrictionsKept', 'restrictionsNotRecorded', 'alreadyRecorded', 'dbCode', 'reservedUsd', 'usageKnown',
    'requestId', 'errorKind', 'httpStatus', 'check', 'inputBound', 'path'].includes(k)), line).toBe(true);
});

// ---------------------------------------------------------------- Stage 2A-5d-3b: spending controls

const providerCalls = () => logs.filter((l) => l.includes('"event":"provider.call"')).length;

test('spending disabled (the default): no provider call, the lock is released, nothing reserved', async () => {
  enableTestSpending(false);
  const c = textCase();
  const r = await call({ token: founder(), body: caseBody(c) });
  expect([r.status, r.body]).toEqual([200, { outcome: 'FAILED', code: 'SPENDING_DISABLED', analysis_id: expect.any(String) }]);
  expect(analysis(r.body.analysis_id)).toMatchObject({ status: 'ERROR', error: 'PIPELINE_ERROR: SPENDING_DISABLED', output: null });
  expect(caseState(c)).toBe('SUBMITTED');
  expect(spend(r.body.analysis_id)).toBe('NONE');
  expect(providerCalls()).toBe(0);
  expect(fake.requests.some((x) => x.path.endsWith('/internal_ai_dispatch'))).toBe(false);
});

test('budget exhausted, rate limit reached, or the model unpriced: refused before any provider call', async () => {
  const blocked: [string, string, string][] = [
    ['BUDGET_EXCEEDED', `insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model,
       analyst_input_bound, analyst_max_output, reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price,
       reviewer_out_price, reserved_usd, created_at) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', 'x',
       1, 1, 1, 1, 0, 0, 0, 0, 18.0001, now() - interval '2 days')`, ''],
    ['RATE_LIMITED', `insert into private.ai_spend_ledger (analysis_id, case_id, business_id, founder_id, analyst_model, reviewer_model,
       analyst_input_bound, analyst_max_output, reviewer_input_bound, reviewer_max_output, analyst_in_price, analyst_out_price, reviewer_in_price,
       reviewer_out_price, reserved_usd, status, actual_usd, settled_by) select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '${FOUNDER}', 'x', 'x',
       1, 1, 1, 1, 0, 0, 0, 0, 0, 'SETTLED', 0, 'NO_DISPATCH' from generate_series(1, 10)`, ''],
    ['MODEL_NOT_PRICED', `update private.ai_model_prices set active = false where model = 'FAKE-PROVIDER-NOT-AI'`,
      `update private.ai_model_prices set active = true where model = 'FAKE-PROVIDER-NOT-AI'`],
  ];
  for (const [code, setup, undo] of blocked) {
    const c = textCase();
    sql(setup);
    logs = []; fake.requests = [];
    const r = await call({ token: founder(), body: caseBody(c) });
    if (undo) sql(undo);
    makeRoomForCase();
    enableTestSpending();
    expect(r.body, code).toMatchObject({ outcome: 'FAILED', code });
    expect(caseState(c), code).toBe('SUBMITTED');
    expect(spend(r.body.analysis_id), code).toBe('NONE');
    expect(providerCalls(), code).toBe(0);
  }
});

test('the dispatch record cannot be written: nothing is sent; the reservation settles at 0 (no dispatch recorded)', async () => {
  fake.failRpc.add('internal_ai_dispatch');
  const c = textCase();
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.body).toMatchObject({ outcome: 'FAILED', code: 'DISPATCH_FAILED_ANALYST' });
  expect(providerCalls()).toBe(0);
  expect(spend(r.body.analysis_id)).toBe('SETTLED:NO_DISPATCH:0.0000');
  expect(caseState(c)).toBe('SUBMITTED');
});

test('usage cannot be reported after a dispatched call: the lock is released, the reservation is HELD (not released)', async () => {
  fake.failRpc.add('internal_ai_report_usage');
  const c = textCase();
  const r = await call({ token: founder(), body: caseBody(c) });
  expect(r.body).toMatchObject({ outcome: 'FAILED', code: 'USAGE_REPORT_FAILED_ANALYST' });
  expect(providerCalls()).toBe(1);
  expect(spend(r.body.analysis_id)).toBe('HELD:UNKNOWN_USAGE:0.0000');
  expect(analysis(r.body.analysis_id).status).toBe('ERROR');
  expect(caseState(c)).toBe('SUBMITTED');
});

test('the spending functions are not reachable with a user session (founder, business or anonymous)', async () => {
  const c = textCase();
  const a = (await call({ token: founder(), body: caseBody(c) })).body.analysis_id;
  for (const [who, headers] of [
    ['founder', { apikey: PUBLISHABLE, authorization: `Bearer ${founder()}` }],
    ['business', { apikey: PUBLISHABLE, authorization: `Bearer ${fake.tokenFor(CLIENT_A)}` }],
    ['anonymous', { apikey: PUBLISHABLE }],
  ] as [string, Record<string, string>][]) {
    for (const [fn, body] of [['internal_reserve_ai_spend', { p_analysis_id: a, p_analyst_model: 'FAKE-PROVIDER-NOT-AI', p_reviewer_model: 'FAKE-PROVIDER-NOT-AI' }],
      ['internal_ai_dispatch', { p_analysis_id: a, p_role: 'ANALYST' }], ['internal_ai_report_usage', { p_analysis_id: a, p_role: 'ANALYST', p_input_tokens: 0, p_output_tokens: 0 }]] as const) {
      const res = await fetch(`${fake.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status, `${who} ${fn}`).toBe(403);
    }
  }
  expect(spend(a)).toBe('SETTLED:REPORTED_USAGE:0.0000');
});

test('sanitize(): anything outside the allowlist is replaced', () => {
  expect(sanitize('COMPLETED', 'OK', '0f0f0f0f-0000-4000-8000-000000000000')).toEqual({ outcome: 'COMPLETED', code: 'OK', analysis_id: '0f0f0f0f-0000-4000-8000-000000000000' });
  expect(sanitize('<script>', 'ERROR: relation "x" does not exist', "1' or 1=1")).toEqual({ outcome: 'ERROR', code: 'INTERNAL_ERROR', analysis_id: null });
  expect(sanitize('FAILED', `PROVIDER ${SECRET}`, null).code).toBe('INTERNAL_ERROR');
});

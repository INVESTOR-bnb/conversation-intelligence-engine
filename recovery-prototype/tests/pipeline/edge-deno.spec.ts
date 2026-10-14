// Stage 2A-5d-4b — the same handler under the real Deno runtime (pinned Deno 2.1.4,
// fetched on demand by npx; not a project dependency), against the local fake of
// Supabase's HTTP API and the real local database. Fake provider only.

import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { BODY1 } from './fakes';
import { FakeSupabase, PUBLISHABLE, SECRET } from './fakeSupabase';
import { CLIENT_A, enableTestSpending, FOUNDER, makeRoomForCase, one, spend, sql } from './psqlDb';

export const DENO = ['--yes', 'deno@2.1.4'];
const fake = new FakeSupabase();
let deno: ChildProcess;
let base = '';
let output = '';

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
}

test.beforeAll(async () => {
  test.setTimeout(180000);
  sql('select tests.seed() where not exists (select 1 from public.founders)');
  await fake.start();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  deno = spawn('npx', [...DENO, 'run', `--allow-net=127.0.0.1`, '--allow-env=TEST_PORT,SUPABASE_URL,SUPABASE_PUBLISHABLE_KEYS,SUPABASE_SECRET_KEYS,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,ANALYSIS_PROVIDER,ALLOW_FAKE_PROVIDER,ANALYZE_ALLOWED_ORIGINS,ANALYZE_DEADLINE_MS',
    'tests/pipeline/deno/serve.ts'], {
    env: { ...process.env, TEST_PORT: String(port), SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }), ANALYSIS_PROVIDER: 'fake', ALLOW_FAKE_PROVIDER: 'staging-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  deno.stdout!.on('data', (d) => { output += d; });
  deno.stderr!.on('data', (d) => { output += d; });
  await expect.poll(() => output, { timeout: 170000 }).toContain('listening');
});
test.afterAll(async () => { deno?.kill(); await fake.stop(); });

const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('under Deno: a founder run completes; unauthenticated, non-founder and malformed requests are refused; logs carry no secrets', async () => {
  makeRoomForCase();
  enableTestSpending();
  const c = one(`select public.client_create_case(gen_random_uuid(), 'DENO-1', 'Synthetic car', 'Referral', 'TEXT', :'body')`, { body: BODY1 }, { role: 'authenticated', sub: CLIENT_A })!;
  sql(`select public.client_submit_case(:'c')`, { c }, { role: 'authenticated', sub: CLIENT_A });
  const founderToken = fake.tokenFor(FOUNDER);

  expect(await post(JSON.stringify({ case_id: c }))).toEqual({ status: 401, body: { outcome: 'NOT_STARTED', code: 'UNAUTHENTICATED', analysis_id: null } });
  expect((await post(JSON.stringify({ case_id: c }), { authorization: `Bearer ${fake.tokenFor(CLIENT_A)}` })).status).toBe(403);
  expect((await post('{"case_id": 1}', { authorization: `Bearer ${founderToken}` })).body.code).toBe('INVALID_REQUEST');
  expect((await post('x'.repeat(5000), { authorization: `Bearer ${founderToken}` })).status).toBe(413);
  const ok = await post(JSON.stringify({ case_id: c }), { authorization: `Bearer ${founderToken}` });
  expect(ok).toMatchObject({ status: 200, body: { outcome: 'COMPLETED', code: 'OK' } });
  expect(one(`select model from public.analyses where id = :'a'`, { a: ok.body.analysis_id })).toBe('analyst:FAKE-PROVIDER-NOT-AI|reviewer:FAKE-PROVIDER-NOT-AI');
  expect(fake.requests.filter((x) => x.cred.startsWith('service')).map((x) => x.path)).toEqual(['/rest/v1/rpc/internal_reserve_ai_spend', '/rest/v1/rpc/internal_ai_reservation_terms', '/rest/v1/rpc/internal_ai_dispatch', '/rest/v1/rpc/internal_ai_report_usage', '/rest/v1/rpc/internal_ai_dispatch', '/rest/v1/rpc/internal_ai_report_usage', '/rest/v1/rpc/internal_complete_analysis']);
  expect(spend(ok.body.analysis_id)).toBe('SETTLED:REPORTED_USAGE:0.0000');
  for (const s of [founderToken, SECRET, PUBLISHABLE, BODY1]) expect(output).not.toContain(s);
  expect(output).toContain('"event":"request.done"');
});

test('Stage 2A-6b, under Deno: the pinned npm: SDK through the adapter against a local mock API — one request per call, explicit key, no beta, no env access', async () => {
  test.setTimeout(240000);
  const { execFileSync } = await import('node:child_process');
  // --allow-env with no variable allowed: the SDK must not need (or be steered by) any environment variable.
  const out = execFileSync('npx', [...DENO, 'run', '--allow-net=127.0.0.1', '--allow-env=RRE_NONE', 'tests/pipeline/deno/anthropic-sdk.ts'],
    { encoding: 'utf8', timeout: 230000 });
  const r = JSON.parse(out.trim().split('\n').pop()!);
  expect(r.counted).toBe(77);
  expect(r.ok).toEqual({ text: '{"a":"ok"}', stopReason: 'end_turn', inputTokens: 70, outputTokens: 9, requestId: 'req_deno01' });
  expect(r.failed).toEqual({ name: 'ProviderCallError', kind: 'HTTP', httpStatus: 529 });
  expect(r.seen.map((s: { path: string }) => s.path)).toEqual(['/v1/messages/count_tokens', '/v1/messages', '/v1/messages']); // the 529 was not retried
  for (const s of r.seen) expect(s).toMatchObject({ key: 'sk-ant-TEST-ONLY-not-a-real-key-0000', auth: null, beta: null, retry: '0', model: 'claude-sonnet-5-5' });
});

// WhatsApp feasibility test harness (supabase/functions/_shared/whatsapp/waTest.ts), with a fake
// Supabase (founder check + the service functions) and a fake Graph API. SIMULATED: nothing here
// reaches Meta or Supabase. The database rules themselves are tested in supabase/whatsapp-test/wa_test.test.sql.
import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { createWaTestHandler, extractEvents, readWaConfig, TEST_MESSAGE, validSignature, type WaEvent } from '../../supabase/functions/_shared/whatsapp/waTest.ts';

const URL_ = 'https://aqwdwswpmbnzmkvyuqil.supabase.co';
const APP_SECRET = 'TESTONLYappsecret0123456789abcdef';
const VERIFY = 'TESTONLY-verify-token-0123456789';
const ACCESS = 'TESTONLYaccesstoken0123456789ABCDEFGH';
const RECIPIENT = '2348000000001'; // the consenting test contact (synthetic)
const STRANGER = '2348000000999';
const PNID = '100000000000001';
const PNID_B = '100000000000002';
const FOUNDER_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmb3VuZGVyIn0.c2lnbmF0dXJlLWZvdW5kZXI';
const CLIENT_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbGllbnQifQ.c2lnbmF0dXJlLWNsaWVudA';
const FOUNDER_ID = '00000000-0000-4000-8000-00000000000f';
const CLIENT_ID = '00000000-0000-4000-8000-00000000000a';
const BIZ_A = '10000000-0000-4000-8000-00000000000a';
const BIZ_B = '10000000-0000-4000-8000-00000000000b';

const ENV: Record<string, string> = {
  SUPABASE_URL: URL_, SUPABASE_ANON_KEY: `eyJ${'a'.repeat(30)}`, SUPABASE_SERVICE_ROLE_KEY: `eyJ${'s'.repeat(30)}`,
  WA_APP_ID: '123456789012345', WA_APP_SECRET: APP_SECRET, WA_VERIFY_TOKEN: VERIFY, WA_TEST_RECIPIENT: RECIPIENT,
  WA_TEST_SENDING: 'enabled', WA_ACCESS_TOKEN: ACCESS, WA_TEST_TEMPLATE: 'rre_connection_test', WA_TEST_TEMPLATE_LANG: 'en',
};

/** A fake of Supabase (auth, whoami, the service RPCs with the SQL's semantics) and of the Graph API. */
function world(envOver: Record<string, string | undefined> = {}) {
  const numbers = new Map<string, string>([[PNID, BIZ_A], [PNID_B, BIZ_B]]);
  const events = new Map<string, WaEvent & { business_id: string }>();
  const outbound = new Map<string, { status: string; pnid: string }>();
  const graphCalls: { url: string; auth: string | null; body: unknown }[] = [];
  const logs: string[] = [];
  let lastInbound: string | null = null;
  const graphReply = { messages: [{ id: 'wamid.TEST1' }] };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const res = (status: number, b: unknown) => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    if (url.startsWith('https://graph.facebook.com/')) {
      graphCalls.push({ url, auth, body });
      if (url.includes('/oauth/access_token')) return res(200, { access_token: 'TESTONLYbusinesstoken0123456789' });
      if (url.endsWith('/messages')) return res(200, graphReply);
      return res(200, { success: true });
    }
    const jwt = auth?.replace('Bearer ', '');
    if (url === `${URL_}/auth/v1/user`) return jwt === FOUNDER_JWT ? res(200, { id: FOUNDER_ID }) : jwt === CLIENT_JWT ? res(200, { id: CLIENT_ID }) : res(401, {});
    const fn = url.replace(`${URL_}/rest/v1/rpc/`, '');
    if (fn === 'whoami') return res(200, jwt === FOUNDER_JWT ? { role: 'FOUNDER', user_id: FOUNDER_ID } : { role: 'CLIENT', user_id: CLIENT_ID });
    if (fn === 'founder_wa_test_summary') return jwt === FOUNDER_JWT ? res(200, { events: events.size }) : res(403, {});
    if (auth !== `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`) return res(403, {});
    if (fn === 'internal_wa_record_events') {
      let n = 0;
      for (const e of (body as { p_events: WaEvent[] }).p_events) {
        const biz = numbers.get(e.phone_number_id);
        if (!biz || events.has(e.dedupe_key)) continue;
        events.set(e.dedupe_key, { ...e, business_id: biz });
        n++;
      }
      return res(200, n);
    }
    if (fn === 'internal_wa_last_inbound_at') return res(200, lastInbound);
    if (fn === 'internal_wa_reserve_send') {
      const b = body as { p_key: string; p_phone_number_id: string };
      if (outbound.has(b.p_key)) return res(200, 'DUPLICATE');
      if (!numbers.has(b.p_phone_number_id)) return res(200, 'UNKNOWN_NUMBER');
      if ([...outbound.values()].filter((o) => o.pnid === b.p_phone_number_id).length >= 3) return res(200, 'CAP_REACHED');
      outbound.set(b.p_key, { status: 'PENDING', pnid: b.p_phone_number_id });
      return res(200, 'NEW');
    }
    if (fn === 'internal_wa_finish_send') { const b = body as { p_key: string; p_status: string }; outbound.get(b.p_key)!.status = b.p_status; return res(204, null); }
    if (fn === 'internal_wa_register_number') { numbers.set((body as { p_phone_number_id: string }).p_phone_number_id, (body as { p_business_id: string }).p_business_id); return res(204, null); }
    return res(404, {});
  };
  const env = { ...ENV, ...envOver };
  const handler = createWaTestHandler({ env: (k) => env[k], fetch: fakeFetch, log: (l) => logs.push(l), now: () => Date.parse('2026-11-04T12:00:00Z') });
  return { handler, events, outbound, graphCalls, logs, numbers, setLastInbound: (v: string | null) => { lastInbound = v; } };
}

const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const hook = (raw: string, sig: string | null) => new Request(`${URL_}/functions/v1/whatsapp-test/webhook`, { method: 'POST',
  headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body: raw });
const founderPost = (route: string, body: unknown, jwt = FOUNDER_JWT) => new Request(`${URL_}/functions/v1/whatsapp-test/${route}`, { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify(body) });

const inbound = (pnid: string, from: string, id: string, text: string, replyTo?: string) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '200000000000001', changes: [{ field: 'messages',
  value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid }, messages: [{ from, id, timestamp: '1793793600', type: 'text', text: { body: text },
    ...(replyTo ? { context: { id: replyTo } } : {}) }] } }] }] });

// ---------------------------------------------------------------- configuration

test('configuration fails closed: every route refuses when any required setting is missing or malformed', async () => {
  expect(readWaConfig((k) => ENV[k])).not.toBeNull();
  for (const [k, v] of [['WA_APP_SECRET', 'short'], ['WA_VERIFY_TOKEN', 'short'], ['WA_TEST_RECIPIENT', '+234 800'], ['WA_APP_ID', 'abc'],
    ['SUPABASE_URL', 'http://evil.example'], ['WA_TEST_TEMPLATE', 'Bad Name']] as [string, string][]) {
    expect(readWaConfig((x) => (x === k ? v : ENV[x])), k).toBeNull();
    const w = world({ [k]: v });
    const r = await w.handler(hook('{}', sign('{}')));
    expect([r.status, (await r.json()).code], k).toEqual([503, 'CONFIG_INVALID']);
  }
});

// ---------------------------------------------------------------- webhook verification and signatures

test('webhook handshake: only the right verify token returns the challenge', async () => {
  const w = world();
  const get = (q: string) => w.handler(new Request(`${URL_}/functions/v1/whatsapp-test/webhook?${q}`));
  const ok = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
  expect([ok.status, await ok.text()]).toEqual([200, '1158201444']);
  for (const q of [`hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`, `hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
    `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=<script>`, 'hub.mode=subscribe']) expect((await get(q)).status, q).toBe(403);
});

test('webhook signature: missing, malformed, wrong-secret or tampered payloads are rejected (401) and nothing is stored', async () => {
  const w = world();
  const raw = inbound(PNID, RECIPIENT, 'wamid.IN1', 'TEST-OK');
  for (const sig of [null, 'sha256=abc', `sha1=${'0'.repeat(40)}`, sign(raw, 'another-secret-0123456789'), sign(raw.replace('TEST-OK', 'TEST-NO'))]) {
    const r = await w.handler(hook(raw, sig));
    expect(r.status, String(sig)).toBe(401);
  }
  expect(w.events.size).toBe(0);
  expect(w.logs.filter((l) => l.includes('webhook.bad_signature'))).toHaveLength(5);
  const good = await w.handler(hook(raw, sign(raw)));
  expect(good.status).toBe(200);
  expect(w.events.size).toBe(1);
});

test('duplicate webhook deliveries (Meta retries) are stored once', async () => {
  const w = world();
  const raw = inbound(PNID, RECIPIENT, 'wamid.IN2', 'TEST-OK');
  for (let i = 0; i < 3; i++) expect((await w.handler(hook(raw, sign(raw)))).status).toBe(200);
  expect(w.events.size).toBe(1);
  expect(w.logs.at(-1)).toContain('"stored":0');
});

// ---------------------------------------------------------------- content policy and isolation

test('only the test contact\'s text is kept; other customers are a keyed hash with no content; history is counts only', async () => {
  const history = { object: 'whatsapp_business_account', entry: [{ id: '2', changes: [{ field: 'history', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    history: [{ metadata: { phase: 0, chunk_order: 1, progress: 55 }, threads: [
      { id: STRANGER, messages: [{ from: STRANGER, id: 'h1', timestamp: '1780000000', type: 'text', text: { body: 'my private address is 12 Example Street' } },
        { from: PNID, id: 'h2', timestamp: '1781000000', type: 'image', image: { id: 'media1' } }] },
      { id: RECIPIENT, messages: [{ from: RECIPIENT, id: 'h3', timestamp: '1782000000', type: 'text', text: { body: 'hello' } }] }] }] } }] }] };
  const events = [
    ...(await extractEvents(JSON.parse(inbound(PNID, STRANGER, 'wamid.S1', 'a real customer message')), APP_SECRET, RECIPIENT)),
    ...(await extractEvents(JSON.parse(inbound(PNID, RECIPIENT, 'wamid.T1', 'TEST-OK')), APP_SECRET, RECIPIENT)),
    ...(await extractEvents(history, APP_SECRET, RECIPIENT)),
  ];
  const all = JSON.stringify(events);
  expect(all).not.toContain('a real customer message');
  expect(all).not.toContain('Example Street');
  expect(all).not.toContain(STRANGER);
  expect(all).not.toContain(RECIPIENT);
  expect(events[0]).toMatchObject({ kind: 'INBOUND', is_test_contact: false, body: null });
  expect(events[0].contact_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(events[1]).toMatchObject({ kind: 'INBOUND', is_test_contact: true, body: 'TEST-OK' });
  expect(events[2]).toMatchObject({ kind: 'HISTORY', body: null, summary: { phase: 0, chunk_order: 1, progress: 55, threads: 2, messages: 3,
    types: { text: 2, image: 1 }, oldest: '2026-05-28T20:26:40.000Z', newest: '2026-06-21T00:00:00.000Z' } });
  // a declined history share is recorded as such
  const declined = await extractEvents({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'history', value: { metadata: { phone_number_id: PNID },
    history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business' }] }] } }] }] }, APP_SECRET, RECIPIENT);
  expect(declined).toMatchObject([{ kind: 'HISTORY_DECLINED', summary: { error_code: 2593109 } }]);
});

test('business isolation: the business comes from the server-side number mapping; an unknown number is never stored', async () => {
  const w = world();
  for (const [pnid, id] of [[PNID, 'wamid.A'], [PNID_B, 'wamid.B'], ['999999999999999', 'wamid.X']] as const) {
    const raw = inbound(pnid, RECIPIENT, id, 'TEST-OK');
    expect((await w.handler(hook(raw, sign(raw)))).status).toBe(200);
  }
  expect([...w.events.values()].map((e) => [e.wa_message_id, e.business_id])).toEqual([['wamid.A', BIZ_A], ['wamid.B', BIZ_B]]);
  // a payload cannot name a business: there is no such field in the stored event
  expect(JSON.stringify([...w.events.values()].map(({ business_id: _b, ...e }) => e))).not.toMatch(/business/);
});

// ---------------------------------------------------------------- sending

test('sending: switch off, non-founder, recipient in the request, closed window, or bad mode all refuse with no Graph call', async () => {
  const send = (w: ReturnType<typeof world>, body: Record<string, unknown>, jwt?: string) => w.handler(founderPost('send', body, jwt));
  const key = '30000000-0000-4000-8000-000000000001';
  let w = world({ WA_TEST_SENDING: undefined });
  expect((await (await send(w, { idempotency_key: key, phone_number_id: PNID, mode: 'TEMPLATE' })).json()).code).toBe('SENDING_DISABLED');
  w = world();
  expect((await send(w, { idempotency_key: key, phone_number_id: PNID, mode: 'TEMPLATE' }, CLIENT_JWT)).status).toBe(403);
  expect((await send(w, { idempotency_key: key, phone_number_id: PNID, mode: 'TEMPLATE', to: STRANGER })).status).toBe(400);
  expect((await send(w, { idempotency_key: key, phone_number_id: PNID, mode: 'TEMPLATE', text: 'buy now' })).status).toBe(400);
  expect((await send(w, { idempotency_key: key, phone_number_id: PNID, mode: 'MARKETING' })).status).toBe(400);
  w.setLastInbound(null);
  expect((await (await send(w, { idempotency_key: key, phone_number_id: PNID, mode: 'TEXT' })).json()).code).toBe('WINDOW_CLOSED');
  w.setLastInbound('2026-11-03T10:00:00Z'); // 26 h before "now"
  expect((await (await send(w, { idempotency_key: key, phone_number_id: PNID, mode: 'TEXT' })).json()).code).toBe('WINDOW_CLOSED');
  expect(w.graphCalls).toEqual([]);
});

test('sending: one fixed labelled message to the configured test recipient only; a repeated key never sends twice; at most 3 per number', async () => {
  const w = world();
  w.setLastInbound('2026-11-04T11:00:00Z');
  const key = '30000000-0000-4000-8000-000000000002';
  const r = await w.handler(founderPost('send', { idempotency_key: key, phone_number_id: PNID, mode: 'TEXT' }));
  expect([r.status, await r.json()]).toEqual([200, { code: 'ACCEPTED', wa_message_id: 'wamid.TEST1' }]);
  expect(w.graphCalls).toEqual([{ url: `https://graph.facebook.com/v25.0/${PNID}/messages`, auth: `Bearer ${ACCESS}`,
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: RECIPIENT, type: 'text', text: { body: TEST_MESSAGE, preview_url: false } } }]);
  expect(TEST_MESSAGE).toMatch(/^RRE TEST: /);
  // the same key again (double tap, retry): no second message
  const again = await w.handler(founderPost('send', { idempotency_key: key, phone_number_id: PNID, mode: 'TEXT' }));
  expect([again.status, (await again.json()).code]).toEqual([200, 'DUPLICATE']);
  expect(w.graphCalls).toHaveLength(1);
  // template mode uses the configured approved template, still only to the test recipient
  await w.handler(founderPost('send', { idempotency_key: '30000000-0000-4000-8000-000000000003', phone_number_id: PNID, mode: 'TEMPLATE' }));
  expect(w.graphCalls[1].body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: RECIPIENT, type: 'template',
    template: { name: 'rre_connection_test', language: { code: 'en' } } });
  await w.handler(founderPost('send', { idempotency_key: '30000000-0000-4000-8000-000000000004', phone_number_id: PNID, mode: 'TEMPLATE' }));
  const capped = await w.handler(founderPost('send', { idempotency_key: '30000000-0000-4000-8000-000000000005', phone_number_id: PNID, mode: 'TEMPLATE' }));
  expect([capped.status, (await capped.json()).code]).toEqual([409, 'CAP_REACHED']);
  expect(w.graphCalls).toHaveLength(3);
  expect(w.graphCalls.every((c) => (c.body as { to: string }).to === RECIPIENT)).toBe(true);
});

test('reply handling: the test contact\'s reply to the sent message is stored against the right business and linked to the send', async () => {
  const w = world();
  const raw = inbound(PNID_B, RECIPIENT, 'wamid.REPLY', 'TEST-OK', 'wamid.TEST1');
  expect((await w.handler(hook(raw, sign(raw)))).status).toBe(200);
  expect(w.events.get('in:wamid.REPLY')).toMatchObject({ business_id: BIZ_B, is_test_contact: true, body: 'TEST-OK', reply_to: 'wamid.TEST1', kind: 'INBOUND' });
});

// ---------------------------------------------------------------- onboarding

test('onboarding (founder only): exchange, map, subscribe, contact and history sync; the token is never returned or logged', async () => {
  const w = world();
  const body = { code: 'TESTONLYcode123', phone_number_id: '100000000000003', waba_id: '200000000000003', business_id: BIZ_A };
  expect((await w.handler(founderPost('onboard', body, CLIENT_JWT))).status).toBe(403);
  expect(w.graphCalls).toEqual([]);
  const r = await w.handler(founderPost('onboard', body));
  const out = await r.json();
  expect(out).toEqual({ code: 'OK', steps: { exchange: 'OK', register: 'OK', subscribe: 'OK', contacts_sync: 'OK', history_sync: 'OK' } });
  expect(w.numbers.get('100000000000003')).toBe(BIZ_A);
  expect(w.graphCalls.map((c) => [c.url.split('?')[0], c.body])).toEqual([
    ['https://graph.facebook.com/v25.0/oauth/access_token', null],
    ['https://graph.facebook.com/v25.0/200000000000003/subscribed_apps', null],
    ['https://graph.facebook.com/v25.0/100000000000003/smb_app_data', { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' }],
    ['https://graph.facebook.com/v25.0/100000000000003/smb_app_data', { messaging_product: 'whatsapp', sync_type: 'history' }],
  ]);
  expect(w.graphCalls.slice(1).every((c) => c.auth === 'Bearer TESTONLYbusinesstoken0123456789')).toBe(true);
  const visible = JSON.stringify(out) + w.logs.join('\n');
  for (const s of ['TESTONLYbusinesstoken0123456789', APP_SECRET, ACCESS, VERIFY, 'TESTONLYcode123']) expect(visible).not.toContain(s);
});

test('no secret reaches a response or a log line in any route', async () => {
  const w = world();
  w.setLastInbound('2026-11-04T11:00:00Z');
  const outs: string[] = [];
  const raw = inbound(PNID, RECIPIENT, 'wamid.Z', 'TEST-OK');
  for (const req of [hook(raw, sign(raw)), hook(raw, 'sha256=bad'), founderPost('send', { idempotency_key: '30000000-0000-4000-8000-000000000009', phone_number_id: PNID, mode: 'TEXT' }),
    new Request(`${URL_}/functions/v1/whatsapp-test/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)]) {
    outs.push(await (await w.handler(req)).text());
  }
  const all = outs.join('\n') + w.logs.join('\n');
  for (const s of [APP_SECRET, ACCESS, VERIFY, ENV.SUPABASE_SERVICE_ROLE_KEY, FOUNDER_JWT]) expect(all).not.toContain(s);
  expect(await validSignature(APP_SECRET, new TextEncoder().encode('x'), null)).toBe(false);
});

// ---------------------------------------------------------------- the private connect page (static checks)

test('connect page: no secret, only Meta\'s official SDK, Facebook-origin messages only, confirmation before the one send', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../../supabase/whatsapp-test/connect.html', import.meta.url), 'utf8');
  expect(page).not.toMatch(/sb_secret_|service_role|WA_APP_SECRET|WA_ACCESS_TOKEN|sk-[A-Za-z0-9]{20,}|EAA[A-Za-z0-9]{20,}/);
  const scripts = [...page.matchAll(/s\.src = '([^']+)'/g)].map((m) => m[1]);
  expect(scripts).toEqual(['https://connect.facebook.net/en_US/sdk.js']);
  expect(page).not.toMatch(/<script[^>]+src=/);
  expect(page).toContain("event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com'");
  expect(page).toContain("featureType: 'whatsapp_business_app_onboarding'");
  expect(page).toContain("window.confirm('Send ONE fixed test message to the test contact only?')");
  expect([...page.matchAll(/call\('([a-z]+)'/g)].map((m) => m[1]).sort()).toEqual(['onboard', 'send', 'summary']);
  const script = page.slice(page.indexOf('<script>'));
  expect(script).not.toMatch(/\bto:|recipient/); // the page's code cannot name a recipient
  expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
});

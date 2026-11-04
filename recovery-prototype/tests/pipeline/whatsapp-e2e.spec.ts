// RRE WhatsApp integration — the `whatsapp` Edge Function handler end to end, SIMULATED: the REAL
// local database (with supabase/whatsapp/wa_integration.sql installed) behind the local Supabase
// emulator (callers' roles, RLS and grants apply), and a fake Graph API. Nothing reaches Meta.
// The analysis step uses the existing founder functions with a synthetic contract-valid output
// (the AI pipeline itself is tested elsewhere). Synthetic data only.

import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createWaHandler, decryptToken, normalizeWebhook } from '../../supabase/functions/_shared/whatsapp/waIntegration.ts';
import { FakeSupabase, PUBLISHABLE, registerRpc, SECRET } from './fakeSupabase';
import { BIZ_A, CLIENT_A, CLIENT_B, FOUNDER, one, sql } from './psqlDb';

const BUNDLE = readFileSync(new URL('../../supabase/whatsapp/wa_integration.sql', import.meta.url), 'utf8');
const BIZ_B = '10000000-0000-4000-8000-00000000000b';
const APP_SECRET = 'TESTONLYappsecret0123456789abcdef';
const VERIFY = 'TESTONLY-verify-token-0123456789';
const WORKER = 'TESTONLY-worker-secret-0123456789abcdef';
const TOKEN_KEY = Buffer.alloc(32, 7);
const BUSINESS_TOKEN = 'TESTONLYbusinessIntegrationToken0123456789';
const PNID = '100000000000001';
const WABA = '200000000000001';
const PROSPECT = '2348000000011';
const OWNER_NUMBER = '2348000000001';
const TEMPLATE_TEXT = 'Hello from Synthetic Autos A. Are you still interested in what you asked us about? Reply STOP to opt out.';

const fake = new FakeSupabase();
const graphCalls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
let sendMode: 'accept' | 'timeout' | 'reject' | 'token' = 'accept';
let wamidN = 0;
/** Runs while Meta is still answering the history request (a webhook that arrives before the request returns). */
let duringHistoryRequest: (() => Promise<void>) | null = null;
const graph: Server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', async () => {
    const u = new URL(req.url ?? '/', 'http://g');
    graphCalls.push({ method: req.method ?? '', path: u.pathname, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization ?? null });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname.endsWith('/oauth/access_token')) return send(200, { access_token: BUSINESS_TOKEN });
    if (u.pathname === `/v25.0/${PNID}`) return send(200, { display_phone_number: '+234 800 000 0001' });
    if (u.pathname.endsWith('/smb_app_data') && raw.includes('"history"') && duringHistoryRequest) { await duringHistoryRequest(); duringHistoryRequest = null; }
    if (u.pathname.endsWith('/messages')) {
      if (sendMode === 'timeout') return send(504, { message: 'gateway timeout' });
      if (sendMode === 'reject') return send(400, { error: { code: 131026, message: 'undeliverable' } });
      if (sendMode === 'token') return send(401, { error: { code: 190, message: 'token expired' } });
      return send(200, { messages: [{ id: `wamid.OUT${++wamidN}` }] });
    }
    return send(200, { success: true });
  });
});
let GRAPH_URL = '';
const logs: string[] = [];
const ENV = () => ({
  SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
  WA_APP_ID: '123456789012345', WA_APP_SECRET: APP_SECRET, WA_VERIFY_TOKEN: VERIFY, WA_WORKER_SECRET: WORKER, WA_TOKEN_KEY: TOKEN_KEY.toString('base64'),
} as Record<string, string>);
const handler = (over: Record<string, string> = {}) => createWaHandler({
  env: (k) => ({ ...ENV(), ...over })[k],
  fetch: (i, init) => { const u = new URL(String(i)); return u.host === 'graph.facebook.com' ? fetch(new URL(u.pathname + u.search, GRAPH_URL), init) : fetch(i, init); },
  log: (l) => logs.push(l),
});

const FN = 'http://fn.local/functions/v1/whatsapp';
const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  handler()(new Request(`${FN}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
const member = (user: string) => ({ authorization: `Bearer ${fake.tokenFor(user)}`, apikey: PUBLISHABLE });
const sign = (raw: string) => `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const webhook = (payload: unknown, signed = true) => {
  const raw = JSON.stringify(payload);
  return handler()(new Request(`${FN}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signed ? { 'x-hub-signature-256': sign(raw) } : {}) }, body: raw }));
};
const worker = (secret = WORKER) => handler()(new Request(`${FN}/worker`, { method: 'POST', headers: { 'x-rre-worker': secret } }));
const asClient = (u: string) => ({ role: 'authenticated' as const, sub: u });
const now = () => Math.floor(Date.now() / 1000);
const value = (field: string, v: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, ...v } }] }] });
const caseId = () => one(`select case_id from private.wa_contacts where wa_id = :'w'`, { w: PROSPECT })!;
/** Founder analysis (synthetic contract-valid result) and approval, through the existing founder functions. */
function analyseAndApprove(c: string, message: string) {
  const a = one(`select public.founder_start_analysis(:'c')`, { c }, asClient(FOUNDER))!;
  sql(`select public.internal_complete_analysis(:'a', 'COMPLETE', 'synthetic-model', 'test', tests.contract_output(:'a', 'GREEN', 'AI text'), 'GREEN', 'AI text', '[]')`,
    { a }, { role: 'service_role' });
  sql(`select public.founder_approve(:'c', :'a', (select evidence_version from public.cases where id = :'c'), 'GREEN', 's', 'n', :'m', 'EDITED')`, { c, a, m: message }, asClient(FOUNDER));
}

test.beforeAll(async () => {
  sql('select tests.seed() where not exists (select 1 from public.founders)');
  if (one(`select to_regclass('private.wa_settings') is null`) === 't') sql(BUNDLE);
  for (const [n, t] of [['internal_wa_ingest', 'jsonb'], ['internal_wa_record_connection', 'void'], ['internal_wa_set_connection_status', 'void'],
    ['internal_wa_connection', 'jsonb'], ['internal_wa_active_businesses', 'jsonb'], ['internal_wa_import_cases', 'jsonb'], ['internal_wa_plan_sends', 'jsonb'],
    ['internal_wa_claim_sends', 'jsonb'], ['internal_wa_finish_send', 'void'], ['client_wa_disconnect', 'void'],
    ['internal_wa_has_authorization', 'jsonb'], ['internal_wa_mark_history_requested', 'uuid'], ['internal_wa_apply_late_history', 'jsonb']] as const) registerRpc(n, t);
  await fake.start();
  GRAPH_URL = await new Promise<string>((r) => graph.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(graph.address() as { port: number }).port}`)));
});
test.afterAll(async () => {
  await fake.stop();
  await new Promise((r) => graph.close(r));
  sql(readFileSync(new URL('../../supabase/whatsapp/wa_integration_remove.sql', import.meta.url), 'utf8'));
});
test.beforeEach(() => { graphCalls.length = 0; logs.length = 0; sendMode = 'accept'; });

test('isolation: the handler refuses to run against the current prototype\'s project, and fails closed without configuration', async () => {
  const r = await handler({ SUPABASE_URL: 'https://aqwdwswpmbnzmkvyuqil.supabase.co' })(new Request(`${FN}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`));
  expect([r.status, (await r.json()).code]).toEqual([503, 'ISOLATION_REFUSED']);
  const r2 = await handler({ WA_TOKEN_KEY: 'short' })(new Request(`${FN}/worker`, { method: 'POST' }));
  expect([r2.status, (await r2.json()).code]).toEqual([503, 'CONFIG_INVALID']);
  expect(graphCalls).toEqual([]);
});

test('the full owner journey (SIMULATED): authorize → connect → history → case → founder approval → reopening template → reply → personal reply → takeover', async () => {
  // ---- sequencing: no authorization, no connection (refused before any Meta call)
  const early = await post('connect', { code: 'c0de', phone_number_id: PNID, waba_id: WABA }, member(CLIENT_A));
  expect([early.status, (await early.json()).code]).toEqual([409, 'AUTHORIZATION_REQUIRED']);
  expect(graphCalls).toEqual([]);

  // ---- the owner's explicit authorization comes first
  sql(`select public.client_wa_authorize('v1', 3, 'AUTOMATIC', 5, 2, 1, 'rre_reopen', 'en', :'t')`, { t: TEMPLATE_TEXT }, asClient(CLIENT_A));

  // ---- connect: only a business member, for their own business; the body cannot name a business
  expect((await post('connect', { code: 'c0de', phone_number_id: PNID, waba_id: WABA }, member(FOUNDER))).status).toBe(403);
  expect((await post('connect', { code: 'c0de', phone_number_id: PNID, waba_id: WABA, business_id: BIZ_B }, member(CLIENT_A))).status).toBe(400);
  // signed history; the FINAL batch is delivered while the history request is still in flight (immediate, out of order)
  const finalBatch = value('history', { history: [{ metadata: { phase: 2, chunk_order: 9, progress: 100 }, threads: [] }] });
  let mappingSeenByImmediateWebhook = '';
  duringHistoryRequest = async () => {
    mappingSeenByImmediateWebhook = one(`select status from private.wa_connections where phone_number_id = :'p'`, { p: PNID }) ?? 'NONE';
    expect((await webhook(finalBatch)).status).toBe(200);
  };
  const c = await post('connect', { code: 'c0de', phone_number_id: PNID, waba_id: WABA }, member(CLIENT_A));
  expect([c.status, await c.json()]).toEqual([200, { code: 'CONNECTED', contacts_sync: 'OK', history_sync: 'OK' }]);
  expect(mappingSeenByImmediateWebhook).toBe('CONNECTING'); // the mapping was saved before history was requested
  expect(graphCalls.map((g) => `${g.method} ${g.path}`)).toEqual([`GET /v25.0/oauth/access_token`, `GET /v25.0/${PNID}`,
    `POST /v25.0/${WABA}/subscribed_apps`, `POST /v25.0/${PNID}/smb_app_data`, `POST /v25.0/${PNID}/smb_app_data`]);
  const stored = one(`select token_ciphertext from private.wa_connections where business_id = :'b'`, { b: BIZ_A })!;
  expect(stored.startsWith('v1:') && !stored.includes(BUSINESS_TOKEN)).toBe(true);
  expect(await decryptToken(TOKEN_KEY, stored)).toBe(BUSINESS_TOKEN);
  expect(one(`select status || '/' || number_last4 from private.wa_connections where business_id = :'b'`, { b: BIZ_A })).toBe('CONNECTED/0001');
  const other = await post('connect', { code: 'c0de', phone_number_id: PNID, waba_id: WABA }, member(CLIENT_B));
  expect(other.status).toBe(409); // B has no authorization (and the number already belongs to business A)

  // ---- an earlier batch arrives after the final one; unsigned rejected; a group thread is not imported; a voice note has no importable content
  const history = value('history', { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 60 }, threads: [
    { id: PROSPECT, messages: [
      { from: OWNER_NUMBER, id: 'h2', timestamp: String(now() - 10 * 86400 + 60), type: 'text', text: { body: 'It is 9,500.' } },
      { from: PROSPECT, id: 'h1', timestamp: String(now() - 10 * 86400), type: 'text', text: { body: 'How much is the hatchback?' } },
      { from: PROSPECT, id: 'h3', timestamp: String(now() - 10 * 86400 + 120), type: 'audio', audio: { id: 'm1' } }] },
    { id: '120363000000000000@g.us', messages: [{ from: PROSPECT, id: 'g1', timestamp: String(now() - 86400), type: 'text', text: { body: 'group chat' } }] }] }] });
  expect((await webhook(history, false)).status).toBe(401);
  expect((await webhook(history)).status).toBe(200);
  expect((await webhook(history)).status).toBe(200); // a retry changes nothing
  expect(one(`select count(*) from private.wa_messages where business_id = :'b'`, { b: BIZ_A })).toBe('3');
  expect(one(`select history_status || '/' || status from private.wa_connections where business_id = :'b'`, { b: BIZ_A })).toBe('COMPLETE/CONNECTED');
  expect((await (await worker()).json())).toMatchObject({ imported: 0 }); // batches still settling: no analysis of an incomplete import
  sql(`update private.wa_history_chunks set received_at = now() - interval '11 minutes' where business_id = :'b'`, { b: BIZ_A });

  // ---- worker: the chat becomes an ordinary case for founder analysis (voice note marked, not invented)
  expect((await worker('wrong-secret-0123456789abcdef0123456789')).status).toBe(401);
  let w = await (await worker()).json();
  expect(w).toMatchObject({ imported: 1, planned: 0, accepted: 0 });
  const transcript = sql(`select body from public.case_messages where case_id = :'c' and kind = 'PASTED_CONVERSATION'`, { c: caseId() }).join('\n');
  expect(transcript).toMatch(/Prospect: How much is the hatchback\?\n.*Business: It is 9,500\.\n.*Prospect: \[audio not available to RRE — content not imported\]$/);
  expect(transcript).not.toContain('group chat');
  // the voice note makes the evidence incomplete: automatic outreach is refused for this contact
  expect(one(`select evidence_incomplete::text from private.wa_contacts where wa_id = :'w'`, { w: PROSPECT })).toBe('true');
  sql(`update private.wa_contacts set evidence_incomplete = false where wa_id = :'w'`, { w: PROSPECT }); // (test: as if the owner supplied the missing content)

  // ---- founder approval; the owner records permission; the founder turns the integration's sending on
  analyseAndApprove(caseId(), 'Sorry for the delay. The hatchback is still available at 9,500. Would Saturday suit you to see it?');
  w = await (await worker()).json();
  expect(w).toMatchObject({ planned: 1, accepted: 0 }); // switch off and no permission: nothing sent
  const contactId = one(`select id from private.wa_contacts where wa_id = :'w'`, { w: PROSPECT })!;
  sql(`select public.client_wa_set_permission(:'k', true, 'Customer asked us to follow up on WhatsApp.')`, { k: contactId }, asClient(CLIENT_A));
  sql('select public.founder_wa_set_sending(true)', {}, asClient(FOUNDER));
  graphCalls.length = 0;
  w = await (await worker()).json();
  expect(w).toMatchObject({ accepted: 1, failed: 0, unknown: 0 });
  expect(graphCalls).toEqual([{ method: 'POST', path: `/v25.0/${PNID}/messages`, auth: `Bearer ${BUSINESS_TOKEN}`,
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: PROSPECT, type: 'template', template: { name: 'rre_reopen', language: { code: 'en' } } } }]);
  expect(one(`select workflow_state::text from public.cases where id = :'c'`, { c: caseId() })).toBe('WAITING_FOR_PROSPECT');
  expect((await (await worker()).json()).accepted).toBe(0); // no repeat send

  // ---- delivery status, then the live reply (opens the window, returns the case to the founder)
  await webhook(value('messages', { statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: String(now()), recipient_id: PROSPECT }] }));
  expect(one(`select status from private.wa_sends where wamid = 'wamid.OUT1'`)).toBe('DELIVERED');
  await webhook(value('messages', { messages: [{ from: PROSPECT, id: 'wamid.IN1', timestamp: String(now()), type: 'text', text: { body: 'Yes! Saturday morning works.' } }] }));
  expect(one(`select workflow_state::text from public.cases where id = :'c'`, { c: caseId() })).toBe('PROSPECT_REPLIED');

  // ---- second approval inside the window: the personal reply; a timeout is held, never resent
  analyseAndApprove(caseId(), 'Great, see you Saturday at 10.');
  sendMode = 'timeout';
  graphCalls.length = 0;
  w = await (await worker()).json();
  expect(w).toMatchObject({ accepted: 0, unknown: 1 });
  expect((graphCalls[0].body as { type: string; text: { body: string } }).text.body).toBe('Great, see you Saturday at 10.');
  sendMode = 'accept';
  expect((await (await worker()).json())).toMatchObject({ accepted: 0, unknown: 0 });
  expect(graphCalls.filter((g) => g.path.endsWith('/messages'))).toHaveLength(1);

  // ---- the owner writes from the WhatsApp Business app: takeover recorded
  await webhook(value('smb_message_echoes', { message_echoes: [{ from: OWNER_NUMBER, to: PROSPECT, id: 'wamid.ECHO1', timestamp: String(now()), type: 'text', text: { body: 'Owner here.' } }] }));
  expect(one(`select (takeover_at is not null)::text from private.wa_contacts where wa_id = :'w'`, { w: PROSPECT })).toBe('true');

  // ---- secrets never in logs
  const all = logs.join('\n');
  for (const s of [BUSINESS_TOKEN, APP_SECRET, WORKER, VERIFY]) expect(all).not.toContain(s);
});

test('provider failures: a definitive refusal is FAILED (no retry); an expired token puts the connection in Action required', async () => {
  // a fresh approved, permitted case for the same contact is not possible after takeover; use business B's own connection
  sql(`select public.client_wa_authorize('v1', 3, 'AUTOMATIC', 5, 2, 1, null, null, null)`, {}, asClient(CLIENT_B));
  const r = await post('connect', { code: 'c0de', phone_number_id: '100000000000002', waba_id: '200000000000002' }, member(CLIENT_B));
  expect(r.status).toBe(200);
  expect(one(`select status from private.wa_connections where business_id = :'b'`, { b: BIZ_B })).toBe('SYNCING');
  expect((await r.json()).code).toBe('SYNCING');
  sendMode = 'token';
  sql('select public.founder_wa_set_sending(true)', {}, asClient(FOUNDER));
  // a queued send for B (inserted as the database owner for this failure-mode check)
  sql(`insert into private.wa_contacts (business_id, wa_id, permission, last_live_inbound_at) values (:'b', '2348000000222', 'OPTED_IN', now());
       insert into public.cases (business_id, reference, product_service, lead_source, conversation_source, idempotency_key, workflow_state)
       values (:'b', 'WA-FAIL', 'x', 'Unknown', 'TEXT', gen_random_uuid(), 'SUBMITTED');`, { b: BIZ_B });
  const c = one(`select id from public.cases where reference = 'WA-FAIL'`)!;
  sql(`insert into public.case_messages (case_id, business_id, kind, body) values (:'c', :'b', 'PASTED_CONVERSATION', 'Prospect: hello there, is it available?');
       update private.wa_contacts set case_id = :'c' where wa_id = '2348000000222';
       update private.wa_connections set status = 'CONNECTED' where business_id = :'b';`, { c, b: BIZ_B });
  analyseAndApprove(c, 'Yes it is, would you like to see it?');
  const w = await (await worker()).json();
  expect(w).toMatchObject({ failed: 1, accepted: 0, unknown: 0 });
  expect(one(`select status || '/' || action_code || '/' || (token_ciphertext is null)::text from private.wa_connections where business_id = :'b'`, { b: BIZ_B }))
    .toBe('ACTION_REQUIRED/TOKEN_REVOKED/true');
  expect((await (await worker()).json()).failed).toBe(0); // never retried
});

test('disconnect: the app is unsubscribed (best effort), the credential deleted, the number no longer accepted', async () => {
  graphCalls.length = 0;
  const r = await post('disconnect', {}, member(CLIENT_A));
  expect([r.status, (await r.json()).code]).toEqual([200, 'DISCONNECTED']);
  expect(graphCalls.map((g) => `${g.method} ${g.path}`)).toEqual([`DELETE /v25.0/${WABA}/subscribed_apps`]);
  expect(one(`select status || '/' || (token_ciphertext is null)::text from private.wa_connections where business_id = :'b'`, { b: BIZ_A })).toBe('DISCONNECTED/true');
  await webhook(value('messages', { messages: [{ from: PROSPECT, id: 'wamid.AFTER', timestamp: String(now()), type: 'text', text: { body: 'hi' } }] }));
  expect(one(`select count(*) from private.wa_messages where wamid = 'wamid.AFTER'`)).toBe('0');
});

test('webhook normalization: content only where readable; speakers from the thread; statuses; account notices by WABA id', () => {
  const ev = normalizeWebhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [
    { field: 'messages', value: { metadata: { phone_number_id: PNID }, messages: [
      { from: PROSPECT, id: 'a', timestamp: '1793793600', type: 'image', image: { id: 'x', caption: 'hidden' } },
      { from: PROSPECT, id: 'b', timestamp: '1793793601', type: 'interactive', interactive: { button_reply: { title: 'Yes please' } } },
      { from: 'not-a-number', id: 'c', timestamp: '1793793602', type: 'text', text: { body: 'x' } }],
      statuses: [{ id: 'wamid.X', status: 'failed', errors: [{ code: 131049 }] }, { id: 'wamid.Y', status: 'weird' }] } },
    { field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }] });
  expect(ev).toEqual([
    { kind: 'MESSAGE', phone_number_id: PNID, wa_id: PROSPECT, wamid: 'a', direction: 'IN', source: 'LIVE', msg_type: 'image', body: null, content_available: false, sent_at: 1793793600 },
    { kind: 'MESSAGE', phone_number_id: PNID, wa_id: PROSPECT, wamid: 'b', direction: 'IN', source: 'LIVE', msg_type: 'interactive', body: 'Yes please', content_available: true, sent_at: 1793793601 },
    { kind: 'STATUS', phone_number_id: PNID, wamid: 'wamid.X', status: 'failed', error_code: '131049' },
    { kind: 'ACCOUNT', waba_id: WABA, phone_number_id: null, event: 'PARTNER_REMOVED' },
  ]);
});

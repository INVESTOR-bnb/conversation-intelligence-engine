// WhatsApp FEASIBILITY TEST — the `whatsapp-test` Edge Function's logic (runtime-neutral: the
// Deno entry point and the Node tests both call createWaTestHandler). Official Cloud API only.
//
// Routes (the function is deployed with verify_jwt OFF because Meta cannot send a Supabase JWT;
// every founder route authenticates the founder in code, the webhook is authenticated by its
// HMAC signature):
//   GET  …/webhook   Meta's verification handshake (hub.verify_token must match WA_VERIFY_TOKEN).
//   POST …/webhook   Meta events. X-Hub-Signature-256 must be HMAC-SHA256(WA_APP_SECRET, raw body),
//                    or 401. Stored as METADATA (see wa_test.sql); text only for the test contact;
//                    chat history only as counts. Retries/replays are deduplicated by the database.
//   POST …/onboard   founder: exchanges the Embedded Signup code (coexistence onboarding), maps
//                    the number to the chosen RRE business, subscribes the app to the WABA's
//                    webhooks, requests the one-time contact and history sync. The exchanged
//                    token is used in this request only and never stored or returned.
//   POST …/send      founder: ONE fixed, labelled test message, only to WA_TEST_RECIPIENT, only
//                    when WA_TEST_SENDING=enabled; idempotent per key; at most 3 per number;
//                    TEXT mode only inside the 24-hour window opened by the test contact.
//   GET  …/summary   founder: what was observed (founder_wa_test_summary).
// It never contacts anyone but the configured test recipient and never reads or stores the
// content of real customers' chats.

import { authenticateFounder } from '../edge/auth.ts';

export const GRAPH = 'https://graph.facebook.com/v25.0';
export const TEST_MESSAGE = 'RRE TEST: WhatsApp connection check. Please reply TEST-OK. This is not a sales message.';
export const MAX_WEBHOOK_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGITS = /^[0-9]{5,30}$/;

export interface WaConfig {
  supabaseUrl: string;
  publishableKey: string;
  serviceKey: string;
  appId: string;
  appSecret: string;
  verifyToken: string;
  testRecipient: string;
  sendingEnabled: boolean;
  accessToken: string | null;
  template: { name: string; language: string } | null;
  allowedOrigin: string;
}

function defaultKey(json: string | undefined): string | null {
  if (!json) return null;
  try { const v = JSON.parse(json) as Record<string, unknown>; return typeof v?.default === 'string' && v.default ? v.default : null; } catch { return null; }
}

/** The whole configuration, or null (every route then refuses: fail closed). */
export function readWaConfig(env: (name: string) => string | undefined): WaConfig | null {
  let url: URL;
  try { url = new URL(env('SUPABASE_URL') ?? ''); } catch { return null; }
  const local = ['127.0.0.1', 'localhost', 'kong'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || (url.pathname !== '/' && url.pathname !== '')) return null;
  const publishableKey = defaultKey(env('SUPABASE_PUBLISHABLE_KEYS')) ?? env('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = defaultKey(env('SUPABASE_SECRET_KEYS')) ?? env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!/^(sb_publishable_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{20,})$/.test(publishableKey)
      || !/^(sb_secret_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{20,})$/.test(serviceKey) || publishableKey === serviceKey) return null;
  const appId = env('WA_APP_ID') ?? '';
  const appSecret = env('WA_APP_SECRET') ?? '';
  const verifyToken = env('WA_VERIFY_TOKEN') ?? '';
  const testRecipient = env('WA_TEST_RECIPIENT') ?? '';
  if (!DIGITS.test(appId) || !/^[A-Za-z0-9]{16,200}$/.test(appSecret) || !/^[A-Za-z0-9_-]{24,200}$/.test(verifyToken)
      || !/^[1-9][0-9]{7,14}$/.test(testRecipient)) return null;
  const accessToken = env('WA_ACCESS_TOKEN') ?? '';
  const tName = env('WA_TEST_TEMPLATE') ?? '';
  const tLang = env('WA_TEST_TEMPLATE_LANG') ?? 'en';
  if (tName && (!/^[a-z0-9_]{1,512}$/.test(tName) || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(tLang))) return null;
  return {
    supabaseUrl: url.origin, publishableKey, serviceKey, appId, appSecret, verifyToken, testRecipient,
    sendingEnabled: env('WA_TEST_SENDING') === 'enabled',
    accessToken: /^[A-Za-z0-9]{20,1000}$/.test(accessToken) ? accessToken : null,
    template: tName ? { name: tName, language: tLang } : null,
    allowedOrigin: env('WA_ALLOWED_ORIGIN') ?? 'https://revenue-recovery-v0.pages.dev',
  };
}

// ---------------------------------------------------------------- crypto (WebCrypto: Deno and Node)
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function hmacHex(key: string, data: Uint8Array | string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}
/** Constant-time string equality (length leaks only). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** Meta's webhook signature: "sha256=" + HMAC-SHA256(app secret, the exact raw body). */
export async function validSignature(appSecret: string, raw: Uint8Array, header: string | null): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  return safeEqual(await hmacHex(appSecret, raw), m[1]);
}
/** A keyed hash of a customer's WhatsApp id: lets the test link events without storing the number. */
export const contactHash = (appSecret: string, waId: string) => hmacHex(`rre-wa-contact:${appSecret}`, waId);

// ---------------------------------------------------------------- webhook payload → stored events
export interface WaEvent {
  dedupe_key: string;
  phone_number_id: string;
  kind: 'INBOUND' | 'STATUS' | 'ECHO' | 'HISTORY' | 'HISTORY_DECLINED' | 'CONTACT_SYNC';
  contact_hash: string | null;
  is_test_contact: boolean;
  wa_message_id: string | null;
  reply_to: string | null;
  status: string | null;
  body: string | null;
  summary: Record<string, unknown> | null;
  occurred_at: number | null;
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const ts = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 1e9 && n < 1e11 ? n : null; };

/** Every event in one webhook payload, as the rows the test stores. Content only for the test contact. */
export async function extractEvents(payload: unknown, appSecret: string, testRecipient: string): Promise<WaEvent[]> {
  const out: WaEvent[] = [];
  const p = obj(payload);
  if (p.object !== 'whatsapp_business_account') return out;
  for (const entry of arr(p.entry)) {
    for (const change of arr(obj(entry).changes)) {
      const field = obj(change).field;
      const v = obj(obj(change).value);
      const pnid = str(obj(v.metadata).phone_number_id, 30);
      if (!pnid || !DIGITS.test(pnid)) continue;
      const base = { phone_number_id: pnid, contact_hash: null, is_test_contact: false, wa_message_id: null, reply_to: null,
        status: null, body: null, summary: null, occurred_at: null };
      if (field === 'messages') {
        for (const m of arr(v.messages).map(obj)) {
          const id = str(m.id); const from = str(m.from, 20);
          if (!id || !from) continue;
          const test = from === testRecipient;
          out.push({ ...base, dedupe_key: `in:${id}`, kind: 'INBOUND', contact_hash: await contactHash(appSecret, from), is_test_contact: test,
            wa_message_id: id, reply_to: str(obj(m.context).id), status: str(m.type, 40),
            body: test && m.type === 'text' ? str(obj(m.text).body, 4096) : null, occurred_at: ts(m.timestamp) });
        }
        for (const s of arr(v.statuses).map(obj)) {
          const id = str(s.id); const st = str(s.status, 20); const to = str(s.recipient_id, 20);
          if (!id || !st) continue;
          const code = obj(arr(s.errors)[0]).code;
          out.push({ ...base, dedupe_key: `st:${id}:${st}`, kind: 'STATUS', contact_hash: to ? await contactHash(appSecret, to) : null,
            is_test_contact: to === testRecipient, wa_message_id: id, status: typeof code === 'number' ? `${st}:${code}` : st, occurred_at: ts(s.timestamp) });
        }
      } else if (field === 'smb_message_echoes') {
        for (const e of arr(v.message_echoes).map(obj)) {
          const id = str(e.id); const to = str(e.to, 20);
          if (!id || !to) continue;
          const test = to === testRecipient;
          out.push({ ...base, dedupe_key: `echo:${id}`, kind: 'ECHO', contact_hash: await contactHash(appSecret, to), is_test_contact: test,
            wa_message_id: id, status: str(e.type, 40), body: test && e.type === 'text' ? str(obj(e.text).body, 4096) : null, occurred_at: ts(e.timestamp) });
        }
      } else if (field === 'history') {
        for (const h of arr(v.history).map(obj)) {
          const err = obj(arr(h.errors)[0]);
          if (Object.keys(err).length) {
            out.push({ ...base, dedupe_key: `hist-err:${pnid}:${String(err.code ?? 'x').slice(0, 20)}`, kind: 'HISTORY_DECLINED',
              summary: { error_code: typeof err.code === 'number' ? err.code : null } });
            continue;
          }
          out.push({ ...base, dedupe_key: `hist:${pnid}:${await hmacHex('rre-wa-chunk', JSON.stringify(h))}`, kind: 'HISTORY', summary: historySummary(h) });
        }
      } else if (field === 'smb_app_state_sync') {
        const items = arr(v.state_sync);
        out.push({ ...base, dedupe_key: `sync:${pnid}:${await hmacHex('rre-wa-chunk', JSON.stringify(items))}`, kind: 'CONTACT_SYNC',
          summary: { contacts: items.length } });
      }
    }
  }
  return out;
}

/** What a history chunk proves, without its content: phase, progress, threads, messages, types, date range. */
export function historySummary(h: Obj): Record<string, unknown> {
  const meta = obj(h.metadata);
  const types: Record<string, number> = {};
  let messages = 0; let oldest: number | null = null; let newest: number | null = null;
  const threads = arr(h.threads).map(obj);
  for (const t of threads) {
    for (const m of arr(t.messages).map(obj)) {
      messages++;
      const ty = typeof m.type === 'string' && /^[a-z_]{1,30}$/.test(m.type) ? m.type : 'other';
      types[ty] = (types[ty] ?? 0) + 1;
      const at = ts(m.timestamp);
      if (at !== null) { oldest = oldest === null ? at : Math.min(oldest, at); newest = newest === null ? at : Math.max(newest, at); }
    }
  }
  const num = (x: unknown) => (typeof x === 'number' || (typeof x === 'string' && /^[0-9]{1,6}$/.test(x)) ? Number(x) : null);
  return { phase: num(meta.phase), chunk_order: num(meta.chunk_order), progress: num(meta.progress), threads: threads.length, messages, types,
    oldest: oldest === null ? null : new Date(oldest * 1000).toISOString(), newest: newest === null ? null : new Date(newest * 1000).toISOString() };
}

// ---------------------------------------------------------------- the handler
export interface WaDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  log: (line: string) => void;
  now?: () => number;
}

export function createWaTestHandler(deps: WaDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
    try { deps.log(JSON.stringify({ fn: 'whatsapp-test', event, ...fields })); } catch { /* never breaks a request */ }
  };
  return async (req: Request): Promise<Response> => {
    const cfg = readWaConfig(deps.env);
    const path = new URL(req.url).pathname;
    const route = path.endsWith('/webhook') ? 'webhook' : path.endsWith('/onboard') ? 'onboard' : path.endsWith('/send') ? 'send'
      : path.endsWith('/summary') ? 'summary' : null;
    const origin = req.headers.get('origin');
    const cors: Record<string, string> = cfg && origin === cfg.allowedOrigin && route !== 'webhook'
      ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info', vary: 'Origin' } : {};
    const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors } });
    try {
      if (!route) return json(404, { code: 'NOT_FOUND' });
      if (!cfg) { log('config.invalid'); return json(503, { code: 'CONFIG_INVALID' }); }
      if (req.method === 'OPTIONS' && route !== 'webhook') return cors['access-control-allow-origin'] ? new Response(null, { status: 204, headers: cors }) : json(403, { code: 'ORIGIN_NOT_ALLOWED' });

      // ---- webhook
      if (route === 'webhook' && req.method === 'GET') {
        const q = new URL(req.url).searchParams;
        const challenge = q.get('hub.challenge') ?? '';
        if (q.get('hub.mode') === 'subscribe' && safeEqual(q.get('hub.verify_token') ?? '', cfg.verifyToken) && /^[A-Za-z0-9_-]{1,100}$/.test(challenge)) {
          return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        log('webhook.verify_refused');
        return json(403, { code: 'FORBIDDEN' });
      }
      if (route === 'webhook' && req.method === 'POST') {
        const declared = Number(req.headers.get('content-length') ?? 'NaN');
        if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return json(413, { code: 'BODY_TOO_LARGE' });
        const raw = new Uint8Array(await req.arrayBuffer());
        if (raw.length > MAX_WEBHOOK_BYTES) return json(413, { code: 'BODY_TOO_LARGE' });
        if (!(await validSignature(cfg.appSecret, raw, req.headers.get('x-hub-signature-256')))) {
          log('webhook.bad_signature');
          return json(401, { code: 'BAD_SIGNATURE' });
        }
        let payload: unknown;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return json(400, { code: 'INVALID_JSON' }); }
        const events = await extractEvents(payload, cfg.appSecret, cfg.testRecipient);
        let stored = 0;
        for (let i = 0; i < events.length; i += 500) {
          const r = await service(cfg, deps.fetch, 'internal_wa_record_events', { p_events: events.slice(i, i + 500) });
          if (!r.ok) { log('webhook.store_failed', { status: r.status }); return json(500, { code: 'STORE_FAILED' }); } // Meta retries; dedupe makes that safe
          stored += Number(r.data) || 0;
        }
        log('webhook.received', { events: events.length, stored, duplicatesOrUnknown: events.length - stored });
        return json(200, { code: 'OK' });
      }

      // ---- founder routes
      if (route === 'summary' ? req.method !== 'GET' : req.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED' });
      if (origin !== null && !cors['access-control-allow-origin']) return json(403, { code: 'ORIGIN_NOT_ALLOWED' });
      const auth = await authenticateFounder(req, { supabaseUrl: cfg.supabaseUrl, publishableKey: cfg.publishableKey, fetch: deps.fetch, timeoutMs: 10000 });
      if (!auth.ok) return json(auth.status, { code: auth.code });

      if (route === 'summary') {
        const r = await rest(cfg, deps.fetch, 'founder_wa_test_summary', {}, { apikey: cfg.publishableKey, authorization: `Bearer ${auth.jwt}` });
        return r.ok ? json(200, { code: 'OK', summary: r.data as Record<string, unknown> }) : json(503, { code: 'SUMMARY_UNAVAILABLE' });
      }
      const body = await readSmallJson(req);
      if (!body) return json(400, { code: 'INVALID_REQUEST' });

      if (route === 'onboard') {
        const code = str(body.code, 1000); const pnid = str(body.phone_number_id, 30); const waba = str(body.waba_id, 30); const biz = str(body.business_id, 36);
        if (!code || !/^[A-Za-z0-9_.-]+$/.test(code) || !pnid || !DIGITS.test(pnid) || !waba || !DIGITS.test(waba) || !biz || !UUID.test(biz)) {
          return json(400, { code: 'INVALID_REQUEST' });
        }
        const steps: Record<string, string> = {};
        const tokenRes = await graph(deps.fetch, `${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code })}`, null, 'GET');
        const token = typeof tokenRes.data?.access_token === 'string' ? tokenRes.data.access_token : null;
        steps.exchange = token ? 'OK' : tokenRes.code;
        if (!token) return json(502, { code: 'EXCHANGE_FAILED', steps });
        const reg = await service(cfg, deps.fetch, 'internal_wa_register_number', { p_phone_number_id: pnid, p_waba_id: waba, p_business_id: biz, p_founder: auth.userId });
        steps.register = reg.ok ? 'OK' : `HTTP_${reg.status}`;
        if (!reg.ok) return json(409, { code: 'REGISTER_FAILED', steps });
        steps.subscribe = (await graph(deps.fetch, `${GRAPH}/${waba}/subscribed_apps`, token, 'POST')).code;
        steps.contacts_sync = (await graph(deps.fetch, `${GRAPH}/${pnid}/smb_app_data`, token, 'POST', { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' })).code;
        steps.history_sync = (await graph(deps.fetch, `${GRAPH}/${pnid}/smb_app_data`, token, 'POST', { messaging_product: 'whatsapp', sync_type: 'history' })).code;
        log('onboard.done', steps);
        return json(200, { code: 'OK', steps });
      }

      // route === 'send'
      const key = str(body.idempotency_key, 36); const pnid = str(body.phone_number_id, 30);
      const mode = body.mode === 'TEMPLATE' ? 'TEMPLATE' : body.mode === 'TEXT' ? 'TEXT' : null;
      if (!key || !UUID.test(key) || !pnid || !DIGITS.test(pnid) || !mode || 'to' in body || 'text' in body) return json(400, { code: 'INVALID_REQUEST' });
      if (!cfg.sendingEnabled) return json(403, { code: 'SENDING_DISABLED' });
      if (!cfg.accessToken) return json(503, { code: 'SEND_NOT_CONFIGURED' });
      if (mode === 'TEMPLATE' && !cfg.template) return json(503, { code: 'TEMPLATE_NOT_CONFIGURED' });
      if (mode === 'TEXT') {
        const last = await service(cfg, deps.fetch, 'internal_wa_last_inbound_at', { p_phone_number_id: pnid, p_contact_hash: await contactHash(cfg.appSecret, cfg.testRecipient) });
        if (!last.ok) return json(503, { code: 'STORE_FAILED' });
        const at = typeof last.data === 'string' ? Date.parse(last.data) : NaN;
        if (!Number.isFinite(at) || now() - at > 23.5 * 3600 * 1000) return json(409, { code: 'WINDOW_CLOSED' });
      }
      const reserve = await service(cfg, deps.fetch, 'internal_wa_reserve_send', { p_key: key, p_phone_number_id: pnid, p_mode: mode, p_requested_by: auth.userId });
      if (!reserve.ok) return json(503, { code: 'STORE_FAILED' });
      if (reserve.data !== 'NEW') return json(reserve.data === 'DUPLICATE' ? 200 : 409, { code: String(reserve.data) });
      const message = mode === 'TEXT'
        ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: cfg.testRecipient, type: 'text', text: { body: TEST_MESSAGE, preview_url: false } }
        : { messaging_product: 'whatsapp', recipient_type: 'individual', to: cfg.testRecipient, type: 'template', template: { name: cfg.template!.name, language: { code: cfg.template!.language } } };
      const sent = await graph(deps.fetch, `${GRAPH}/${pnid}/messages`, cfg.accessToken, 'POST', message);
      const wamid = str(obj(arr(sent.data?.messages)[0]).id);
      await service(cfg, deps.fetch, 'internal_wa_finish_send', { p_key: key, p_status: wamid ? 'ACCEPTED' : 'FAILED', p_wa_message_id: wamid, p_error_code: wamid ? null : sent.code });
      log('send.done', { mode, accepted: Boolean(wamid), code: sent.code });
      return json(wamid ? 200 : 502, { code: wamid ? 'ACCEPTED' : sent.code, wa_message_id: wamid });
    } catch {
      log('request.error');
      return json(500, { code: 'INTERNAL_ERROR' });
    }
  };
}

async function readSmallJson(req: Request): Promise<Record<string, unknown> | null> {
  if ((req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return null;
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > MAX_JSON_BYTES) return null;
  try { const v = JSON.parse(new TextDecoder().decode(raw)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** A Graph API call: returns parsed JSON and a short code (OK, HTTP_<status> or META_<code>); never the token or Meta's text. */
async function graph(f: typeof fetch, url: string, token: string | null, method: 'GET' | 'POST', body?: unknown): Promise<{ code: string; data: Record<string, unknown> | null }> {
  try {
    const res = await f(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    let data: Record<string, unknown> | null = null;
    try { data = obj(await res.json()); } catch { /* not JSON */ }
    if (res.ok) return { code: 'OK', data };
    const metaCode = obj(data?.error).code;
    return { code: typeof metaCode === 'number' ? `META_${metaCode}` : `HTTP_${res.status}`, data: null };
  } catch {
    return { code: 'NETWORK', data: null };
  }
}

async function rest(cfg: WaConfig, f: typeof fetch, fn: string, args: unknown, headers: Record<string, string>): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await f(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}
const service = (cfg: WaConfig, f: typeof fetch, fn: string, args: unknown) => rest(cfg, f, fn, args,
  cfg.serviceKey.startsWith('sb_secret_') ? { apikey: cfg.serviceKey } : { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}` });

// RRE WhatsApp integration — the `whatsapp` Edge Function's logic (runtime-neutral; the Deno entry
// and the Node tests call createWaHandler). Official Cloud API only. Database rules live in
// supabase/whatsapp/wa_integration.sql; this code only executes what the database releases.
//
// ISOLATION: it refuses to run against the current prototype's Supabase project. It is deployed only
// to the separate WhatsApp development project, with verify_jwt OFF (Meta's webhook carries no
// Supabase JWT); members and the worker are authenticated in code.
//
// Routes:
//   GET  …/webhook     Meta's verification handshake.
//   POST …/webhook     signed events (X-Hub-Signature-256) → internal_wa_ingest. Unsigned → 401.
//   POST …/connect     business member: Embedded Signup code exchange (WhatsApp Business app onboarding),
//                      webhook subscription, one-time contact + history sync request; the token is stored
//                      ENCRYPTED; the business is the member's own (from the session, never the request).
//   POST …/disconnect  business member: unsubscribes the app (best effort) and disconnects.
//   POST …/worker      scheduler only (x-rre-worker secret): import chats → cases, plan sends, send what
//                      the database releases. Provider timeouts/5xx become UNKNOWN (never resent).

import { safeEqual, validSignature } from './waTest.ts';

export const GRAPH = 'https://graph.facebook.com/v25.0';
/** The current prototype's project: this integration must never run against it. */
export const PROTOTYPE_PROJECT_HOST = 'aqwdwswpmbnzmkvyuqil.supabase.co';
const MAX_WEBHOOK_BYTES = 10 * 1024 * 1024;
const DIGITS = /^[0-9]{5,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

export interface WaIntConfig {
  supabaseUrl: string; publishableKey: string; serviceKey: string;
  appId: string; appSecret: string; verifyToken: string; tokenKey: Uint8Array; workerSecret: string; allowedOrigin: string;
}
function defaultKey(json: string | undefined): string | null {
  if (!json) return null;
  try { const v = JSON.parse(json) as Record<string, unknown>; return typeof v?.default === 'string' && v.default ? v.default : null; } catch { return null; }
}
function b64decode(s: string): Uint8Array | null {
  try { const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); } catch { return null; }
}
const b64encode = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** The configuration, or a refusal code (every route then refuses: fail closed). */
export function readWaIntConfig(env: (n: string) => string | undefined): { ok: true; config: WaIntConfig } | { ok: false; code: string } {
  let url: URL;
  try { url = new URL(env('SUPABASE_URL') ?? ''); } catch { return { ok: false, code: 'CONFIG_INVALID' }; }
  if (url.host === PROTOTYPE_PROJECT_HOST) return { ok: false, code: 'ISOLATION_REFUSED' };
  const local = ['127.0.0.1', 'localhost', 'kong'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || (url.pathname !== '/' && url.pathname !== '')) return { ok: false, code: 'CONFIG_INVALID' };
  const publishableKey = defaultKey(env('SUPABASE_PUBLISHABLE_KEYS')) ?? env('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = defaultKey(env('SUPABASE_SECRET_KEYS')) ?? env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const tokenKey = b64decode(env('WA_TOKEN_KEY') ?? '');
  const c = { appId: env('WA_APP_ID') ?? '', appSecret: env('WA_APP_SECRET') ?? '', verifyToken: env('WA_VERIFY_TOKEN') ?? '', workerSecret: env('WA_WORKER_SECRET') ?? '' };
  if (!/^(sb_publishable_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{20,})$/.test(publishableKey) || !/^(sb_secret_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{20,})$/.test(serviceKey)
      || publishableKey === serviceKey || !DIGITS.test(c.appId) || !/^[A-Za-z0-9]{16,200}$/.test(c.appSecret)
      || !/^[A-Za-z0-9_-]{24,200}$/.test(c.verifyToken) || !/^[A-Za-z0-9_-]{32,200}$/.test(c.workerSecret) || !tokenKey || tokenKey.length !== 32) {
    return { ok: false, code: 'CONFIG_INVALID' };
  }
  return { ok: true, config: { supabaseUrl: url.origin, publishableKey, serviceKey, ...c, tokenKey, allowedOrigin: env('WA_ALLOWED_ORIGIN') ?? '' } };
}

// ---------------------------------------------------------------- token encryption (AES-256-GCM)
async function aesKey(raw: Uint8Array) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function encryptToken(key: Uint8Array, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(key), new TextEncoder().encode(token)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return `v1:${b64encode(out)}`;
}
export async function decryptToken(key: Uint8Array, blob: string): Promise<string | null> {
  if (!blob?.startsWith('v1:')) return null;
  const raw = b64decode(blob.slice(3));
  if (!raw || raw.length < 29) return null;
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(key), raw.slice(12))); } catch { return null; }
}

// ---------------------------------------------------------------- webhook payload → normalized events
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const ts = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 1e9 && n < 1e11 ? n : null; };
const WA_ID = /^[1-9][0-9]{6,14}$/;

/** Text RRE can read from a message, or null (images, voice notes, stickers, deleted…: never invented). */
export function messageContent(m: Obj): { type: string; body: string | null } {
  const type = typeof m.type === 'string' && /^[a-z_]{1,30}$/.test(m.type) ? m.type : 'unknown';
  if (type === 'text') return { type, body: str(obj(m.text).body, 4096) };
  if (type === 'button') return { type, body: str(obj(m.button).text, 4096) };
  if (type === 'interactive') { const i = obj(m.interactive); return { type, body: str(obj(i.button_reply).title, 4096) ?? str(obj(i.list_reply).title, 4096) }; }
  return { type, body: null };
}

export function normalizeWebhook(payload: unknown): Obj[] {
  const out: Obj[] = [];
  const p = obj(payload);
  if (p.object !== 'whatsapp_business_account') return out;
  for (const entry of arr(p.entry)) {
    const wabaId = str(obj(entry).id, 30);
    for (const change of arr(obj(entry).changes)) {
      const field = obj(change).field;
      const v = obj(obj(change).value);
      const pnid = str(obj(v.metadata).phone_number_id, 30);
      if (field === 'account_update' || field === 'partner_solutions') {
        const event = str(v.event, 64);
        if (event && wabaId && DIGITS.test(wabaId)) out.push({ kind: 'ACCOUNT', waba_id: wabaId, phone_number_id: null, event });
        continue;
      }
      if (!pnid || !DIGITS.test(pnid)) continue;
      const message = (m: Obj, waId: unknown, direction: string, source: string) => {
        const wamid = str(m.id); const at = ts(m.timestamp); const wa = str(waId, 20);
        if (!wamid || at === null || !wa || !WA_ID.test(wa)) return null;
        const c = messageContent(m);
        return { wa_id: wa, wamid, direction, source, msg_type: c.type, body: c.body, content_available: c.body !== null, sent_at: at };
      };
      if (field === 'messages') {
        for (const m of arr(v.messages).map(obj)) { const e = message(m, m.from, 'IN', 'LIVE'); if (e) out.push({ kind: 'MESSAGE', phone_number_id: pnid, ...e }); }
        for (const s of arr(v.statuses).map(obj)) {
          const wamid = str(s.id); const st = str(s.status, 20);
          if (!wamid || !st || !['sent', 'delivered', 'read', 'failed'].includes(st)) continue;
          const code = obj(arr(s.errors)[0]).code;
          out.push({ kind: 'STATUS', phone_number_id: pnid, wamid, status: st, error_code: typeof code === 'number' ? String(code) : null });
        }
      } else if (field === 'smb_message_echoes') {
        for (const m of arr(v.message_echoes).map(obj)) { const e = message(m, m.to, 'OUT_HUMAN', 'ECHO'); if (e) out.push({ kind: 'MESSAGE', phone_number_id: pnid, ...e }); }
      } else if (field === 'history') {
        for (const h of arr(v.history).map(obj)) {
          if (arr(h.errors).length) { out.push({ kind: 'HISTORY_DECLINED', phone_number_id: pnid }); continue; }
          const meta = obj(h.metadata);
          const num = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) ? x : typeof x === 'string' && /^[0-9]{1,6}$/.test(x) ? Number(x) : null);
          const messages: Obj[] = [];
          for (const t of arr(h.threads).map(obj)) {
            const contact = str(t.id, 20);
            if (!contact || !WA_ID.test(contact)) continue; // groups and anything that is not a 1:1 thread are not imported
            for (const m of arr(t.messages).map(obj)) {
              const e = message(m, contact, m.from === contact ? 'IN' : 'OUT_HUMAN', 'HISTORY');
              if (e) messages.push(e);
            }
          }
          const phase = num(meta.phase); const order = num(meta.chunk_order);
          out.push({ kind: 'HISTORY_CHUNK', phone_number_id: pnid, chunk_key: `${phase ?? 'x'}:${order ?? 'x'}:${messages[0]?.wamid ?? 'empty'}`,
            phase, chunk_order: order, progress: num(meta.progress), messages });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the handler
export interface WaIntDeps { env: (n: string) => string | undefined; fetch: typeof fetch; log: (line: string) => void }

export function createWaHandler(deps: WaIntDeps): (req: Request) => Promise<Response> {
  const log = (event: string, f: Record<string, string | number | boolean | null> = {}) => { try { deps.log(JSON.stringify({ fn: 'whatsapp', event, ...f })); } catch { /* never breaks */ } };
  return async (req: Request): Promise<Response> => {
    const cfgR = readWaIntConfig(deps.env);
    const path = new URL(req.url).pathname;
    const route = (['webhook', 'connect', 'disconnect', 'worker'] as const).find((r) => path.endsWith(`/${r}`)) ?? null;
    const origin = req.headers.get('origin');
    const cors: Record<string, string> = cfgR.ok && cfgR.config.allowedOrigin && origin === cfgR.config.allowedOrigin && (route === 'connect' || route === 'disconnect')
      ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info', vary: 'Origin' } : {};
    const json = (status: number, body: Obj) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors } });
    try {
      if (!route) return json(404, { code: 'NOT_FOUND' });
      if (!cfgR.ok) { log('config.refused', { code: cfgR.code }); return json(503, { code: cfgR.code }); }
      const cfg = cfgR.config;
      if (req.method === 'OPTIONS') return cors['access-control-allow-origin'] ? new Response(null, { status: 204, headers: cors }) : json(403, { code: 'ORIGIN_NOT_ALLOWED' });

      if (route === 'webhook' && req.method === 'GET') {
        const q = new URL(req.url).searchParams; const ch = q.get('hub.challenge') ?? '';
        return q.get('hub.mode') === 'subscribe' && safeEqual(q.get('hub.verify_token') ?? '', cfg.verifyToken) && /^[A-Za-z0-9_-]{1,100}$/.test(ch)
          ? new Response(ch, { status: 200, headers: { 'content-type': 'text/plain' } }) : json(403, { code: 'FORBIDDEN' });
      }
      if (route === 'webhook' && req.method === 'POST') {
        if (Number(req.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return json(413, { code: 'BODY_TOO_LARGE' });
        const raw = new Uint8Array(await req.arrayBuffer());
        if (raw.length > MAX_WEBHOOK_BYTES) return json(413, { code: 'BODY_TOO_LARGE' });
        if (!(await validSignature(cfg.appSecret, raw, req.headers.get('x-hub-signature-256')))) { log('webhook.bad_signature'); return json(401, { code: 'BAD_SIGNATURE' }); }
        let payload: unknown;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return json(400, { code: 'INVALID_JSON' }); }
        const events = normalizeWebhook(payload);
        for (let i = 0; i < events.length; i += 1000) {
          const r = await service(cfg, deps.fetch, 'internal_wa_ingest', { p_events: events.slice(i, i + 1000) });
          if (!r.ok) { log('webhook.store_failed', { status: r.status }); return json(500, { code: 'STORE_FAILED' }); } // Meta retries; idempotent
          const d = obj(r.data);
          log('webhook.ingested', { events: events.length, stored: Number(d.stored) || 0, duplicates: Number(d.duplicates) || 0, unknownNumber: Number(d.unknown_number) || 0 });
        }
        return json(200, { code: 'OK' });
      }

      if (req.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED' });

      if (route === 'worker') {
        if (!safeEqual(req.headers.get('x-rre-worker') ?? '', cfg.workerSecret)) return json(401, { code: 'UNAUTHENTICATED' });
        return json(200, { code: 'OK', ...(await runWorker(cfg, deps.fetch, log)) });
      }

      // ---- member routes
      if (origin !== null && !cors['access-control-allow-origin']) return json(403, { code: 'ORIGIN_NOT_ALLOWED' });
      const member = await authenticateMember(req, cfg, deps.fetch);
      if (!member.ok) return json(member.status, { code: member.code });
      const body = await readSmallJson(req);
      if (!body) return json(400, { code: 'INVALID_REQUEST' });

      if (route === 'disconnect') {
        const conn = obj((await service(cfg, deps.fetch, 'internal_wa_connection', { p_business: member.businessId })).data);
        const token = typeof conn.token === 'string' ? await decryptToken(cfg.tokenKey, conn.token) : null;
        const unsub = token && typeof conn.waba_id === 'string' ? (await graph(deps.fetch, `${GRAPH}/${conn.waba_id}/subscribed_apps`, token, 'DELETE')).code : 'SKIPPED';
        const r = await rest(cfg, deps.fetch, 'client_wa_disconnect', {}, { apikey: cfg.publishableKey, authorization: `Bearer ${member.jwt}` });
        log('disconnect', { unsubscribe: unsub, ok: r.ok });
        return json(r.ok ? 200 : 503, { code: r.ok ? 'DISCONNECTED' : 'DISCONNECT_FAILED', unsubscribe: unsub });
      }

      // route === 'connect'
      const code = str(body.code, 2000); const pnid = str(body.phone_number_id, 30); const waba = str(body.waba_id, 30);
      if (!code || !/^[A-Za-z0-9_.#-]+$/.test(code) || !pnid || !DIGITS.test(pnid) || !waba || !DIGITS.test(waba) || 'business_id' in body) return json(400, { code: 'INVALID_REQUEST' });
      // 1. the owner's authorization must exist BEFORE anything is requested from Meta
      const authorized = await service(cfg, deps.fetch, 'internal_wa_has_authorization', { p_business: member.businessId });
      if (!authorized.ok) return json(503, { code: 'STORE_FAILED' });
      if (authorized.data !== true) return json(409, { code: 'AUTHORIZATION_REQUIRED' });
      const record = (status: string, action: string | null, cipher: string | null, last4: string | null) => service(cfg, deps.fetch, 'internal_wa_record_connection', {
        p_business: member.businessId, p_actor: member.userId, p_phone_number_id: pnid, p_waba_id: waba, p_last_four: last4, p_token_ciphertext: cipher, p_status: status, p_action_code: action });
      const setStatus = (status: string, action: string | null) => service(cfg, deps.fetch, 'internal_wa_set_connection_status', { p_business: member.businessId, p_status: status, p_action_code: action });
      // 2. Meta's code exchange and a check that the chosen number is accessible
      const ex = await graph(deps.fetch, `${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code })}`, null, 'GET');
      const token = typeof ex.data?.access_token === 'string' ? ex.data.access_token : null;
      if (!token) { await record('ACTION_REQUIRED', 'AUTHORIZATION_FAILED', null, null); return json(502, { code: 'AUTHORIZATION_FAILED', detail: ex.code }); }
      const phone = await graph(deps.fetch, `${GRAPH}/${pnid}?fields=display_phone_number`, token, 'GET');
      const digits = String(phone.data?.display_phone_number ?? '').replace(/\D/g, '');
      const last4 = digits.length >= 4 ? digits.slice(-4) : null;
      if (phone.code !== 'OK') { await record('ACTION_REQUIRED', 'NUMBER_NOT_ACCESSIBLE', null, null); return json(502, { code: 'NUMBER_NOT_ACCESSIBLE', detail: phone.code }); }
      // 3. the verified mapping (and encrypted token) is saved BEFORE webhooks or history can arrive
      const rec = await record('CONNECTING', null, await encryptToken(cfg.tokenKey, token), last4);
      if (!rec.ok) return json(rec.status === 400 || rec.status === 409 ? 409 : 503, { code: 'CONNECTION_NOT_RECORDED' });
      // 4. webhooks, then the one-time contact and history sync requests
      const sub = await graph(deps.fetch, `${GRAPH}/${waba}/subscribed_apps`, token, 'POST');
      if (sub.code !== 'OK') { await setStatus('ACTION_REQUIRED', 'WEBHOOK_SUBSCRIPTION_FAILED'); return json(502, { code: 'WEBHOOK_SUBSCRIPTION_FAILED', detail: sub.code }); }
      const contacts = await graph(deps.fetch, `${GRAPH}/${pnid}/smb_app_data`, token, 'POST', { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' });
      const history = await graph(deps.fetch, `${GRAPH}/${pnid}/smb_app_data`, token, 'POST', { messaging_product: 'whatsapp', sync_type: 'history' });
      // Meta reports an ineligible number (e.g. country or app version) as an error on these calls.
      if (history.code !== 'OK') {
        const action = `HISTORY_SYNC_${history.code}`.slice(0, 64);
        await setStatus('ACTION_REQUIRED', action);
        log('connect', { status: 'ACTION_REQUIRED', contacts: contacts.code, history: history.code });
        return json(200, { code: 'ACTION_REQUIRED', action_code: action, contacts_sync: contacts.code, history_sync: history.code });
      }
      const marked = await service(cfg, deps.fetch, 'internal_wa_mark_history_requested', { p_business: member.businessId });
      const status = typeof marked.data === 'string' ? marked.data : 'SYNCING';
      log('connect', { status, contacts: contacts.code, history: history.code });
      return json(200, { code: status, contacts_sync: contacts.code, history_sync: history.code });
    } catch {
      log('request.error');
      return json(500, { code: 'INTERNAL_ERROR' });
    }
  };
}

/** One worker pass: import chats → cases, plan sends, send what the database releases (no retries). */
export async function runWorker(cfg: WaIntConfig, f: typeof fetch, log: (e: string, x?: Record<string, string | number | boolean | null>) => void) {
  let imported = 0; let lateApplied = 0; let accepted = 0; let failed = 0; let unknown = 0;
  const biz = await service(cfg, f, 'internal_wa_active_businesses', {});
  for (const b of arr(biz.data)) {
    if (typeof b !== 'string' || !UUID.test(b)) continue;
    const r = await service(cfg, f, 'internal_wa_import_cases', { p_business: b, p_limit: 5 });
    imported += Number(r.data) || 0;
    const late = await service(cfg, f, 'internal_wa_apply_late_history', { p_business: b });
    lateApplied += Number(late.data) || 0;
  }
  const planned = Number((await service(cfg, f, 'internal_wa_plan_sends', {})).data) || 0;
  const claim = await service(cfg, f, 'internal_wa_claim_sends', { p_limit: 10 });
  for (const s of arr(claim.data).map(obj)) {
    const id = String(s.send_id);
    const token = typeof s.token === 'string' ? await decryptToken(cfg.tokenKey, s.token) : null;
    if (!token) { await finish(cfg, f, id, 'FAILED', null, 'NO_CREDENTIAL'); failed++; continue; }
    const message = s.kind === 'REOPEN_TEMPLATE'
      ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: s.to, type: 'template', template: { name: s.template_name, language: { code: s.template_lang } } }
      : { messaging_product: 'whatsapp', recipient_type: 'individual', to: s.to, type: 'text', text: { body: s.body, preview_url: false } };
    const r = await graph(f, `${GRAPH}/${s.phone_number_id}/messages`, token, 'POST', message);
    const wamid = str(obj(arr(r.data?.messages)[0]).id);
    if (wamid) { await finish(cfg, f, id, 'ACCEPTED', wamid, null); accepted++; continue; }
    // 4xx with a Meta error: definitively refused. Anything else may have been accepted: hold for reconciliation.
    if (r.status >= 400 && r.status < 500) {
      await finish(cfg, f, id, 'FAILED', null, r.code); failed++;
      if (r.code === 'META_190' || r.status === 401) await service(cfg, f, 'internal_wa_set_connection_status', { p_business: s.business_id, p_status: 'ACTION_REQUIRED', p_action_code: 'TOKEN_REVOKED' });
    } else { await finish(cfg, f, id, 'UNKNOWN', null, r.code); unknown++; }
  }
  log('worker.pass', { imported, lateApplied, planned, accepted, failed, unknown });
  return { imported, lateApplied, planned, accepted, failed, unknown };
}
const finish = (cfg: WaIntConfig, f: typeof fetch, id: string, outcome: string, wamid: string | null, detail: string | null) =>
  service(cfg, f, 'internal_wa_finish_send', { p_send_id: id, p_outcome: outcome, p_wamid: wamid, p_detail: detail ? detail.replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 80) : null });

// ---------------------------------------------------------------- the business member (from the session, never the request)
async function authenticateMember(req: Request, cfg: WaIntConfig, f: typeof fetch): Promise<{ ok: true; jwt: string; userId: string; businessId: string } | { ok: false; status: number; code: string }> {
  const m = /^Bearer ([^\s]+)$/.exec(req.headers.get('authorization') ?? '');
  const jwt = m && !m[1].startsWith('sb_') && JWT_SHAPE.test(m[1]) ? m[1] : null;
  if (!jwt) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
  const headers = { apikey: cfg.publishableKey, authorization: `Bearer ${jwt}` };
  try {
    const u = await f(`${cfg.supabaseUrl}/auth/v1/user`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!u.ok) return { ok: false, status: u.status >= 500 ? 503 : 401, code: u.status >= 500 ? 'AUTH_UNAVAILABLE' : 'UNAUTHENTICATED' };
    const user = obj(await u.json());
    const who = await rest(cfg, f, 'whoami', {}, headers);
    const w = obj(who.data);
    if (!who.ok || w.user_id !== user.id || w.role !== 'CLIENT' || typeof w.business_id !== 'string' || !UUID.test(w.business_id)) return { ok: false, status: 403, code: 'FORBIDDEN' };
    return { ok: true, jwt, userId: String(user.id), businessId: w.business_id };
  } catch { return { ok: false, status: 503, code: 'AUTH_UNAVAILABLE' }; }
}

async function readSmallJson(req: Request): Promise<Obj | null> {
  if ((req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return null;
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > 4096) return null;
  try { const v = JSON.parse(new TextDecoder().decode(raw)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** A Graph call: short code (OK | META_<code> | HTTP_<status> | NETWORK), HTTP status (0 when unknown), parsed body. Never Meta's text or the token. */
async function graph(f: typeof fetch, url: string, token: string | null, method: 'GET' | 'POST' | 'DELETE', body?: unknown) {
  try {
    const res = await f(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data: Obj | null = null;
    try { data = obj(await res.json()); } catch { /* not JSON */ }
    if (res.ok) return { code: 'OK', status: res.status, data };
    const mc = obj(data?.error).code;
    return { code: typeof mc === 'number' ? `META_${mc}` : `HTTP_${res.status}`, status: res.status, data: null };
  } catch { return { code: 'NETWORK', status: 0, data: null }; }
}

async function rest(cfg: WaIntConfig, f: typeof fetch, fn: string, args: unknown, headers: Record<string, string>) {
  try {
    const res = await f(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}
const service = (cfg: WaIntConfig, f: typeof fetch, fn: string, args: unknown) => rest(cfg, f, fn, args,
  cfg.serviceKey.startsWith('sb_secret_') ? { apikey: cfg.serviceKey } : { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}` });

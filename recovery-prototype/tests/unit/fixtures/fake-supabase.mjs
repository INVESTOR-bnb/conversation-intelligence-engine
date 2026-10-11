// Test-only preload (node --import) for storage-live-check.mjs. Replaces fetch
// with an in-process fake of the Supabase endpoints the script calls, and makes
// every real network connection throw, so no request can leave the machine.
// Each request is appended to FAKE_SUPABASE_LOG as one JSON line.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const LOG = process.env.FAKE_SUPABASE_LOG;
const SCENARIO = process.env.FAKE_SUPABASE_SCENARIO ?? 'all-refused';
const log = (entry) => fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);

const block = (name) => function blocked() { log({ network: name }); throw new Error(`real network blocked by test: ${name}`); };
net.connect = net.createConnection = block('net.connect');
net.Socket.prototype.connect = block('net.Socket.connect');
tls.connect = block('tls.connect');
http.request = http.get = block('http.request');
https.request = https.get = block('https.request');

const USERS = {
  'client-a@synthetic.invalid': { role: 'CLIENT', business_id: '10000000-0000-4000-8000-00000000000a' },
  'client-b@synthetic.invalid': { role: 'CLIENT', business_id: SCENARIO === 'same-business' ? '10000000-0000-4000-8000-00000000000a' : '10000000-0000-4000-8000-00000000000b' },
  'founder@synthetic.invalid': { role: 'FOUNDER' },
};
const tokens = new Map(); // fake access token -> email
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  const method = (init.method ?? input.method ?? 'GET').toUpperCase();
  const auth = new Headers(init.headers ?? input.headers).get('authorization') ?? '';
  const who = tokens.get(auth.replace(/^Bearer /i, ''));
  const entry = { host: url.host, method, path: url.pathname, as: who ?? null };

  if (url.pathname === '/auth/v1/token') {
    const { email } = JSON.parse(init.body);
    log({ ...entry, signIn: email });
    if (SCENARIO === 'b-sign-in-fails' && email === 'client-b@synthetic.invalid') return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    const n = tokens.size + 1;
    const token = `fake-access-token-${n}`;
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
  log(entry);
  if (url.pathname === '/rest/v1/rpc/whoami') return json(200, USERS[who] ?? { role: 'NONE' });
  if (url.pathname === '/rest/v1/rpc/client_create_case') {
    // Never answers, like a stalled request (the timer keeps the process alive as an open socket would); the test interrupts here.
    if (SCENARIO === 'hang') return new Promise(() => { setInterval(() => {}, 1000); });
    if (SCENARIO === 'create-fails') return json(400, { code: 'P0001', message: 'synthetic refusal' });
    return json(200, crypto.randomUUID());
  }
  return json(400, { statusCode: '400', error: 'synthetic', message: 'synthetic refusal' });
};

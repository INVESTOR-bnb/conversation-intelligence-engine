// Stage 2A-5d-4b — a local stand-in for the parts of Supabase's HTTP API the
// analyze-case function uses: Auth (/auth/v1/user), PostgREST (the exact table
// reads and four RPCs) and Storage (authenticated object download). Every
// database operation runs in the REAL local database as the caller's role with
// the caller's claims (tests/pipeline/psqlDb.ts), so RLS, grants and the
// analysis contract decide, as on Supabase. Synthetic data only; 127.0.0.1 only.
//
// Credentials: test-issued JWT-shaped tokens (one per synthetic user), a
// publishable key, a new-style secret key (the gateway is simulated as minting
// {"role": "service_role"} claims — or not, to rehearse the unverified case) and a
// legacy service_role JWT. Every request is recorded with the credential it used.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { sql, type As } from './psqlDb';

export const PUBLISHABLE = 'sb_publishable_TESTONLY_local_fake_key_1234';
export const SECRET = 'sb_secret_TESTONLY_local_fake_key_5678';
export const LEGACY_SERVICE = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.TESTONLYsignature000';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TABLES = ['contact_restrictions', 'analyses', 'case_messages', 'case_screenshots'];
const RPCS: Record<string, 'uuid' | 'jsonb' | 'void'> = {
  founder_start_analysis: 'uuid', founder_abandon_analysis: 'void', internal_complete_analysis: 'void', whoami: 'jsonb',
};

export interface RequestRecord { method: string; path: string; cred: string }

export class FakeSupabase {
  server!: Server;
  url = '';
  tokens = new Map<string, string>();
  storage = new Map<string, Uint8Array>();
  requests: RequestRecord[] = [];
  /** What the simulated gateway puts in the claims for a secret-key request (null: no role claim). */
  secretKeyClaims: Record<string, unknown> | null = { role: 'service_role' };
  authDown = false;
  failRpc = new Set<string>();
  /** Called with each request path before it is served (to change state mid-run). */
  beforeHandle: ((path: string) => void) | null = null;
  /** Delay (ms) before serving storage downloads (to hold an analysis PENDING). */
  storageDelayMs = 0;

  async start() {
    this.server = createServer((req, res) => { this.handle(req, res).catch(() => this.send(res, 500, { message: 'fake server error' })); });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    this.url = `http://127.0.0.1:${addr.port}`;
  }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }

  /** A JWT-shaped token for a synthetic user (validated only by this fake Auth). */
  tokenFor(userId: string): string {
    const t = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ sub: userId, role: 'authenticated', iat: 1 })}.${randomBytes(24).toString('base64url')}`;
    this.tokens.set(t, userId);
    return t;
  }

  private send(res: ServerResponse, status: number, body: unknown, raw?: Uint8Array) {
    if (raw) { res.writeHead(status, { 'content-type': 'image/png', 'content-length': String(raw.length) }); res.end(raw); return; }
    if (status === 204) { res.writeHead(204); res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /** The caller, as the gateway would resolve it. */
  private caller(req: IncomingMessage): { as: As; cred: string } | null {
    const apikey = req.headers.apikey;
    const auth = req.headers.authorization;
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (apikey === PUBLISHABLE) {
      if (bearer === null) return { as: { role: 'anon' }, cred: 'anon' };
      const sub = this.tokens.get(bearer);
      return sub ? { as: { role: 'authenticated', sub }, cred: `user:${sub}` } : null;
    }
    if (apikey === SECRET && bearer === null) {
      return { as: { role: 'service_role', claims: this.secretKeyClaims ?? {} }, cred: 'service:secret' };
    }
    if (apikey === LEGACY_SERVICE && bearer === LEGACY_SERVICE) return { as: { role: 'service_role' }, cred: 'service:legacy' };
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://x');
    const who = this.caller(req);
    this.requests.push({ method: req.method ?? '', path: u.pathname, cred: who?.cred ?? 'invalid' });
    this.beforeHandle?.(u.pathname);
    if (!who) return this.send(res, 401, { message: 'Invalid API key or JWT' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');

    if (req.method === 'GET' && u.pathname === '/auth/v1/user') {
      if (this.authDown) return this.send(res, 500, { message: 'auth down' });
      if (who.as?.role !== 'authenticated') return this.send(res, 401, { message: 'invalid JWT' });
      return this.send(res, 200, { id: who.as.sub, aud: 'authenticated', role: 'authenticated' });
    }

    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(u.pathname);
    if (req.method === 'POST' && rpc) {
      const fn = rpc[1];
      if (!(fn in RPCS)) return this.send(res, 404, { message: 'function not found' });
      if (this.failRpc.has(fn)) return this.send(res, 503, { message: 'unavailable' });
      const args = JSON.parse(body || '{}') as Record<string, unknown>;
      const vars: Record<string, string> = {};
      const parts = Object.entries(args).map(([k, v], i) => {
        if (!/^p_[a-z_]+$/.test(k)) throw new Error('bad arg');
        if (v === null) return `${k} => null`;
        vars[`v${i}`] = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k} => :'v${i}'`;
      });
      try {
        const out = sql(`select public.${fn}(${parts.join(', ')})`, vars, who.as);
        if (RPCS[fn] === 'void') return this.send(res, 204, null);
        if (RPCS[fn] === 'uuid') return this.send(res, 200, out[0]);
        return this.send(res, 200, JSON.parse(out.join('\n')));
      } catch (e) {
        const message = (e as Error).message;
        return this.send(res, /permission denied/i.test(message) ? 403 : 400, { code: 'P0001', message });
      }
    }

    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
    if (req.method === 'GET' && table && TABLES.includes(table[1])) {
      const cols = u.searchParams.get('select') ?? '*';
      if (!/^[a-z_]+(,[a-z_]+)*$/.test(cols)) return this.send(res, 400, { message: 'bad select' });
      const where: string[] = [];
      const vars: Record<string, string> = {};
      let limit = '';
      let i = 0;
      for (const [k, v] of u.searchParams) {
        if (k === 'select') continue;
        if (k === 'limit') { limit = ` limit ${Number(v) | 0}`; continue; }
        if (!/^[a-z_]+$/.test(k)) return this.send(res, 400, { message: 'bad column' });
        if (v === 'is.null') { where.push(`${k} is null`); continue; }
        const eq = /^eq\.(.*)$/.exec(v);
        const inn = /^in\.\((.*)\)$/.exec(v);
        if (eq) { vars[`f${i}`] = eq[1]; where.push(`${k}::text = :'f${i}'`); i++; continue; }
        if (inn) { vars[`f${i}`] = inn[1]; where.push(`${k}::text = any (string_to_array(:'f${i}', ','))`); i++; continue; }
        return this.send(res, 400, { message: 'bad filter' });
      }
      try {
        const out = sql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]') from (select ${cols} from public.${table[1]}${where.length ? ` where ${where.join(' and ')}` : ''}${limit}) t`, vars, who.as);
        return this.send(res, 200, JSON.parse(out.join('\n') || '[]'));
      } catch (e) {
        return this.send(res, /permission denied/i.test((e as Error).message) ? 401 : 400, { message: (e as Error).message });
      }
    }

    const obj = /^\/storage\/v1\/object\/authenticated\/case-screenshots\/(.+)$/.exec(u.pathname);
    if (req.method === 'GET' && obj) {
      if (this.storageDelayMs) await new Promise((r) => setTimeout(r, this.storageDelayMs));
      if (who.as?.role !== 'authenticated') return this.send(res, 400, { statusCode: '403', error: 'Unauthorized' });
      const name = obj[1].split('/').map(decodeURIComponent).join('/');
      // Storage authorises a download with the caller's SELECT policy on storage.objects.
      const visible = sql(`select count(*) from storage.objects where bucket_id = 'case-screenshots' and name = :'n'`, { n: name }, who.as)[0];
      const bytes = this.storage.get(name);
      if (visible !== '1' || !bytes) return this.send(res, 400, { statusCode: '404', error: 'not_found' });
      return this.send(res, 200, null, bytes);
    }
    return this.send(res, 404, { message: 'not found' });
  }
}

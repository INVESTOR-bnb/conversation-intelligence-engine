// A small in-memory imitation of the Supabase Auth + Data API endpoints the
// frontend calls, installed with Playwright request interception. It mirrors
// the server-side rules that matter for the UI: tokens are validated, roles
// come from the server (whoami), founder-only tables return nothing to others.

import type { BrowserContext, Route } from '@playwright/test';

export const MOCK_URL = 'https://mock-project-ref.supabase.co';
export const MOCK_KEY = 'sb_publishable_TEST_ONLY_not_a_real_key';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const makeJwt = (sub: string, email: string, expOffset = 3600) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + expOffset })}.mocksig`;

interface MockUser { id: string; email: string; password: string; role: 'FOUNDER' | 'CLIENT' | 'NONE'; metadata?: object }

export const USERS: Record<string, MockUser> = {
  founder: { id: 'f0000000-0000-4000-8000-000000000001', email: 'founder@synthetic.test', password: 'founder-pass-123', role: 'FOUNDER' },
  // Client whose (user-editable) metadata falsely claims FOUNDER: must be ignored.
  client: { id: 'c0000000-0000-4000-8000-000000000002', email: 'client@synthetic.test', password: 'client-pass-123', role: 'CLIENT', metadata: { role: 'FOUNDER' } },
  invited: { id: 'e0000000-0000-4000-8000-000000000003', email: 'invited@synthetic.test', password: '', role: 'NONE' },
};

export class MockSupabase {
  tokens = new Map<string, string>(); // access token -> user id
  refresh = new Map<string, string>(); // refresh token -> user id
  requests: string[] = [];
  whoamiFails = false;
  private n = 0;

  user(id: string) {
    return Object.values(USERS).find((u) => u.id === id)!;
  }

  issue(userId: string) {
    const u = this.user(userId);
    const access = makeJwt(u.id, u.email);
    const refresh = `rt-${u.id}-${++this.n}`;
    this.tokens.set(access, u.id);
    this.refresh.set(refresh, u.id);
    return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: this.userJson(u) };
  }

  /** Tokens as they would appear in an invitation redirect. */
  inviteFragment(userId: string, type = 'invite') {
    const s = this.issue(userId);
    return `#access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=${type}`;
  }

  private userJson(u: MockUser) {
    return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email' }, user_metadata: u.metadata ?? {}, created_at: new Date().toISOString() };
  }

  async install(context: BrowserContext) {
    await context.route(`${MOCK_URL}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range, x-supabase-api-version' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    this.requests.push(`${req.method()} ${url.pathname}${url.search}`);
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: body === undefined ? '' : JSON.stringify(body) });
    if (req.headers()['apikey'] !== MOCK_KEY) return json(401, { message: 'Invalid API key' });

    const bearer = (req.headers()['authorization'] ?? '').replace(/^Bearer /, '');
    const uid = this.tokens.get(bearer);
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    const p = url.pathname;

    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = Object.values(USERS).find((x) => x.email === body.email);
      if (!u || !u.password || u.password !== body.password) {
        return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      return json(200, this.issue(u.id));
    }
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const id = this.refresh.get(body.refresh_token);
      if (!id) return json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      this.refresh.delete(body.refresh_token);
      return json(200, this.issue(id));
    }
    if (p === '/auth/v1/user' && req.method() === 'GET') {
      if (!uid) return json(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' });
      return json(200, this.userJson(this.user(uid)));
    }
    if (p === '/auth/v1/user' && req.method() === 'PUT') {
      if (!uid) return json(401, { code: 401, error_code: 'no_authorization', msg: 'unauthorized' });
      if (typeof body.password === 'string' && body.password.length < 8) {
        return json(422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters.' });
      }
      this.user(uid).password = body.password;
      return json(200, this.userJson(this.user(uid)));
    }
    if (p === '/auth/v1/logout') {
      if (bearer) this.tokens.delete(bearer);
      return route.fulfill({ status: 204, headers: cors });
    }

    // Data API: anon (no user token) gets nothing.
    if (!uid) return json(401, { code: '42501', message: 'permission denied' });
    const u = this.user(uid);
    if (p === '/rest/v1/rpc/whoami') {
      if (this.whoamiFails) return json(500, { message: 'internal error' });
      if (u.role === 'FOUNDER') return json(200, { user_id: u.id, role: 'FOUNDER' });
      if (u.role === 'CLIENT') return json(200, { user_id: u.id, role: 'CLIENT', business_id: 'b1', business_name: 'Synthetic Autos A', currency: 'NGN' });
      return json(200, { user_id: u.id, role: 'NONE' });
    }
    if (p === '/rest/v1/businesses') {
      // RLS: founders see all businesses; this mock's client has none visible here.
      const rows = u.role === 'FOUNDER' ? [{ name: 'Synthetic Academy B' }, { name: 'Synthetic Autos A' }] : [];
      return json(200, rows, { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
    }
    if (p === '/rest/v1/cases') {
      const total = u.role === 'FOUNDER' ? 3 : 0;
      return json(200, req.method() === 'HEAD' ? undefined : [], { 'content-range': `*/${total}` });
    }
    if (p === '/rest/v1/rpc/client_list_cases') {
      if (u.role !== 'CLIENT') return json(200, []);
      return json(200, [{ id: 'k1', reference: 'P-101', product_service: 'Synthetic Camry', status: 'UNDER_REVIEW', classification: null, approved_message: null }]);
    }
    return json(404, { message: `mock: no handler for ${req.method()} ${p}` });
  }
}

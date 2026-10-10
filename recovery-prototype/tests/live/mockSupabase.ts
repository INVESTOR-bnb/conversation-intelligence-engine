// A small in-memory imitation of the Supabase Auth + Data API endpoints the
// frontend calls, installed with Playwright request interception. It mirrors
// the server-side rules that matter for the UI: tokens are validated, roles
// come from the server (whoami), founder-only tables return nothing to others,
// and the onboarding functions apply the database's checks and error texts.

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
  // Has accepted an invitation and set a password, but is not linked to any business yet.
  pending: { id: 'd0000000-0000-4000-8000-000000000004', email: 'pending@synthetic.test', password: 'pending-pass-123', role: 'NONE' },
};

export class MockSupabase {
  tokens = new Map<string, string>(); // access token -> user id
  refresh = new Map<string, string>(); // refresh token -> user id
  requests: string[] = [];
  whoamiFails = false;
  /** Makes founder_* calls fail: 'server' = HTTP 500, 'network' = connection dropped. */
  failRpc: false | 'server' | 'network' = false;
  businesses: { id: string; name: string; industry: string; currency: string }[] = [
    { id: 'b1', name: 'Synthetic Autos A', industry: 'Automotive', currency: 'NGN' },
    { id: 'b2', name: 'Synthetic Academy B', industry: 'Training', currency: 'NGN' },
  ];
  /** user id -> business id (a client belongs to exactly one business). */
  members = new Map<string, string>([[USERS.client.id, 'b1']]);
  audit: { action: string; business_id: string }[] = [];
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
    if (this.failRpc && p.startsWith('/rest/v1/rpc/founder_')) {
      return this.failRpc === 'network' ? route.abort('failed') : json(500, { code: 'XX000', message: 'internal error' });
    }
    const u = this.user(uid);
    const isFounder = u.role === 'FOUNDER';
    const myBusiness = this.members.get(uid);
    const forbidden = () => json(403, { code: '42501', message: 'FORBIDDEN: founder access required' });
    if (p === '/rest/v1/rpc/whoami') {
      if (this.whoamiFails) return json(500, { message: 'internal error' });
      if (isFounder) return json(200, { user_id: u.id, role: 'FOUNDER' });
      const b = this.businesses.find((x) => x.id === myBusiness);
      if (b) return json(200, { user_id: u.id, role: 'CLIENT', business_id: b.id, business_name: b.name, currency: b.currency });
      return json(200, { user_id: u.id, role: 'NONE' });
    }
    if (p === '/rest/v1/businesses') {
      // RLS: founders see all businesses, a client only its own.
      const rows = this.businesses.filter((b) => isFounder || b.id === myBusiness).sort((a, b) => a.name.localeCompare(b.name));
      return json(200, rows, { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
    }
    if (p === '/rest/v1/business_members') {
      const rows = [...this.members].filter(([user]) => isFounder || user === uid).map(([user_id, business_id]) => ({ user_id, business_id }));
      return json(200, rows);
    }
    if (p === '/rest/v1/cases') {
      const total = isFounder ? 3 : 0;
      return json(200, req.method() === 'HEAD' ? undefined : [], { 'content-range': `*/${total}` });
    }
    if (p === '/rest/v1/rpc/client_list_cases') {
      if (myBusiness !== 'b1') return json(200, []);
      return json(200, [{ id: 'k1', reference: 'P-101', product_service: 'Synthetic Camry', status: 'UNDER_REVIEW', classification: null, approved_message: null }]);
    }
    // The two onboarding functions, with the same checks and error texts as the database.
    if (p === '/rest/v1/rpc/founder_create_business') {
      if (!isFounder) return forbidden();
      const name = String(body.p_name ?? '').trim();
      const industry = String(body.p_industry ?? '').trim();
      const currency = String(body.p_currency ?? 'NGN').trim().toUpperCase();
      if (name.length < 1 || name.length > 120 || industry.length > 120 || !/^[A-Z]{3}$/.test(currency)) {
        return json(400, { code: '23514', message: 'new row for relation "businesses" violates check constraint "businesses_name_check"' });
      }
      const id = `b${this.businesses.length + 1}-${++this.n}`;
      this.businesses.push({ id, name, industry, currency });
      this.audit.push({ action: 'BUSINESS_CREATED', business_id: id });
      return json(200, id);
    }
    if (p === '/rest/v1/rpc/founder_add_member') {
      if (!isFounder) return forbidden();
      const { p_business_id: bid, p_user_id: target } = body as { p_business_id: string; p_user_id: string };
      if (!this.businesses.some((b) => b.id === bid)) return json(404, { code: 'P0002', message: 'NOT_FOUND: business not found' });
      const t = Object.values(USERS).find((x) => x.id === target);
      if (!t) return json(404, { code: 'P0002', message: 'NOT_FOUND: user not found' });
      if (t.role === 'FOUNDER') return json(400, { code: 'P0001', message: 'VALIDATION: a founder cannot be a client member' });
      if (this.members.has(target)) return json(400, { code: 'P0001', message: 'VALIDATION: user already belongs to a business' });
      this.members.set(target, bid);
      this.audit.push({ action: 'MEMBER_ADDED', business_id: bid });
      return route.fulfill({ status: 204, headers: cors });
    }
    return json(404, { message: `mock: no handler for ${req.method()} ${p}` });
  }
}

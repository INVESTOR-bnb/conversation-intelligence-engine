// A small in-memory imitation of the Supabase Auth + Data API endpoints the
// frontend calls, installed with Playwright request interception. It mirrors
// the server-side rules that matter for the UI: tokens are validated, roles
// come from the server (whoami), founder-only tables return nothing to others,
// and the onboarding functions apply the database's checks and error texts.

import type { BrowserContext, Route } from '@playwright/test';

export const MOCK_URL = 'https://mock-project-ref.supabase.co';
export const MOCK_KEY = 'sb_publishable_TEST_ONLY_not_a_real_key';
export const B1 = '10000000-0000-4000-8000-0000000000b1';
export const B2 = '10000000-0000-4000-8000-0000000000b2';
export const SHOT_BUCKET = 'case-screenshots';
const SHOT_NAME = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/(10|[1-9])-([0-9a-f]{64})\.(png|jpg)$/;

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
  authDelayMs = Number(process.env.MOCK_AUTH_DELAY_MS ?? 200);
  /** Makes founder_* calls fail: 'server' = HTTP 500, 'network' = connection dropped. */
  failRpc: false | 'server' | 'network' = false;
  dailyLimit = 20;
  businesses: { id: string; name: string; industry: string; currency: string }[] = [
    { id: B1, name: 'Synthetic Autos A', industry: 'Automotive', currency: 'NGN' },
    { id: B2, name: 'Synthetic Academy B', industry: 'Training', currency: 'NGN' },
  ];
  /** user id -> business id (a client belongs to exactly one business). */
  members = new Map<string, string>([[USERS.client.id, B1]]);
  audit: { action: string; business_id: string }[] = [];
  /** Makes client_submit_case fail once: 'server' = HTTP 500, 'lost' = succeeds on the server but the response is lost. */
  failSubmit: false | 'server' | 'lost' = false;
  /** Makes client_create_case fail once after storing the case (response lost). */
  loseCreateResponse = false;
  cases: MockCase[] = [
    mockCase('a0000000-0000-4000-8000-000000000101', B1, 'P-101', 'Synthetic Camry', 'SUBMITTED', 'Prospect: Is the Camry available?\nBusiness: Yes, synthetic.'),
    mockCase('a0000000-0000-4000-8000-000000000102', B1, 'P-102', 'Synthetic Hilux', 'AWAITING_ADMIN_REVIEW', 'Prospect: Price of the Hilux?\nBusiness: Synthetic price.', 'CONTACT_RESTRICTION'),
    mockCase('a0000000-0000-4000-8000-000000000201', B2, 'C-201', 'Synthetic Course', 'SUBMITTED', 'Prospect: When does the course start?'),
  ];
  /** analyses rows (founder-only, like public.analyses RLS). */
  analyses: (Record<string, unknown> & { case_id: string; version: number })[] = [];
  /** contact_restrictions rows (founder-only). */
  restrictions: { id: string; case_id: string; kind: string; source: string; status: string; note: string | null; created_at: string }[] = [];
  /** Stored files: name -> record (what Supabase Storage keeps). */
  objects = new Map<string, { owner: string; size: number; mime: string; bytes: Buffer }>();
  /** case_screenshots rows. */
  shotRows: { case_id: string; business_id: string; position: number; storage_path: string; mime_type: string; size_bytes: number; sha256: string; file_deleted_at: string | null }[] = [];
  /** Upload failure injection by position: 'server' (nothing stored) or 'lost' (stored, response lost). Used once. */
  failUpload = new Map<number, 'server' | 'lost'>();
  /** Loses the response of the next client_finalize_screenshots (after it ran). */
  loseFinalizeResponse = false;
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
    const p = url.pathname;
    const body = p.startsWith('/storage/') ? {} : req.postData() ? JSON.parse(req.postData()!) : {};

    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      // Real Supabase Auth takes a few hundred ms. A realistic delay makes tests
      // that navigate before sign-in has finished fail every time, not only on
      // slower CI runners (override with MOCK_AUTH_DELAY_MS).
      if (this.authDelayMs > 0) await new Promise((r) => setTimeout(r, this.authDelayMs));
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
      // RLS since 2A-4b: case tables are founder-only; clients get no rows.
      if (!isFounder) return json(200, []);
      let rows = this.cases.filter((c) => filterMatches(url, 'id', c.id) && filterMatches(url, 'workflow_state', c.workflow_state));
      rows = rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const withBiz = rows.map((c) => {
        const b = this.businesses.find((x) => x.id === c.business_id);
        const { conversation: _c, idempotency_key: _k, ...row } = c;
        return { ...row, businesses: b ? { name: b.name, currency: b.currency } : null };
      });
      return json(200, withBiz, { 'content-range': `0-${Math.max(withBiz.length - 1, 0)}/${withBiz.length}` });
    }
    if (p === '/rest/v1/case_messages') {
      if (!isFounder) return json(200, []);
      const rows = this.cases.filter((c) => filterMatches(url, 'case_id', c.id)).map((c) => ({ id: messageId(c.id), case_id: c.id, kind: 'PASTED_CONVERSATION', body: c.conversation }));
      return json(200, rows);
    }
    // Founder-only intelligence (RLS): clients and members get no rows; nobody can write through the API.
    if (p === '/rest/v1/analyses' || p === '/rest/v1/contact_restrictions') {
      if (req.method() !== 'GET') return json(403, { code: '42501', message: `permission denied for table ${p.split('/').pop()}` });
      if (!isFounder) return json(200, []);
      const source = p === '/rest/v1/analyses' ? this.analyses : this.restrictions;
      const rows = source.filter((r) => filterMatches(url, 'case_id', r.case_id))
        .sort((a, b) => ('version' in a ? Number(b.version) - Number(a.version) : String(a.created_at).localeCompare(String(b.created_at))))
        .map(({ case_id: _c, ...r }) => r);
      return json(200, rows);
    }
    if (p === '/rest/v1/rpc/client_list_cases') {
      if (!myBusiness) return json(200, []);
      return json(200, this.cases.filter((c) => c.business_id === myBusiness).map((c) => ({
        id: c.id, reference: c.reference, product_service: c.product_service, status: clientStatus(c.workflow_state),
        classification: null, deal_situation: null, next_action: null, approved_message: null,
      })));
    }
    if (p === '/rest/v1/rpc/client_create_case') {
      if (!myBusiness) return json(403, { code: '42501', message: 'FORBIDDEN: client access required' });
      const b = body as Record<string, unknown>;
      const existing = this.cases.find((c) => c.business_id === myBusiness && c.idempotency_key === b.p_idempotency_key);
      if (existing) return json(200, existing.id);
      const source = b.p_conversation_source === 'SCREENSHOTS' ? 'SCREENSHOTS' : 'TEXT';
      const text = String(b.p_conversation_text ?? '').trim();
      if (source === 'TEXT' && text.length < 20) return json(400, { code: 'P0001', message: 'VALIDATION: pasted conversation is too short' });
      if (this.cases.filter((c) => c.business_id === myBusiness).length >= this.dailyLimit) return json(400, { code: 'P0001', message: 'RATE_LIMITED: daily case limit reached' });
      const c = mockCase(`a0000000-0000-4000-8000-${String(900000000000 + ++this.n)}`, myBusiness, String(b.p_reference), String(b.p_product_service), 'DRAFT', text);
      Object.assign(c, { conversation_source: source, idempotency_key: String(b.p_idempotency_key), lead_source: b.p_lead_source, estimated_value: b.p_estimated_value ?? null,
        last_interaction_date: b.p_last_interaction_date ?? null, client_context: b.p_client_context ?? null, evidence_version: 0, queued_at: null });
      this.cases.push(c);
      this.audit.push({ action: 'CASE_CREATED', business_id: myBusiness });
      if (this.loseCreateResponse) { this.loseCreateResponse = false; return route.abort('failed'); }
      return json(200, c.id);
    }
    if (p === '/rest/v1/rpc/client_submit_case') {
      const c = this.cases.find((x) => x.id === body.p_case_id && x.business_id === myBusiness);
      if (!myBusiness || !c) return json(404, { code: 'P0002', message: 'NOT_FOUND: case not found' });
      if (this.failSubmit === 'server') { this.failSubmit = false; return json(500, { code: 'XX000', message: 'internal error' }); }
      if (c.workflow_state !== 'DRAFT') return json(400, { code: 'P0001', message: 'INVALID_STATE: only draft cases can be submitted' });
      const shotCount = this.shotRows.filter((r) => r.case_id === c.id).length;
      if (c.conversation_source === 'SCREENSHOTS' && (shotCount < 1 || shotCount > 10)) return json(400, { code: 'P0001', message: 'VALIDATION: between 1 and 10 screenshots are required' });
      Object.assign(c, { workflow_state: 'SUBMITTED', evidence_version: c.evidence_version + 1, queued_at: new Date().toISOString() });
      this.audit.push({ action: 'CASE_SUBMITTED', business_id: c.business_id });
      if (this.failSubmit === 'lost') { this.failSubmit = false; return route.abort('failed'); }
      return route.fulfill({ status: 204, headers: cors });
    }
    // ---- Stage 2A-4c: Storage (same rules as the storage.objects policies) and the two functions.
    const rls = () => json(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    if (p.startsWith(`/storage/v1/object/${SHOT_BUCKET}/`)) {
      const name = decodeURIComponent(p.slice(`/storage/v1/object/${SHOT_BUCKET}/`.length));
      if (req.method() === 'GET') {
        const o = this.objects.get(name);
        if (!isFounder || !o) return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': o.mime }, body: o.bytes });
      }
      if (req.method() !== 'POST' || req.headers()['x-upsert'] === 'true') return rls();
      const m = SHOT_NAME.exec(name);
      const c = m && this.cases.find((x) => x.id === m[2] && x.business_id === m[1]);
      const prefix = m ? `${m[1]}/${m[2]}/` : '';
      const used = (pos: string) => [...this.objects.keys()].some((k) => k.startsWith(`${prefix}${pos}-`));
      if (!m || m[1] !== myBusiness || !c || c.workflow_state !== 'DRAFT' || c.conversation_source !== 'SCREENSHOTS' || used(m[3])
          || [...this.objects.keys()].filter((k) => k.startsWith(prefix)).length >= 10) return rls();
      const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
      const mime = (req.headers()['content-type'] ?? '').split(';')[0];
      if (bytes.length > 5 * 1024 * 1024) return json(400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
      if (!['image/png', 'image/jpeg'].includes(mime)) return json(400, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${mime} is not supported` });
      const fail = this.failUpload.get(Number(m[3]));
      if (fail) this.failUpload.delete(Number(m[3]));
      if (fail === 'server') return json(500, { statusCode: '500', error: 'internal', message: 'internal error' });
      this.objects.set(name, { owner: uid, size: bytes.length, mime, bytes });
      if (fail === 'lost') return route.abort('failed');
      return json(200, { Key: `${SHOT_BUCKET}/${name}`, Id: name });
    }
    const ownCase = (id: unknown) => this.cases.find((x) => x.id === id && x.business_id === myBusiness);
    const filesOf = (c: MockCase) => [...this.objects.entries()].filter(([k]) => k.startsWith(`${c.business_id}/${c.id}/`)).map(([k, o]) => {
      const m = SHOT_NAME.exec(k);
      return { name: k, position: m ? Number(m[3]) : null, sha256: m ? m[4] : null, ext: m ? m[5] : null, ...o };
    });
    if (p === '/rest/v1/rpc/client_screenshot_status') {
      const c = myBusiness ? ownCase(body.p_case_id) : undefined;
      if (!c) return json(404, { code: 'P0002', message: 'NOT_FOUND: case not found' });
      return json(200, { case_id: c.id, source: c.conversation_source, is_draft: c.workflow_state === 'DRAFT',
        files: filesOf(c).map((f) => ({ position: f.position, sha256: f.sha256, size: f.size, mime_type: f.mime, registered: this.shotRows.some((r) => r.storage_path === f.name) })),
        registered_count: this.shotRows.filter((r) => r.case_id === c.id).length });
    }
    if (p === '/rest/v1/rpc/client_finalize_screenshots') {
      const c = myBusiness ? ownCase(body.p_case_id) : undefined;
      const v = (message: string) => json(400, { code: 'P0001', message });
      if (!c) return json(404, { code: 'P0002', message: 'NOT_FOUND: case not found' });
      if (c.workflow_state !== 'DRAFT') return v('INVALID_STATE: only draft cases can take screenshots');
      if (c.conversation_source !== 'SCREENSHOTS') return v('VALIDATION: this case uses pasted text');
      const files = filesOf(c);
      if (!files.length) return v('VALIDATION: no screenshots uploaded');
      const bad = files.filter((f) => !f.position || f.owner !== uid || f.size < 1 || f.size > 5242880 || f.mime !== (f.ext === 'png' ? 'image/png' : 'image/jpeg'));
      if (bad.length) return v(`VALIDATION: screenshot failed checks at positions ${bad.map((f) => f.position ?? '?').join(',')}`);
      const counts = new Map<number, number>();
      files.forEach((f) => counts.set(f.position!, (counts.get(f.position!) ?? 0) + 1));
      const dups = [...counts].filter(([, n]) => n > 1).map(([pos]) => pos).sort((a, b) => a - b);
      if (dups.length) return v(`VALIDATION: conflicting screenshots at positions ${dups.join(',')}`);
      const max = Math.max(...counts.keys());
      const gaps = Array.from({ length: max }, (_, i) => i + 1).filter((pos) => !counts.has(pos));
      if (gaps.length) return v(`VALIDATION: missing screenshots at positions ${gaps.join(',')}`);
      let added = 0;
      for (const f of files) {
        if (this.shotRows.some((r) => r.case_id === c.id && r.position === f.position)) continue;
        this.shotRows.push({ case_id: c.id, business_id: c.business_id, position: f.position!, storage_path: f.name, mime_type: f.mime, size_bytes: f.size, sha256: f.sha256!, file_deleted_at: null });
        added++;
      }
      if (added) this.audit.push({ action: 'SCREENSHOTS_REGISTERED', business_id: c.business_id });
      if (this.loseFinalizeResponse) { this.loseFinalizeResponse = false; return route.abort('failed'); }
      return json(200, { registered: files.length, added });
    }
    if (p === '/rest/v1/case_screenshots') {
      if (!isFounder) return json(200, []);
      const rows = this.shotRows.filter((r) => filterMatches(url, 'case_id', r.case_id)).sort((a, b) => a.position - b.position)
        .map((r, i) => ({ id: `s${i}-${r.position}`, position: r.position, storage_path: r.storage_path, mime_type: r.mime_type, size_bytes: r.size_bytes, file_deleted_at: r.file_deleted_at }));
      return json(200, rows);
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
      const id = `10000000-0000-4000-8000-${String(100000000000 + ++this.n)}`;
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

export interface MockCase {
  id: string; business_id: string; reference: string; product_service: string; lead_source: unknown; estimated_value: unknown;
  last_interaction_date: unknown; client_context: unknown; workflow_state: string; review_reason: string | null; evidence_version: number;
  created_at: string; queued_at: string | null; idempotency_key: string; conversation: string; conversation_source: 'TEXT' | 'SCREENSHOTS';
}

let clock = Date.UTC(2026, 9, 1);
function mockCase(id: string, business_id: string, reference: string, product_service: string, workflow_state: string, conversation: string, review_reason: string | null = null): MockCase {
  clock += 60_000;
  return { id, business_id, reference, product_service, lead_source: 'Referral', estimated_value: null, last_interaction_date: null, client_context: null,
    workflow_state, review_reason, evidence_version: workflow_state === 'DRAFT' ? 0 : 1, created_at: new Date(clock).toISOString(),
    queued_at: workflow_state === 'DRAFT' ? null : new Date(clock).toISOString(), idempotency_key: id, conversation, conversation_source: 'TEXT' };
}

/** The id of a mock case's pasted-conversation message (deterministic). */
export const messageId = (caseId: string) => `b${caseId.slice(1)}`;

/** Same mapping as public.client_list_cases(). */
function clientStatus(state: string) {
  if (state === 'DRAFT') return 'DRAFT';
  if (['SUBMITTED', 'ANALYZING', 'AWAITING_ADMIN_REVIEW', 'PROSPECT_REPLIED', 'REANALYZING'].includes(state)) return 'UNDER_REVIEW';
  if (state === 'CLIENT_ACTION_REQUIRED') return 'ACTION_REQUIRED';
  if (state === 'WAITING_FOR_PROSPECT') return 'WAITING';
  return state;
}

/** Minimal PostgREST filter support: col=eq.X / col=neq.X. */
function filterMatches(url: URL, col: string, value: string) {
  const f = url.searchParams.get(col);
  if (!f) return true;
  if (f.startsWith('eq.')) return value === f.slice(3);
  if (f.startsWith('neq.')) return value !== f.slice(4);
  return true;
}

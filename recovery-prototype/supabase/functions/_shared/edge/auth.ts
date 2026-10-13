// Stage 2A-5d-4b — who is calling, decided in code (not by the platform check).
//
// The platform's verify_jwt check also lets API keys through (publishable or
// secret keys on Authorization or apikey, "for migration compatibility"), so it
// cannot be the gate. This handler:
//   1. requires `Authorization: Bearer <JWT>` shaped like a JWT (three base64url
//      parts) and refuses API keys there;
//   2. asks Supabase Auth to validate it (GET /auth/v1/user): this works for both
//      legacy HS256 and new asymmetric signing keys and rejects revoked sessions;
//   3. asks the database who the caller is (rpc whoami, as the caller): only
//      role FOUNDER passes. The founder role lives in public.founders, not in the
//      token's metadata, so a token alone can never claim it.
// founder_start_analysis checks the founder again; this is defence in depth and
// keeps non-founders from reaching anything else.

const JWT_SHAPE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN = 8192;

export type AuthResult = { ok: true; jwt: string; userId: string } | { ok: false; status: 401 | 403 | 503; code: string };

/** The bearer token, if the header is exactly `Bearer <JWT-shaped token>`. */
export function bearerJwt(header: string | null): string | null {
  if (!header || header.length > MAX_TOKEN + 7) return null;
  const m = /^Bearer ([^\s]+)$/.exec(header);
  if (!m || m[1].startsWith('sb_') || !JWT_SHAPE.test(m[1])) return null;
  return m[1];
}

export async function authenticateFounder(
  req: Request, opts: { supabaseUrl: string; publishableKey: string; fetch: typeof fetch; timeoutMs: number },
): Promise<AuthResult> {
  const jwt = bearerJwt(req.headers.get('authorization'));
  if (!jwt) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
  const headers = { apikey: opts.publishableKey, authorization: `Bearer ${jwt}` };

  let userId: string;
  try {
    const res = await opts.fetch(`${opts.supabaseUrl}/auth/v1/user`, { headers, signal: AbortSignal.timeout(opts.timeoutMs), redirect: 'error' });
    if (res.status === 401 || res.status === 403) { await res.body?.cancel(); return { ok: false, status: 401, code: 'UNAUTHENTICATED' }; }
    if (!res.ok) { await res.body?.cancel(); return { ok: false, status: 503, code: 'AUTH_UNAVAILABLE' }; }
    const user = (await res.json()) as { id?: unknown };
    if (typeof user?.id !== 'string' || !UUID.test(user.id)) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
    userId = user.id;
  } catch {
    return { ok: false, status: 503, code: 'AUTH_UNAVAILABLE' };
  }

  try {
    const res = await opts.fetch(`${opts.supabaseUrl}/rest/v1/rpc/whoami`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(opts.timeoutMs), redirect: 'error',
    });
    if (!res.ok) { await res.body?.cancel(); return { ok: false, status: res.status >= 500 ? 503 : 403, code: res.status >= 500 ? 'AUTH_UNAVAILABLE' : 'FORBIDDEN' }; }
    const me = (await res.json()) as { role?: unknown; user_id?: unknown };
    if (me?.role !== 'FOUNDER' || me?.user_id !== userId) return { ok: false, status: 403, code: 'FORBIDDEN' };
  } catch {
    return { ok: false, status: 503, code: 'AUTH_UNAVAILABLE' };
  }
  return { ok: true, jwt, userId };
}

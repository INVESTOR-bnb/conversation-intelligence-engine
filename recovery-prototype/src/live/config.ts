// Live (Supabase) configuration. Only PUBLIC values may reach the browser:
// the project URL and the publishable/anon key. Anything that looks like a
// secret or service-role key is refused outright, so a misconfigured
// deployment fails closed instead of shipping a privileged credential.

export interface LiveConfig {
  url: string;
  publishableKey: string;
}

export type LiveConfigResult =
  | { status: 'unconfigured' }
  | { status: 'invalid'; reason: string }
  | { status: 'ok'; config: LiveConfig };

interface EnvLike {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Returns a reason string if the key must not be used in a browser, else null. */
export function unsafeKeyReason(key: string): string | null {
  if (/^sb_secret_/i.test(key)) return 'a secret key (sb_secret_…) was supplied; only the publishable key may be used in the browser';
  if (/^sb_publishable_/.test(key)) return null;
  const payload = decodeJwtPayload(key);
  if (payload) {
    if (payload.role === 'anon') return null;
    return `a JWT key with role "${String(payload.role)}" was supplied; only the anon (public) key may be used in the browser`;
  }
  return 'the key is not a recognised publishable (sb_publishable_…) or anon key';
}

export function readLiveConfig(env: EnvLike): LiveConfigResult {
  const url = (env.VITE_SUPABASE_URL ?? '').trim();
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  if (!url && !key) return { status: 'unconfigured' };
  if (!url || !key) return { status: 'invalid', reason: 'both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'invalid', reason: 'VITE_SUPABASE_URL is not a valid URL' };
  }
  if (parsed.protocol !== 'https:') return { status: 'invalid', reason: 'VITE_SUPABASE_URL must use https' };
  if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    return { status: 'invalid', reason: 'VITE_SUPABASE_URL must be the bare project URL (no path)' };
  }
  const reason = unsafeKeyReason(key);
  if (reason) return { status: 'invalid', reason };
  return { status: 'ok', config: { url: parsed.origin, publishableKey: key } };
}

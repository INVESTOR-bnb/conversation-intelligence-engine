// Stage 2A-5d-4b — analyze-case configuration, read from the environment.
//
// Variables provided by the Supabase platform (see docs/stage-2a/STAGE-2A-5D-4B-EDGE-FUNCTION.md):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS (JSON dictionaries, new
//   API keys), SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (legacy keys).
// Variables we set ourselves (Edge Function secrets; names must not start with SUPABASE_):
//   ANALYSIS_PROVIDER        'fake' is the only provider in this stage. Unset: refuse to run.
//   ALLOW_FAKE_PROVIDER      must be exactly 'staging-only' for the fake provider to run.
//   ANALYZE_ALLOWED_ORIGINS  comma-separated browser origins (default: the staging site).
//   ANALYZE_DEADLINE_MS      whole-run deadline (default 110000, clamped to 30000-130000).
//
// Nothing here is ever logged or returned. Any problem yields one fixed code.

/** The only hosted project the fake provider may write to (staging). */
export const STAGING_URL = 'https://aqwdwswpmbnzmkvyuqil.supabase.co';
export const DEFAULT_ALLOWED_ORIGINS = ['https://revenue-recovery-v0.pages.dev'];
/** Local hosts (tests, `supabase functions serve`). http is accepted only for these. */
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', 'kong'];

export interface EdgeConfig {
  supabaseUrl: string;
  publishableKey: string;
  /** New secret key (sb_secret_…, sent on `apikey` only) or legacy service_role JWT (eyJ…, also as Bearer). */
  serviceKey: string;
  provider: 'fake';
  allowedOrigins: string[];
  deadlineMs: number;
}

export type ConfigResult = { ok: true; config: EdgeConfig } | { ok: false; code: 'CONFIG_INVALID' | 'PROVIDER_NOT_CONFIGURED' | 'FAKE_PROVIDER_NOT_ALLOWED' };

function defaultKey(json: string | undefined): string | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    return typeof v?.default === 'string' && v.default.length > 0 ? v.default : null;
  } catch {
    return null;
  }
}

export function isLocalUrl(url: URL): boolean {
  return LOCAL_HOSTS.includes(url.hostname);
}

export function readConfig(env: (name: string) => string | undefined): ConfigResult {
  const rawUrl = env('SUPABASE_URL') ?? '';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: 'CONFIG_INVALID' };
  }
  const local = isLocalUrl(url);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    return { ok: false, code: 'CONFIG_INVALID' };
  }
  const supabaseUrl = url.origin;

  const publishableKey = defaultKey(env('SUPABASE_PUBLISHABLE_KEYS')) ?? env('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = defaultKey(env('SUPABASE_SECRET_KEYS')) ?? env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!/^(sb_publishable_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{20,})$/.test(publishableKey)
      || !/^(sb_secret_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{20,})$/.test(serviceKey)
      || publishableKey === serviceKey) {
    return { ok: false, code: 'CONFIG_INVALID' };
  }

  // No real provider exists in this stage: only the fake, only where it cannot be mistaken for production.
  if (env('ANALYSIS_PROVIDER') !== 'fake') return { ok: false, code: 'PROVIDER_NOT_CONFIGURED' };
  if (env('ALLOW_FAKE_PROVIDER') !== 'staging-only' || !(supabaseUrl === STAGING_URL || local)) {
    return { ok: false, code: 'FAKE_PROVIDER_NOT_ALLOWED' };
  }

  const origins = (env('ANALYZE_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowedOrigins = origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS;
  if (allowedOrigins.some((o) => { try { return new URL(o).origin !== o || o === '*'; } catch { return true; } })) {
    return { ok: false, code: 'CONFIG_INVALID' };
  }
  const d = Number(env('ANALYZE_DEADLINE_MS') ?? '110000');
  const deadlineMs = Number.isFinite(d) ? Math.min(130000, Math.max(30000, Math.trunc(d))) : 110000;

  return { ok: true, config: { supabaseUrl, publishableKey, serviceKey, provider: 'fake', allowedOrigins, deadlineMs } };
}

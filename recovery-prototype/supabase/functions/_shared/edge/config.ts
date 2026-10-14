// Stage 2A-5d-4b — analyze-case configuration, read from the environment.
//
// Variables provided by the Supabase platform (see docs/stage-2a/STAGE-2A-5D-4B-EDGE-FUNCTION.md):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS (JSON dictionaries, new
//   API keys), SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (legacy keys).
// Variables we set ourselves (Edge Function secrets; names must not start with SUPABASE_):
//   ANALYSIS_PROVIDER        'fake' or (Stage 2A-6b) 'anthropic'. Unset or anything else: refuse to run.
//   ALLOW_FAKE_PROVIDER      must be exactly 'staging-only' for the fake provider to run.
//   Stage 2A-6b, only with ANALYSIS_PROVIDER=anthropic (none of these is set anywhere yet):
//   ALLOW_PAID_PROVIDER      must be exactly 'staging-only'; only the staging project or a local host.
//   ANTHROPIC_API_KEY        the provider key (shape-checked only; never logged or returned).
//   ANALYST_MODEL / REVIEWER_MODEL  each must be on the code allowlist (anthropicProvider.ts):
//                            claude-opus-5-5 or claude-sonnet-5-5. No default: an explicit choice.
//   ANTHROPIC_EFFORT         low | medium | high (default medium).
//   Every other ANTHROPIC_* variable the SDK would read by itself (base URL, other
//   credentials, profiles, extra headers, SDK logging) must be UNSET, or the function refuses.
//   ANALYZE_ALLOWED_ORIGINS  comma-separated browser origins (default: the staging site).
//   ANALYZE_DEADLINE_MS      whole-run deadline (default 110000, clamped to 30000-130000).
//
// Nothing here is ever logged or returned. Any problem yields one fixed code.

import { ANTHROPIC_EFFORTS, anthropicModelConfig, type AnthropicEffort } from './anthropicProvider.ts';

/** The only hosted project the fake (and, in Stage 2A-6b, the paid) provider may write to (staging). */
export const STAGING_URL = 'https://aqwdwswpmbnzmkvyuqil.supabase.co';
export const DEFAULT_ALLOWED_ORIGINS = ['https://revenue-recovery-v0.pages.dev'];
/** Local hosts (tests, `supabase functions serve`). http is accepted only for these. */
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', 'kong'];

export interface EdgeConfig {
  supabaseUrl: string;
  publishableKey: string;
  /** New secret key (sb_secret_…, sent on `apikey` only) or legacy service_role JWT (eyJ…, also as Bearer). */
  serviceKey: string;
  provider: 'fake' | 'anthropic';
  /** Only when provider is 'anthropic'. */
  anthropic: { apiKey: string; analystModel: string; reviewerModel: string; effort: AnthropicEffort } | null;
  allowedOrigins: string[];
  deadlineMs: number;
}

export type ConfigCode = 'CONFIG_INVALID' | 'PROVIDER_NOT_CONFIGURED' | 'FAKE_PROVIDER_NOT_ALLOWED' | 'PAID_PROVIDER_NOT_ALLOWED'
  | 'PROVIDER_KEY_INVALID' | 'PROVIDER_ENV_UNSAFE' | 'MODEL_NOT_ALLOWED';
export type ConfigResult = { ok: true; config: EdgeConfig } | { ok: false; code: ConfigCode };

/**
 * Variables the Anthropic SDK reads by itself (found in @anthropic-ai/sdk 0.133.0). The client is
 * built with an explicit key and base URL, but these could still add headers, enable SDK logging
 * (which may print requests) or point at other credentials: any of them set refuses the paid provider.
 */
export const UNSAFE_PROVIDER_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_LOG', 'ANTHROPIC_PROFILE', 'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_SCOPE', 'ANTHROPIC_WORKSPACE_ID', 'ANTHROPIC_ENVIRONMENT_ID', 'ANTHROPIC_ENVIRONMENT_KEY',
  'ANTHROPIC_WORK_ID', 'ANTHROPIC_WORK_SECRET', 'ANTHROPIC_SESSION_ID', 'ANTHROPIC_WEBHOOK_SIGNING_KEY',
] as const;
/** The shape of an Anthropic API key (the value itself is never logged or returned). */
const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

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

  // Only where neither provider can be mistaken for production: the staging project or a local host.
  const provider = env('ANALYSIS_PROVIDER');
  let anthropic: EdgeConfig['anthropic'] = null;
  if (provider === 'fake') {
    if (env('ALLOW_FAKE_PROVIDER') !== 'staging-only' || !(supabaseUrl === STAGING_URL || local)) {
      return { ok: false, code: 'FAKE_PROVIDER_NOT_ALLOWED' };
    }
  } else if (provider === 'anthropic') {
    if (env('ALLOW_PAID_PROVIDER') !== 'staging-only' || !(supabaseUrl === STAGING_URL || local)) {
      return { ok: false, code: 'PAID_PROVIDER_NOT_ALLOWED' };
    }
    if (UNSAFE_PROVIDER_ENV.some((n) => (env(n) ?? '') !== '')) return { ok: false, code: 'PROVIDER_ENV_UNSAFE' };
    const apiKey = env('ANTHROPIC_API_KEY') ?? '';
    if (!ANTHROPIC_KEY.test(apiKey)) return { ok: false, code: 'PROVIDER_KEY_INVALID' };
    const analystModel = env('ANALYST_MODEL') ?? '';
    const reviewerModel = env('REVIEWER_MODEL') ?? '';
    if (!anthropicModelConfig(analystModel) || !anthropicModelConfig(reviewerModel)) return { ok: false, code: 'MODEL_NOT_ALLOWED' };
    const effort = (env('ANTHROPIC_EFFORT') ?? 'medium') as AnthropicEffort;
    if (!ANTHROPIC_EFFORTS.includes(effort)) return { ok: false, code: 'CONFIG_INVALID' };
    anthropic = { apiKey, analystModel, reviewerModel, effort };
  } else {
    return { ok: false, code: 'PROVIDER_NOT_CONFIGURED' };
  }

  const origins = (env('ANALYZE_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowedOrigins = origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS;
  if (allowedOrigins.some((o) => { try { return new URL(o).origin !== o || o === '*'; } catch { return true; } })) {
    return { ok: false, code: 'CONFIG_INVALID' };
  }
  const d = Number(env('ANALYZE_DEADLINE_MS') ?? '110000');
  const deadlineMs = Number.isFinite(d) ? Math.min(130000, Math.max(30000, Math.trunc(d))) : 110000;

  return { ok: true, config: { supabaseUrl, publishableKey, serviceKey, provider, anthropic, allowedOrigins, deadlineMs } };
}

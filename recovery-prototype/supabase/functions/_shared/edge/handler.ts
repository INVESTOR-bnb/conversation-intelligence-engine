// Stage 2A-5d-4b — the analyze-case request handler (runtime-neutral: the Deno
// entry point and the Node tests both call createAnalyzeCaseHandler).
//
// Request:  POST, Content-Type: application/json, body exactly {"case_id": "<uuid>"} (≤ 1 KiB),
//           Authorization: Bearer <the founder's Supabase session JWT>.
// Response: JSON {outcome, code, analysis_id} built only from allowlisted values —
//           never analysis content, evidence, provider/database text or credentials.
//
//   200  the run started; outcome COMPLETED | FAILED | REJECTED (the analysis row
//        records the details, readable by the founder through RLS). Spending refusals
//        (Stage 2A-5d-3b) are FAILED with SPENDING_DISABLED, BUDGET_EXCEEDED, RATE_LIMITED,
//        MODEL_NOT_PRICED, RESERVATION_TOO_LARGE or SPEND_RESERVATION_FAILED: no provider
//        call was made and the lock was released.
//   400 INVALID_JSON / INVALID_REQUEST   401 UNAUTHENTICATED   403 FORBIDDEN / ORIGIN_NOT_ALLOWED
//   404 NOT_FOUND   405 METHOD_NOT_ALLOWED   409 CONTACT_RESTRICTED / INVALID_STATE / INSUFFICIENT_EVIDENCE
//   413 BODY_TOO_LARGE   415 UNSUPPORTED_MEDIA_TYPE
//   503 CONFIG_INVALID / PROVIDER_NOT_CONFIGURED / FAKE_PROVIDER_NOT_ALLOWED / AUTH_UNAVAILABLE /
//       START_FAILED / PRECHECK_FAILED / LOCK_HELD (the analysis stays PENDING: founder_abandon_analysis)
//   500 INTERNAL_ERROR

import { runAnalysisPipeline, type PipelineLogger, type PipelineResult } from '../analysis-pipeline/index.ts';
import { authenticateFounder } from './auth.ts';
import { readConfig, type EdgeConfig } from './config.ts';
import { FAKE_MODEL_CONFIG, FakeAnalysisProvider } from './fakeProvider.ts';
import { founderRest, serviceRest, UUID } from './supabaseRest.ts';

export const MAX_BODY_BYTES = 1024;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OUTCOMES = ['COMPLETED', 'NOT_STARTED', 'FAILED', 'REJECTED', 'LOCK_HELD', 'ERROR'] as const;
const NOT_STARTED_STATUS: Record<string, number> = {
  CONTACT_RESTRICTED: 409, INVALID_STATE: 409, INSUFFICIENT_EVIDENCE: 409, FORBIDDEN: 403, NOT_FOUND: 404,
};

export interface HandlerDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  /** One structured line per event: names, ids and codes only. */
  log: (line: string) => void;
  now?: () => number;
}

type Body = { outcome: (typeof OUTCOMES)[number]; code: string; analysis_id: string | null };

/** The only way a response body is built: unknown values are replaced, nothing else passes. */
export function sanitize(outcome: string, code: string, analysisId: string | null): Body {
  return {
    outcome: (OUTCOMES as readonly string[]).includes(outcome) ? (outcome as Body['outcome']) : 'ERROR',
    code: CODE.test(code) ? code : 'INTERNAL_ERROR',
    analysis_id: analysisId && UUID.test(analysisId) ? analysisId : null,
  };
}

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function respond(status: number, body: Body, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors },
  });
}

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

/** Exactly {"case_id": "<uuid>"}; anything else is INVALID_REQUEST. */
export function parseRequest(text: string): { ok: true; caseId: string } | { ok: false; code: 'INVALID_JSON' | 'INVALID_REQUEST' } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, code: 'INVALID_JSON' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'INVALID_REQUEST' };
  const keys = Object.keys(v);
  const caseId = (v as Record<string, unknown>).case_id;
  if (keys.length !== 1 || keys[0] !== 'case_id' || typeof caseId !== 'string' || !UUID.test(caseId.toLowerCase())) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  return { ok: true, caseId: caseId.toLowerCase() };
}

export function createAnalyzeCaseHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
    try { deps.log(JSON.stringify({ fn: 'analyze-case', event, ...fields })); } catch { /* logging never breaks a request */ }
  };

  return async (req: Request): Promise<Response> => {
    const started = now();
    const origin = req.headers.get('origin');
    let cors: Record<string, string> = {};
    try {
      const cfg = readConfig(deps.env);
      const allowed = cfg.ok ? cfg.config.allowedOrigins : [];
      cors = corsHeaders(origin, allowed);

      if (req.method === 'OPTIONS') {
        return origin && cors['access-control-allow-origin'] ? new Response(null, { status: 204, headers: cors })
          : respond(403, sanitize('NOT_STARTED', 'ORIGIN_NOT_ALLOWED', null), {});
      }
      // Browsers send Origin; only the configured site may call. (Non-browser callers still need a founder JWT.)
      if (origin !== null && !cors['access-control-allow-origin']) {
        return respond(403, sanitize('NOT_STARTED', 'ORIGIN_NOT_ALLOWED', null), {});
      }
      if (req.method !== 'POST') return respond(405, sanitize('NOT_STARTED', 'METHOD_NOT_ALLOWED', null), cors);
      if (!cfg.ok) {
        log('config.refused', { code: cfg.code });
        return respond(503, sanitize('NOT_STARTED', cfg.code, null), cors);
      }
      const config: EdgeConfig = cfg.config;

      const auth = await authenticateFounder(req, { supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey, fetch: deps.fetch, timeoutMs: 10000 });
      if (!auth.ok) {
        log('auth.refused', { code: auth.code });
        return respond(auth.status, sanitize('NOT_STARTED', auth.code, null), cors);
      }

      const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') return respond(415, sanitize('NOT_STARTED', 'UNSUPPORTED_MEDIA_TYPE', null), cors);
      let text: string | null;
      try { text = await readBody(req); } catch { return respond(400, sanitize('NOT_STARTED', 'INVALID_REQUEST', null), cors); }
      if (text === null) return respond(413, sanitize('NOT_STARTED', 'BODY_TOO_LARGE', null), cors);
      const parsed = parseRequest(text);
      if (!parsed.ok) return respond(400, sanitize('NOT_STARTED', parsed.code, null), cors);

      const rest = { supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey, fetch: deps.fetch, timeoutMs: 15000, maxFileBytes: 5_242_880 };
      const logger: PipelineLogger = { event: (name, fields) => log(name, fields ?? {}) };
      const result: PipelineResult = await runAnalysisPipeline(parsed.caseId, {
        founderDb: founderRest(rest, auth.jwt),
        serviceDb: serviceRest(rest, config.serviceKey),
        provider: new FakeAnalysisProvider(),
        logger,
        config: {
          analyst: FAKE_MODEL_CONFIG, reviewer: FAKE_MODEL_CONFIG,
          callTimeoutMs: 45000,
          deadlineMs: Math.max(1000, config.deadlineMs - (now() - started)),
          completionReserveMs: 15000,
          maxScreenshotBytes: 5_242_880,
          now,
        },
      });
      const status = result.outcome === 'NOT_STARTED' ? (NOT_STARTED_STATUS[result.code] ?? 503)
        : result.outcome === 'LOCK_HELD' ? 503 : 200;
      log('request.done', { outcome: result.outcome, code: result.code, analysisId: result.analysisId, ms: now() - started });
      return respond(status, sanitize(result.outcome, result.code, result.analysisId), cors);
    } catch {
      log('request.error', { code: 'INTERNAL_ERROR' });
      return respond(500, sanitize('ERROR', 'INTERNAL_ERROR', null), cors);
    }
  };
}

// Stage 2A-5d-4b — the pipeline's database and storage adapters over Supabase's
// HTTP APIs (PostgREST, Storage, Auth), using plain fetch (no SDK dependency).
//
//   founderRest(jwt)  every call carries the FOUNDER's own JWT: PostgREST runs it as
//                     `authenticated` with that user's claims, so RLS and function
//                     grants decide. Used for reads, the lock, Storage downloads.
//   serviceRest(key)  the service credential, used for exactly one call:
//                     rpc/internal_complete_analysis. Nothing else accepts it.
//
// Ids are validated before they reach a URL; every request has a timeout; a
// response body is never logged, and errors become DbError codes only.

import {
  DbError, type AnalysisRecord, type CompletionParams, type FounderDb, type MessageRow, type ScreenshotFile, type ServiceDb,
} from '../analysis-pipeline/index.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORAGE_BUCKET = 'case-screenshots';
const MAX_JSON_BYTES = 2_000_000;

export interface RestOptions {
  supabaseUrl: string;
  publishableKey: string;
  fetch: typeof fetch;
  timeoutMs: number;
  /** Largest screenshot downloaded; larger files are refused while streaming. */
  maxFileBytes: number;
}

function uuid(v: string): string {
  if (!UUID.test(v)) throw new DbError('INVALID_ID');
  return v;
}

/** Maps a PostgREST error body ("CODE: detail" messages from private.fail) to a DbError code. */
async function failure(res: Response): Promise<DbError> {
  let message = '';
  try {
    const body = (await res.json()) as { message?: unknown };
    message = typeof body?.message === 'string' ? body.message : '';
  } catch {
    // not JSON
  }
  const m = /^([A-Z][A-Z_]{1,40}):/.exec(message);
  if (m) return new DbError(m[1]);
  if (res.status === 401 || res.status === 403 || /permission denied/i.test(message)) return new DbError('PERMISSION_DENIED');
  return new DbError(`HTTP_${res.status}`);
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel(); return null; }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function json(res: Response): Promise<unknown> {
  const bytes = await readCapped(res, MAX_JSON_BYTES);
  if (!bytes) throw new DbError('RESPONSE_TOO_LARGE');
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DbError('RESPONSE_INVALID');
  }
}

function client(o: RestOptions, headers: Record<string, string>) {
  const base = o.supabaseUrl;
  const send = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> => {
    try {
      return await o.fetch(`${base}${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new DbError('NETWORK_ERROR');
    }
  };
  return {
    async select(table: string, query: string): Promise<Record<string, unknown>[]> {
      const res = await send('GET', `/rest/v1/${table}?${query}`);
      if (!res.ok) throw await failure(res);
      const rows = await json(res);
      if (!Array.isArray(rows)) throw new DbError('RESPONSE_INVALID');
      return rows as Record<string, unknown>[];
    },
    async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
      const res = await send('POST', `/rest/v1/rpc/${fn}`, args);
      if (!res.ok) throw await failure(res);
      if (res.status === 204) return null;
      const text = new TextDecoder().decode((await readCapped(res, MAX_JSON_BYTES)) ?? new Uint8Array());
      if (text === '') return null;
      try { return JSON.parse(text); } catch { throw new DbError('RESPONSE_INVALID'); }
    },
    async download(path: string, max: number): Promise<Uint8Array | null> {
      const res = await send('GET', `/storage/v1/object/authenticated/${STORAGE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`);
      if (!res.ok) { await res.body?.cancel(); return null; }
      return readCapped(res, max);
    },
  };
}

/** The founder-scoped adapter: every request runs as the founder (RLS applies). */
export function founderRest(o: RestOptions, jwt: string): FounderDb {
  const c = client(o, { apikey: o.publishableKey, authorization: `Bearer ${jwt}` });
  return {
    async activeRestrictionCount(caseId) {
      const rows = await c.select('contact_restrictions', `select=id&case_id=eq.${uuid(caseId)}&status=eq.ACTIVE&limit=1`);
      return rows.length;
    },
    async startAnalysis(caseId) {
      const id = await c.rpc('founder_start_analysis', { p_case_id: uuid(caseId) });
      if (typeof id !== 'string' || !UUID.test(id)) throw new DbError('RESPONSE_INVALID');
      return id;
    },
    async getAnalysis(analysisId): Promise<AnalysisRecord | null> {
      const rows = await c.select('analyses', `select=id,case_id,status,evidence_version,evidence_manifest,error&id=eq.${uuid(analysisId)}`);
      const r = rows[0];
      if (!r) return null;
      return {
        id: String(r.id), caseId: String(r.case_id), status: r.status as AnalysisRecord['status'],
        evidenceVersion: Number(r.evidence_version), evidenceManifest: r.evidence_manifest, error: typeof r.error === 'string' ? r.error : null,
      };
    },
    async getMessages(caseId, ids): Promise<MessageRow[]> {
      if (ids.length === 0) return [];
      const rows = await c.select('case_messages', `select=id,kind,body&case_id=eq.${uuid(caseId)}&id=in.(${ids.map(uuid).join(',')})`);
      return rows.map((r) => ({ id: String(r.id), kind: String(r.kind), body: typeof r.body === 'string' ? r.body : '' }));
    },
    async getScreenshotFile(caseId, screenshotId): Promise<ScreenshotFile | null> {
      const rows = await c.select('case_screenshots',
        `select=position,mime_type,storage_path&case_id=eq.${uuid(caseId)}&id=eq.${uuid(screenshotId)}&file_deleted_at=is.null`);
      const r = rows[0];
      if (!r) return null;
      const path = String(r.storage_path);
      // The path must be this case's own object: {business}/{case}/{position}-{sha256}.{png|jpg}
      const m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([1-9]|10)-[0-9a-f]{64}\.(png|jpg)$/.exec(path);
      if (!m || m[2] !== caseId || Number(m[3]) !== Number(r.position)) return null;
      const bytes = await c.download(path, o.maxFileBytes);
      return bytes ? { position: Number(r.position), mimeType: String(r.mime_type), bytes } : null;
    },
    async abandonAnalysis(analysisId) {
      await c.rpc('founder_abandon_analysis', { p_analysis_id: uuid(analysisId) });
    },
  };
}

/** The service adapter: one call, internal_complete_analysis. */
export function serviceRest(o: RestOptions, serviceKey: string): ServiceDb {
  // New secret keys are not JWTs: they go on `apikey` only. A legacy service_role JWT also goes on Authorization.
  const headers: Record<string, string> = serviceKey.startsWith('sb_secret_')
    ? { apikey: serviceKey }
    : { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const c = client(o, headers);
  return {
    async completeAnalysis(p: CompletionParams) {
      await c.rpc('internal_complete_analysis', {
        p_analysis_id: uuid(p.analysisId), p_status: p.status, p_model: p.model, p_prompt_version: p.promptVersion,
        p_output: p.output, p_ai_classification: p.classification, p_ai_proposed_message: p.proposedMessage,
        p_detected_restrictions: p.detectedRestrictions, p_input_tokens: p.inputTokens, p_output_tokens: p.outputTokens,
        p_estimated_cost_usd: p.estimatedCostUsd, p_error: p.error,
      });
    },
  };
}

// Kimi (Moonshot AI) provider adapter — offline: never called live yet.
//
// Plain fetch, no SDK. Endpoints and authentication as given by the founder from the official
// documentation (platform.kimi.ai/docs/api/chat, /docs/api/estimate, /docs/guide/response_format,
// /docs/guide/kimi-k3-quickstart):
//   POST https://api.moonshot.ai/v1/chat/completions             (Authorization: Bearer <key>)
//   POST https://api.moonshot.ai/v1/tokenizers/estimate-token-count -> data.total_tokens
// Behaviour the offline tests cannot prove is marked UNVERIFIED below; the first authorised
// synthetic run must confirm it.
//
// Every request:
//   * model kimi-k3 (the only allowlisted model; never switched), reasoning_effort "low";
//   * max_completion_tokens = the output cap the DATABASE approved, sent explicitly on every call
//     (analyst and reviewer), so the API's large default never applies. max_tokens is deprecated
//     for kimi-k3 and is never sent. UNVERIFIED live that the cap includes reasoning tokens: the
//     pipeline also rejects any reported completion above the cap, and the database disables
//     spending on an overrun;
//   * response_format json_schema with strict: true. Strict schemas require every property, so
//     optional properties are sent as required-and-nullable and the nulls are removed again from
//     the answer before our own validator and the database contract judge it (nothing is weakened);
//   * the system prompt and one user message (text only: the paid provider refuses screenshots);
//   * NO retries (one fetch per call), no streaming, no tools, no n, no fallback model.
//
// The answer: only choices[0].message.content is used. reasoning_content is never read, returned,
// logged or stored. Usage comes from the response only (prompt_tokens, completion_tokens, cache detail);
// anything missing, implausible or inconsistent, or a response for another model, is NOT trusted:
// the call fails with usage unknown and the reservation is HELD (never settled at USD 0).
// Errors carry fixed values only (kind, HTTP status) — never the provider's text, the key or
// conversation data.

import {
  ProviderCallError, type AnalysisProvider, type ModelConfig, type ProviderRequest, type ProviderResponse,
} from '../analysis-pipeline/index.ts';

export const KIMI_API_URL = 'https://api.moonshot.ai';
export const KIMI_MODEL = 'kimi-k3';
export const KIMI_REASONING_EFFORT = 'low';

/**
 * The only allowlisted Kimi model. Prices (USD per million tokens) equal the Stage 2A-6e price
 * row exactly (a test compares them; the pipeline refuses any difference with
 * SPEND_TERMS_MISMATCH): input 3 — the regular and 5-minute cache-write price, applied to ALL
 * prompt_tokens, so no cached-input discount (0.30) is ever taken; output 15, reasoning
 * included. The row is INACTIVE: the database refuses to reserve kimi-k3 (MODEL_NOT_PRICED)
 * until a separately approved paid run activates it. A model whose prices are null here is
 * refused by configuration with MODEL_PRICE_NOT_CONFIGURED.
 * approvedOutputCap: 8,000 tokens — the same cap as the other paid models: room for low-effort
 * reasoning plus an rre-analysis answer (typically 2-4k tokens); the database's cap must equal it.
 * maxOutputTokens: the model's own maximum is UNVERIFIED, so it is set to the approved cap.
 */
export const KIMI_MODELS: Readonly<Record<string, Readonly<{ inputPerMTok: number | null; outputPerMTok: number | null; maxOutputTokens: number; approvedOutputCap: number }>>> = Object.freeze({
  'kimi-k3': Object.freeze({ inputPerMTok: 3, outputPerMTok: 15, maxOutputTokens: 8_000, approvedOutputCap: 8_000 }),
});

/** The pipeline model configuration, or null if the model is not allowlisted or not priced yet. */
export function kimiModelConfig(model: string): ModelConfig | null {
  const m = Object.prototype.hasOwnProperty.call(KIMI_MODELS, model) ? KIMI_MODELS[model] : undefined;
  if (!m || m.inputPerMTok === null || m.outputPerMTok === null) return null;
  return { model, inputPerMTok: m.inputPerMTok, outputPerMTok: m.outputPerMTok, maxOutputTokens: m.maxOutputTokens, approvedOutputCap: m.approvedOutputCap };
}

/** Backstops only: the pipeline aborts each call at its own (shorter) timeout. */
export const CALL_TIMEOUT_MS = 120_000;
const COUNT_TIMEOUT_MS = 10_000;

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The schema as sent in strict mode: every property required; a property that was optional
 * becomes nullable (null added to its type, and to its enum if it has one). Exported for tests.
 */
export function strictSchema(s: Schema): Schema {
  const out: Schema = { ...s };
  if (isObj(s.properties)) {
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => {
      const child = strictSchema(v as Schema);
      if (required.has(k)) return [k, child];
      const types = Array.isArray(child.type) ? (child.type as string[]) : [child.type as string];
      const nullable: Schema = { ...child, type: types.includes('null') ? types : [...types, 'null'] };
      if (Array.isArray(child.enum) && !child.enum.includes(null)) nullable.enum = [...child.enum, null];
      return [k, nullable];
    }));
    out.required = Object.keys(s.properties);
  }
  if (isObj(s.items)) out.items = strictSchema(s.items as Schema);
  return out;
}

/** Removes the nulls strictSchema made possible (only for properties optional in the original schema). Exported for tests. */
export function stripOptionalNulls(value: unknown, s: Schema): unknown {
  if (Array.isArray(value)) return isObj(s.items) ? value.map((x) => stripOptionalNulls(x, s.items as Schema)) : value;
  if (!isObj(value) || !isObj(s.properties)) return value;
  const props = s.properties as Record<string, Schema>;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && k in props && !required.has(k)) continue;
    out[k] = k in props ? stripOptionalNulls(v, props[k]) : v;
  }
  return out;
}

/** The messages of a call: the system prompt and one user turn of text. Images are refused. */
function messages(r: Omit<ProviderRequest, 'signal'>): { role: string; content: string }[] {
  if (r.content.some((p) => p.type !== 'text')) throw new ProviderCallError('OTHER');
  return [{ role: 'system', content: r.system }, { role: 'user', content: r.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n') }];
}

/** The exact chat-completions body for one call (exported for tests). */
export function chatBody(r: Omit<ProviderRequest, 'signal'>): Record<string, unknown> {
  return {
    model: r.model,
    messages: messages(r),
    max_completion_tokens: r.maxOutputTokens,
    reasoning_effort: KIMI_REASONING_EFFORT,
    response_format: { type: 'json_schema', json_schema: { name: r.role === 'ANALYST' ? 'rre_analyst' : 'rre_reviewer', strict: true, schema: strictSchema(r.schema) } },
  };
}

/** The token-estimate body for the same call: the same model and messages (exported for tests). */
export function estimateBody(r: Omit<ProviderRequest, 'signal'>): Record<string, unknown> {
  return { model: r.model, messages: messages(r) };
}

const tokens = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const safeId = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null);
/** finish_reason -> the pipeline's stop reasons ('end_turn' is the only acceptable one). */
const STOPS: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal', tool_calls: 'tool_use' };

/**
 * Turns a chat-completions response into the pipeline's response, or throws ProviderCallError when
 * its usage cannot be trusted as the bill for this request (exported for tests).
 */
export function parseCompletion(raw: unknown, requestedModel: string, schema: Schema): ProviderResponse {
  if (!isObj(raw) || !Array.isArray(raw.choices) || raw.choices.length !== 1 || !isObj(raw.choices[0]) || !isObj(raw.usage)) {
    throw new ProviderCallError('MALFORMED_RESPONSE', null, safeId(isObj(raw) ? raw.id : null));
  }
  const requestId = safeId(raw.id);
  if (raw.model !== requestedModel) throw new ProviderCallError('MODEL_MISMATCH', null, requestId);
  const u = raw.usage;
  const input = tokens(u.prompt_tokens);
  const output = tokens(u.completion_tokens);
  if (input === null || output === null) throw new ProviderCallError('MALFORMED_RESPONSE', null, requestId);
  if (u.total_tokens !== undefined && u.total_tokens !== null && tokens(u.total_tokens) !== input + output) throw new ProviderCallError('MALFORMED_RESPONSE', null, requestId);
  // Context caching (automatic on kimi-k3, 5-minute TTL): prompt_tokens is the TOTAL input;
  // cached_tokens (cache reads) and cache_write_tokens are disjoint parts of it. The ledger bills
  // all prompt_tokens at the input price (USD 3, the regular and cache-write price), so the bill
  // is never understated. Any other shape — invalid values, or more cache tokens than prompt
  // tokens — is not trusted: HELD.
  const pd = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  let cacheTokens = 0;
  for (const v of [pd.cached_tokens, pd.cache_write_tokens]) {
    if (v === undefined || v === null) continue;
    if (tokens(v) === null) throw new ProviderCallError('MALFORMED_RESPONSE', null, requestId);
    cacheTokens += v as number;
  }
  if (cacheTokens > input) throw new ProviderCallError('MALFORMED_RESPONSE', null, requestId);
  const reasoning = isObj(u.completion_tokens_details) ? u.completion_tokens_details.reasoning_tokens : undefined;
  if (reasoning !== undefined && reasoning !== null && (tokens(reasoning) === null || (reasoning as number) > output)) throw new ProviderCallError('MALFORMED_RESPONSE', null, requestId);
  const choice = raw.choices[0] as Record<string, unknown>;
  const message = isObj(choice.message) ? choice.message : {};
  const content = typeof message.content === 'string' ? message.content : '';
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'missing';
  // Only the final answer: reasoning_content (if any) is deliberately ignored.
  let text = content;
  try { text = JSON.stringify(stripOptionalNulls(JSON.parse(content), schema)); } catch { /* not JSON: the pipeline rejects it as INVALID_JSON */ }
  return { text, stopReason: STOPS[finish] ?? finish, inputTokens: input, outputTokens: output, ...(requestId ? { requestId } : {}) };
}

/** Maps a fetch failure to fixed values only. */
function classifyFetchError(e: unknown, signal: AbortSignal): ProviderCallError {
  if (signal.aborted) return new ProviderCallError('ABORTED');
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return new ProviderCallError('TIMEOUT');
  return new ProviderCallError('CONNECTION');
}

export interface KimiOptions {
  apiKey: string;
  fetch: typeof fetch;
  /** Overridden only by tests (a local mock server). */
  baseUrl?: string;
}

export class KimiProvider implements AnalysisProvider {
  readonly maxRetries = 0 as const;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(o: KimiOptions) {
    if (typeof o.apiKey !== 'string' || o.apiKey.length === 0) throw new Error('missing provider key');
    this.#key = o.apiKey;
    this.#fetch = o.fetch;
    this.#base = o.baseUrl ?? KIMI_API_URL;
  }

  #check(r: ProviderRequest): void {
    const m = Object.prototype.hasOwnProperty.call(KIMI_MODELS, r.model) ? KIMI_MODELS[r.model] : undefined;
    if (!m || !Number.isSafeInteger(r.maxOutputTokens) || r.maxOutputTokens < 1 || r.maxOutputTokens > m.maxOutputTokens) throw new ProviderCallError('OTHER');
  }

  /** One POST; the response is returned whole or a fixed-value error is thrown. Never retried. */
  async #post(path: string, body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const s = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method: 'POST', redirect: 'error', signal: s,
        headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw classifyFetchError(e, signal);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderCallError('HTTP', res.status, safeId(res.headers.get('x-request-id')));
    }
    try {
      return await res.json();
    } catch (e) {
      throw signal.aborted ? new ProviderCallError('ABORTED') : e instanceof Error && e.name === 'TimeoutError' ? new ProviderCallError('TIMEOUT') : new ProviderCallError('MALFORMED_RESPONSE');
    }
  }

  async countInputTokens(r: ProviderRequest): Promise<number> {
    this.#check(r);
    const raw = await this.#post('/v1/tokenizers/estimate-token-count', estimateBody(r), r.signal, COUNT_TIMEOUT_MS);
    const n = isObj(raw) && isObj(raw.data) ? tokens(raw.data.total_tokens) : null;
    if (n === null) throw new ProviderCallError('MALFORMED_RESPONSE');
    return n;
  }

  async call(r: ProviderRequest): Promise<ProviderResponse> {
    this.#check(r);
    const raw = await this.#post('/v1/chat/completions', chatBody(r), r.signal, CALL_TIMEOUT_MS);
    return parseCompletion(raw, r.model, r.schema);
  }
}

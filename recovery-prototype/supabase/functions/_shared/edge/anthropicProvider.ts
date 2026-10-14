// Stage 2A-6b — the Anthropic provider adapter (offline: never called live in this stage).
//
// Runtime-neutral: it imports no SDK. The official TypeScript SDK client
// (@anthropic-ai/sdk, pinned in analyze-case/index.ts) is built by
// makeAnthropicClient() and injected, so the Node tests can drive the same adapter
// with the real SDK pointed at a local mock server, or with a scripted client.
//
// What every request is, and is not (facts from platform.claude.com/docs, checked
// for this stage: models overview, structured outputs, token counting, pricing):
//   * one Messages API request: the approved model, max_tokens = the output cap the
//     DATABASE approved, the system prompt, one user turn (text, and images only if a
//     caller ever allows them), structured output via
//     output_config.format = {type: "json_schema", schema} and output_config.effort;
//   * inference_geo "global" (a documented value; the default when the workspace sets none):
//     the reservation's snapshot prices are the global prices, and US-only inference costs
//     1.1x. Sent explicitly so a workspace default of "us" can never bill above the snapshot;
//     a workspace that does not allow "global" rejects the request instead (HTTP 400, HELD).
//     Stage 2A-6c removed service_tier: Priority Tier is not offered on these models and is
//     no longer sold, so the parameter only added compatibility uncertainty. The response's
//     usage.service_tier is still checked (must be "standard" or absent);
//   * NO retries (the client is built with maxRetries 0 and every request passes
//     maxRetries 0), NO model fallback (no `fallbacks` parameter, no second model is
//     ever tried), NO tools, NO prompt caching, NO beta headers, no `thinking` field
//     (the models' default adaptive thinking; its tokens are output tokens, inside the cap),
//     no streaming;
//   * the client is built with an explicit API key and base URL, so no credential file,
//     profile or environment variable can redirect it (config.ts also refuses to run if
//     any ANTHROPIC_* variable the SDK would read is set).
//
// Usage is accounted conservatively, from the response only:
//   input  = input_tokens + 2 x cache_creation_input_tokens + cache_read_input_tokens
//            (no caching is requested; were any reported, a cache write is counted at the
//            highest write multiplier (2x) and a cache read at the full input price);
//   output = output_tokens (thinking included).
// A response whose model differs from the requested one, whose service tier or
// inference geography is not the standard one, that reports server-tool use, or whose
// usage is missing or implausible is NOT trusted: the call fails with usage unknown,
// and the reservation is HELD (never settled at USD 0).

import {
  ProviderCallError, type AnalysisProvider, type ContentPart, type ModelConfig, type ProviderRequest, type ProviderResponse,
} from '../analysis-pipeline/index.ts';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/**
 * The approved model allowlist: only these model ids can ever be configured. Prices (USD per
 * million tokens, standard tier, global inference) and maximum output are from the official
 * models overview and pricing pages, verified for Stage 2A-6b. A reservation is refused before
 * dispatch unless the database snapshotted exactly these prices (pipeline: SPEND_TERMS_MISMATCH).
 */
export const ANTHROPIC_MODELS: Readonly<Record<string, Readonly<{ inputPerMTok: number; outputPerMTok: number; maxOutputTokens: number; approvedOutputCap: number }>>> = Object.freeze({
  // approvedOutputCap: the cap Stage 2A-6c puts in private.ai_model_prices (migration
  // 20261020120000_stage2a6c_model_prices.sql); the pipeline refuses any other cap.
  'claude-opus-5-5': Object.freeze({ inputPerMTok: 4, outputPerMTok: 20, maxOutputTokens: 128_000, approvedOutputCap: 8_000 }),
  'claude-sonnet-5-5': Object.freeze({ inputPerMTok: 2, outputPerMTok: 10, maxOutputTokens: 128_000, approvedOutputCap: 8_000 }),
});

export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high'] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

export function anthropicModelConfig(model: string): ModelConfig | null {
  const m = Object.prototype.hasOwnProperty.call(ANTHROPIC_MODELS, model) ? ANTHROPIC_MODELS[model] : undefined;
  return m ? { model, inputPerMTok: m.inputPerMTok, outputPerMTok: m.outputPerMTok, maxOutputTokens: m.maxOutputTokens, approvedOutputCap: m.approvedOutputCap } : null;
}

export interface RequestOptions { signal: AbortSignal; timeout: number; maxRetries: 0 }

/** The two SDK methods the adapter uses (structurally what `new Anthropic(...)` provides). */
export interface MessagesClient {
  readonly maxRetries: number;
  messages: {
    create(body: Record<string, unknown>, options: RequestOptions): Promise<unknown>;
    countTokens(body: Record<string, unknown>, options: RequestOptions): Promise<unknown>;
  };
}

/** The SDK's client class, as far as makeAnthropicClient needs it. */
export type AnthropicConstructor = new (options: {
  apiKey: string; authToken: null; baseURL: string; maxRetries: 0; timeout: number; logLevel: 'off';
}) => { maxRetries: number; messages: { create: (...a: never[]) => unknown; countTokens: (...a: never[]) => unknown } };

/** Backstop only: the pipeline aborts each call at its own (shorter) timeout. */
export const SDK_TIMEOUT_MS = 120_000;
const COUNT_TIMEOUT_MS = 10_000;

/**
 * Builds the SDK client with nothing left to defaults that could change where requests go or
 * how often they are sent. `baseURL` is overridden only by tests (a local mock server).
 */
export function makeAnthropicClient(Anthropic: AnthropicConstructor, apiKey: string, baseURL = ANTHROPIC_API_URL): MessagesClient {
  const c = new Anthropic({ apiKey, authToken: null, baseURL, maxRetries: 0, timeout: SDK_TIMEOUT_MS, logLevel: 'off' });
  const create = c.messages.create.bind(c.messages) as unknown as MessagesClient['messages']['create'];
  const countTokens = c.messages.countTokens.bind(c.messages) as unknown as MessagesClient['messages']['countTokens'];
  return { maxRetries: c.maxRetries, messages: { create: (b, o) => create(b, o), countTokens: (b, o) => countTokens(b, o) } };
}

function contentBlocks(parts: ContentPart[]): Record<string, unknown>[] {
  return parts.map((p) => (p.type === 'text'
    ? { type: 'text', text: p.text }
    : { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.base64 } }));
}

/** The exact Messages API body for one call (exported for tests). */
export function messagesBody(r: Omit<ProviderRequest, 'signal'>, effort: AnthropicEffort): Record<string, unknown> {
  return {
    model: r.model,
    max_tokens: r.maxOutputTokens,
    system: r.system,
    messages: [{ role: 'user', content: contentBlocks(r.content) }],
    output_config: { effort, format: { type: 'json_schema', schema: r.schema } },
    inference_geo: 'global',
  };
}

/** The count_tokens body for the same call: what is billed as input (no max_tokens or geography there). */
export function countBody(r: Omit<ProviderRequest, 'signal'>, effort: AnthropicEffort): Record<string, unknown> {
  const { model, system, messages, output_config } = messagesBody(r, effort);
  return { model, system, messages, output_config };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tokens = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const optTokens = (v: unknown): number | null => (v === undefined || v === null ? 0 : tokens(v));
const requestIdOf = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null);

/** Maps an SDK error to fixed values only (its message, which may echo content, is dropped). */
export function classifyError(e: unknown, signal?: AbortSignal): ProviderCallError {
  if (e instanceof ProviderCallError) return e;
  const name = e instanceof Error ? e.name : '';
  const o = isObj(e) ? e : {};
  const requestId = requestIdOf(o.requestID);
  if (name === 'APIUserAbortError' || signal?.aborted) return new ProviderCallError('ABORTED', null, requestId);
  if (name === 'APIConnectionTimeoutError') return new ProviderCallError('TIMEOUT', null, requestId);
  if (name === 'APIConnectionError') return new ProviderCallError('CONNECTION', null, requestId);
  if (typeof o.status === 'number' && Number.isInteger(o.status)) return new ProviderCallError('HTTP', o.status, requestId);
  return new ProviderCallError('OTHER', null, requestId);
}

/**
 * Turns a Messages API response into the pipeline's response, or throws ProviderCallError when
 * its usage cannot be trusted as the bill for this request (exported for tests).
 */
export function parseMessage(raw: unknown, requestedModel: string): ProviderResponse {
  if (!isObj(raw) || raw.type !== 'message' || !Array.isArray(raw.content) || !isObj(raw.usage)) {
    throw new ProviderCallError('MALFORMED_RESPONSE', null, requestIdOf(isObj(raw) ? raw._request_id : null));
  }
  const requestId = requestIdOf(raw._request_id) ?? requestIdOf(raw.id);
  if (raw.model !== requestedModel) throw new ProviderCallError('MODEL_MISMATCH', null, requestId);
  const u = raw.usage;
  const input = tokens(u.input_tokens);
  const output = tokens(u.output_tokens);
  const cacheWrite = optTokens(u.cache_creation_input_tokens);
  const cacheRead = optTokens(u.cache_read_input_tokens);
  if (input === null || output === null || cacheWrite === null || cacheRead === null) throw new ProviderCallError('MALFORMED_RESPONSE', null, requestId);
  // Anything priced differently from the snapshot: not trusted as the bill.
  if (u.service_tier !== undefined && u.service_tier !== null && u.service_tier !== 'standard') throw new ProviderCallError('PRICING_MISMATCH', null, requestId);
  if (u.inference_geo !== undefined && u.inference_geo !== null && u.inference_geo !== 'global' && u.inference_geo !== 'not_available') {
    throw new ProviderCallError('PRICING_MISMATCH', null, requestId);
  }
  if (isObj(u.server_tool_use) && Object.values(u.server_tool_use).some((n) => n !== 0 && n !== null)) {
    throw new ProviderCallError('PRICING_MISMATCH', null, requestId);
  }
  const text = raw.content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as { text: string }).text).join('');
  return {
    text,
    stopReason: typeof raw.stop_reason === 'string' ? raw.stop_reason : 'missing',
    inputTokens: input + 2 * cacheWrite + cacheRead,
    outputTokens: output,
    ...(requestId ? { requestId } : {}),
  };
}

export class AnthropicProvider implements AnalysisProvider {
  readonly maxRetries = 0 as const;
  readonly #client: MessagesClient;
  readonly #effort: AnthropicEffort;

  constructor(client: MessagesClient, effort: AnthropicEffort) {
    // A client that may retry on its own would send unrecorded, unreserved requests.
    if (client.maxRetries !== 0) throw new Error('the Anthropic client must be built with maxRetries 0');
    if (!ANTHROPIC_EFFORTS.includes(effort)) throw new Error('unsupported effort');
    this.#client = client;
    this.#effort = effort;
  }

  #check(r: ProviderRequest): void {
    // Only allowlisted models, and never more output than the model allows.
    const m = anthropicModelConfig(r.model);
    if (!m || !Number.isSafeInteger(r.maxOutputTokens) || r.maxOutputTokens < 1 || r.maxOutputTokens > m.maxOutputTokens!) {
      throw new ProviderCallError('OTHER');
    }
  }

  async countInputTokens(r: ProviderRequest): Promise<number> {
    this.#check(r);
    const raw = await this.#client.messages.countTokens(countBody(r, this.#effort), { signal: r.signal, timeout: COUNT_TIMEOUT_MS, maxRetries: 0 });
    const n = isObj(raw) ? tokens(raw.input_tokens) : null;
    if (n === null) throw new ProviderCallError('MALFORMED_RESPONSE');
    return n;
  }

  async call(r: ProviderRequest): Promise<ProviderResponse> {
    this.#check(r);
    let raw: unknown;
    try {
      raw = await this.#client.messages.create(messagesBody(r, this.#effort), { signal: r.signal, timeout: SDK_TIMEOUT_MS, maxRetries: 0 });
    } catch (e) {
      throw classifyError(e, r.signal);
    }
    return parseMessage(raw, r.model);
  }
}

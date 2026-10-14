// Stage 2A-6b — synthetic Anthropic Messages API responses for the adapter tests.

import type { MessagesClient, RequestOptions } from '../../../supabase/functions/_shared/edge/anthropicProvider.ts';

const OPUS = 'claude-opus-5-5';

/** A Messages API response as documented (thinking block first, then the JSON text). */
export function message(value: unknown, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return {
    id: 'msg_synthetic01', type: 'message', role: 'assistant', model: OPUS,
    content: [{ type: 'thinking', thinking: 'SYNTHETIC-THINKING', signature: 'sig' }, { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null,
      server_tool_use: null, service_tier: 'standard', inference_geo: 'global', output_tokens_details: null, ...usage },
    _request_id: 'req_synthetic01',
    ...over,
  };
}


export type Script = unknown | Error | 'HANG' | ((body: Record<string, unknown>, o: RequestOptions) => unknown);
/** Scripted client: records every request body and options; answers per role (by system prompt). */
export class ScriptedClient implements MessagesClient {
  maxRetries = 0;
  creates: { body: Record<string, unknown>; options: RequestOptions }[] = [];
  counts: { body: Record<string, unknown>; options: RequestOptions }[] = [];
  constructor(public create: Record<'ANALYST' | 'REVIEWER', Script>, public count: Record<'ANALYST' | 'REVIEWER', Script> = { ANALYST: { input_tokens: 1500 }, REVIEWER: { input_tokens: 2500 } }) {}
  private static role(body: Record<string, unknown>) { return String(body.system).startsWith('You are an independent adversarial reviewer') ? 'REVIEWER' : 'ANALYST'; }
  private static async answer(s: Script, body: Record<string, unknown>, o: RequestOptions): Promise<unknown> {
    if (s === 'HANG') return new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }))));
    if (s instanceof Error) throw s;
    return typeof s === 'function' ? (s as (b: Record<string, unknown>, o: RequestOptions) => unknown)(body, o) : structuredClone(s);
  }
  messages = {
    create: (body: Record<string, unknown>, options: RequestOptions) => { this.creates.push({ body, options }); return ScriptedClient.answer(this.create[ScriptedClient.role(body)], body, options); },
    countTokens: (body: Record<string, unknown>, options: RequestOptions) => { this.counts.push({ body, options }); return ScriptedClient.answer(this.count[ScriptedClient.role(body)], body, options); },
  };
}


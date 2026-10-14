// Stage 2A-6b test harness: the pinned SDK exactly as the Edge Function imports it (npm: specifier),
// under the real Deno runtime, through the adapter, against a LOCAL mock Messages API served here.
// No request leaves 127.0.0.1; the key is synthetic. Prints one JSON line of observations.
import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { AnthropicProvider, makeAnthropicClient } from '../../../supabase/functions/_shared/edge/anthropicProvider.ts';

const seen: { path: string; key: string | null; auth: string | null; beta: string | null; retry: string | null; model: unknown }[] = [];
const script: Record<string, { status: number; body: unknown }[]> = {
  '/v1/messages/count_tokens': [{ status: 200, body: { input_tokens: 77 } }],
  '/v1/messages': [
    { status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"a":"ok"}' }], usage: { input_tokens: 70, output_tokens: 9, service_tier: 'standard', inference_geo: 'global' } } },
    { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'SYNTHETIC' } } },
    { status: 200, body: { never: 'a retry' } },
  ],
};
const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
  const path = new URL(req.url).pathname;
  const body = await req.json();
  seen.push({ path, key: req.headers.get('x-api-key'), auth: req.headers.get('authorization'), beta: req.headers.get('anthropic-beta'),
    retry: req.headers.get('x-stainless-retry-count'), model: body.model });
  const r = script[path]?.shift() ?? { status: 404, body: {} };
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', 'request-id': 'req_deno01' } });
});
const base = `http://127.0.0.1:${server.addr.port}`;
const p = new AnthropicProvider(makeAnthropicClient(Anthropic, 'sk-ant-TEST-ONLY-not-a-real-key-0000', base), 'medium');
const req = { role: 'ANALYST' as const, model: 'claude-sonnet-5-5', system: 's', content: [{ type: 'text' as const, text: 't' }],
  schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] }, maxOutputTokens: 1000, signal: new AbortController().signal };
const counted = await p.countInputTokens(req);
const ok = await p.call(req);
const failed = await p.call(req).then(() => null, (e) => ({ name: e.name, kind: e.kind, httpStatus: e.httpStatus }));
console.log(JSON.stringify({ counted, ok, failed, seen }));
await server.shutdown();

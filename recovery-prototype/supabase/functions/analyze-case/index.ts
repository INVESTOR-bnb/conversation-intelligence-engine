// Stage 2A-5d-4b — Supabase Edge Function `analyze-case` (Deno entry point).
// All logic is in ../_shared/edge/handler.ts (also exercised by the Node tests).
// Provider: the FAKE unless configured otherwise; see ../_shared/edge/config.ts.
// Stage 2A-6b: the pinned official Anthropic SDK is the only provider library. It is used
// only when ANALYSIS_PROVIDER=anthropic with ALLOW_PAID_PROVIDER=staging-only, an allowlisted
// model pair and a key — none of which is configured anywhere in this stage. The client is
// built in ../_shared/edge/anthropicProvider.ts (explicit key and base URL, maxRetries 0).
// Deployment: docs/stage-2a/STAGE-2A-5D-4B-EDGE-FUNCTION.md (not deployed by this stage).

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { makeAnthropicClient } from '../_shared/edge/anthropicProvider.ts';
import { createAnalyzeCaseHandler } from '../_shared/edge/handler.ts';

Deno.serve(createAnalyzeCaseHandler({
  env: (name) => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
  log: (line) => console.log(line),
  anthropicClient: (apiKey) => makeAnthropicClient(Anthropic, apiKey),
}));

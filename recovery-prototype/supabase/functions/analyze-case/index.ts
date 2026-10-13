// Stage 2A-5d-4b — Supabase Edge Function `analyze-case` (Deno entry point).
// All logic is in ../_shared/edge/handler.ts (also exercised by the Node tests).
// Provider: the FAKE only (no AI, no API key); see ../_shared/edge/config.ts.
// Deployment: docs/stage-2a/STAGE-2A-5D-4B-EDGE-FUNCTION.md (not deployed by this stage).

import { createAnalyzeCaseHandler } from '../_shared/edge/handler.ts';

Deno.serve(createAnalyzeCaseHandler({
  env: (name) => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
  log: (line) => console.log(line),
}));

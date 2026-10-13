// Stage 2A-5d-4b test harness: serves the analyze-case handler under the real Deno
// runtime on a test port (the production entry, supabase/functions/analyze-case/index.ts,
// is the same call with the platform's port; it is type-checked with `deno check`).
import { createAnalyzeCaseHandler } from '../../../supabase/functions/_shared/edge/handler.ts';

const port = Number(Deno.env.get('TEST_PORT'));
Deno.serve({ port, hostname: '127.0.0.1', onListen: () => console.log(`listening ${port}`) }, createAnalyzeCaseHandler({
  env: (name) => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
  log: (line) => console.log(line),
}));

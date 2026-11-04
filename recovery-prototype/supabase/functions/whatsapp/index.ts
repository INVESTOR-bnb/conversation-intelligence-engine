// RRE WhatsApp integration — Supabase Edge Function `whatsapp` (Deno entry point).
// All logic is in ../_shared/whatsapp/waIntegration.ts (also exercised by the Node tests).
// Deploy ONLY to the separate WhatsApp development project (the code refuses the prototype's
// project), with verify_jwt OFF; see supabase/whatsapp/README.md.

import { createWaHandler } from '../_shared/whatsapp/waIntegration.ts';

Deno.serve(createWaHandler({
  env: (name) => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
  log: (line) => console.log(line),
}));

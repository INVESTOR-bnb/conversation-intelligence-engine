// WhatsApp FEASIBILITY TEST — Supabase Edge Function `whatsapp-test` (Deno entry point).
// All logic is in ../_shared/whatsapp/waTest.ts (also exercised by the Node tests).
// Deploy ONLY with founder approval, with verify_jwt OFF (Meta's webhook carries no Supabase JWT;
// the webhook is authenticated by its HMAC signature, the founder routes by the founder check in code).
// Remove: delete the function and its secrets; run supabase/whatsapp-test/wa_test_remove.sql.

import { createWaTestHandler } from '../_shared/whatsapp/waTest.ts';

Deno.serve(createWaTestHandler({
  env: (name) => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
  log: (line) => console.log(line),
}));

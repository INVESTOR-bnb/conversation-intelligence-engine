# WhatsApp feasibility test (isolated)

Branch `claude/whatsapp-feasibility-test`. Official WhatsApp Business Platform (Cloud API) only —
no WhatsApp Web automation, no session bridges. Nothing here is deployed, installed or connected
until the founder approves each live step. It does not touch the existing manual workflow,
founder approval, client isolation or the founder-only analysis.

## What is built

| Part | File | Status |
|---|---|---|
| Edge Function logic (webhook verify + HMAC signature, metadata-only events, dedupe, onboarding, one controlled send, founder summary) | `supabase/functions/_shared/whatsapp/waTest.ts` | built, tested (simulated) |
| Edge Function entry (`whatsapp-test`) | `supabase/functions/whatsapp-test/index.ts` | built, not deployed |
| Database objects (private tables, service-role functions, founder summary) | `supabase/whatsapp-test/wa_test.sql` | built, tested on local Postgres, NOT installed on staging |
| Removal | `supabase/whatsapp-test/wa_test_remove.sql` | tested (leaves nothing) |
| Private founder page (Meta Embedded Signup for WhatsApp Business app users, send one test message, view results) | `supabase/whatsapp-test/connect.html` | built, not deployed |

Safety built in: webhook signature (`X-Hub-Signature-256`, HMAC-SHA256 with the app secret) or
401; duplicates (Meta retries) stored once; the business always comes from the server-side
number→business mapping; unknown numbers are never stored; message **text is stored only for
the one consenting test contact** — everyone else is a keyed hash with no content; chat history
is stored only as counts (threads, messages, types, oldest/newest date); sending is off unless
`WA_TEST_SENDING=enabled`, goes only to `WA_TEST_RECIPIENT` (the request cannot name a
recipient or text), is one fixed labelled message, idempotent per key, at most 3 per number, and
in text mode only inside the 24-hour window the test contact opened. Businesses can read nothing;
the founder reads a summary. Secrets live only in Supabase function secrets.

## Run the tests (local, no network, no secrets)
```bash
cd recovery-prototype
npx playwright test --config playwright.unit.config.ts tests/unit/waTest.spec.ts   # handler + page (simulated Meta/Supabase)
bash supabase/scripts/test-whatsapp-local.sh                                       # database rules on real Postgres, then removal
```

## Live test plan (each step needs the inputs below; none has been run)
1. **Install** `wa_test.sql` on staging and **deploy** `whatsapp-test` (verify_jwt OFF) with secrets
   `WA_APP_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_TEST_RECIPIENT`, `WA_ACCESS_TOKEN`,
   optional `WA_TEST_TEMPLATE`/`WA_TEST_TEMPLATE_LANG`; `WA_TEST_SENDING` unset (off).
2. In the Meta app: webhook URL `https://aqwdwswpmbnzmkvyuqil.supabase.co/functions/v1/whatsapp-test/webhook`,
   verify token = `WA_VERIFY_TOKEN`; fields `messages`, `history`, `smb_message_echoes`, `smb_app_state_sync`.
3. Place `connect.html` at `/wa-test.html` with its own CSP allowing `connect.facebook.net`
   (script) and `www.facebook.com` (frame) — the rest of the site's CSP unchanged.
4. **A Connection:** founder opens the page, connects the business's WhatsApp Business app number
   (keep using the app; share history). Evidence: onboarding steps all `OK`; the app still works on the phone.
5. **B Old chats:** within 24 h the history webhooks arrive; record threads, messages, types,
   oldest/newest date, and compare with 3 known older chats the owner names (counts/dates only).
6. **E then C:** the test contact writes to the business number (opens the free window); then
   the founder sets `WA_TEST_SENDING=enabled`, sends ONE test message, and turns it off again.
7. **D Visibility:** the owner screenshots the chat with the test contact **in the WhatsApp
   Business app** showing the test message (redact numbers).
8. **E Reply:** the test contact replies `TEST-OK`; the summary shows it linked to the send and the right business.

## Disable and remove
- Stop sending: unset `WA_TEST_SENDING` (every send then returns `SENDING_DISABLED`).
- Stop everything: delete the `whatsapp-test` function and its secrets; remove the webhook
  subscription in the Meta app; run `wa_test_remove.sql` (deletes the test tables and functions).
- Remove access: in Meta Business settings remove the app's access to the WhatsApp account, and
  revoke the system-user token. The WhatsApp Business app, its number and its chats are not
  deleted, migrated or replaced by any of this.

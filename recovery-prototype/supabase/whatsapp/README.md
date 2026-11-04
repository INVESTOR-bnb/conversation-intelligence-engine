# RRE WhatsApp integration (isolated; not in production)

Branch `claude/whatsapp-integration` (from `claude/whatsapp-feasibility-test` @ `1811f39`). Official
WhatsApp Business Platform (Cloud API) only: Meta's Embedded Signup "WhatsApp Business app
onboarding" (also called coexistence). No WhatsApp Web automation, no session bridges.

## What the owner gets
1. **Connect WhatsApp** (their existing Business-app number; the app keeps working).
2. **Authorize** with stated limits: history period (1–6 months), RRE sends or owner sends,
   follow-ups per day and per person, and a WhatsApp spending limit. Connecting alone authorizes nothing.
3. RRE **imports** the last months of 1:1 chats once (Meta's limit), turns stalled sales chats into
   ordinary RRE cases; the founder analyses and approves them in the existing workflow.
4. RRE **sends** approved follow-ups from the owner's number: for an old prospect, the owner's
   Meta-approved **reopening template**; after the prospect replies (24-hour window open), the
   founder-approved **personal reply**. Only to prospects the owner confirms agreed; never after STOP.
5. The owner sees everything in the **WhatsApp Business app** (to be proven live); if they write to a
   customer themselves, RRE stops for that conversation. **Pause** stops sending at once.

## Files (all new unless noted)
| Part | File |
|---|---|
| Database bundle (isolated env only) / removal / tests | `supabase/whatsapp/wa_integration.sql`, `wa_integration_remove.sql`, `wa_integration.test.sql` |
| Edge Function `whatsapp` (logic / entry) | `supabase/functions/_shared/whatsapp/waIntegration.ts`, `supabase/functions/whatsapp/index.ts` |
| Owner page, founder diagnostics, helpers | `src/live/whatsappUi.tsx`, `src/live/whatsapp.ts` |
| Preview wiring (flag-gated) | `src/live/LiveApp.tsx`, `src/live/pages.tsx` (links), `src/vite-env.d.ts`, `vite.config.ts` (preview-only CSP) — modified |
| Tests | `tests/pipeline/whatsapp-e2e.spec.ts`, `tests/whatsapp-ui/whatsapp.spec.ts`, `tests/unit/whatsappHelpers.spec.ts`, `tests/live/whatsappAbsent.spec.ts`, `supabase/scripts/test-whatsapp-integration-local.sh`, `playwright.whatsapp.config.ts`; `tests/pipeline/fakeSupabase.ts` (adds `registerRpc`) |

## How the current prototype is protected
- Separate branch; the only workflow is manual and gated to the prototype's branch, so pushing this branch deploys nothing.
- The database bundle is **not a migration** and adds new objects only; it is installed only in a separate Supabase project.
- The Edge Function **refuses to run** against the prototype's project (`ISOLATION_REFUSED`), and the WhatsApp screens are **compiled out** unless `VITE_WHATSAPP_PREVIEW=1` and the Supabase URL is not the prototype's.
- The prototype build's routes, links and Content-Security-Policy are unchanged (`tests/live/whatsappAbsent.spec.ts`).
- No prototype data, secret, webhook, AI allowance or model setting is used; case `DASH-PAID-20261031171309` is untouched.

## Run the tests (local, synthetic, no network or secrets)
```bash
cd recovery-prototype && npm run test:whatsapp
```

## Set up the isolated environment (needs owner access; nothing here is done yet)
1. **Supabase**: a NEW project (Free plan is enough for a pilot test). Apply `supabase/migrations/*`, then
   `supabase/whatsapp/wa_integration.sql`. Create the founder and one test business there (synthetic or
   the authorizing pilot business only — no prototype data is copied).
2. **Edge Functions** in that project: `analyze-case` (AI spending stays off; its own allowance) and
   `whatsapp` with verify_jwt OFF and secrets: `WA_APP_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN` (random 24+),
   `WA_WORKER_SECRET` (random 32+), `WA_TOKEN_KEY` (32 random bytes, base64), `WA_ALLOWED_ORIGIN` (preview site URL).
3. **Worker schedule** (in that project, SQL editor): `pg_cron` + `pg_net` calling `POST …/functions/v1/whatsapp/worker`
   with header `x-rre-worker` every minute (store the secret in Supabase Vault, not in the job text).
4. **Preview site**: a NEW Cloudflare Pages project (Free), built with `VITE_SUPABASE_URL` (new project),
   `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_WHATSAPP_PREVIEW=1`, `VITE_WA_APP_ID`, `VITE_WA_ES_CONFIG_ID`.
5. **Meta**: an app with WhatsApp + Facebook Login for Business; an Embedded Signup configuration for
   WhatsApp Business app onboarding; JS SDK allowed domain = the preview site; webhook URL
   `https://<new-project>.supabase.co/functions/v1/whatsapp/webhook`, verify token = `WA_VERIFY_TOKEN`,
   fields `messages`, `history`, `smb_message_echoes`, `smb_app_state_sync`, `account_update`.
6. **Reopening template** (owner's WABA, category Marketing): e.g. "Hello from {{business}}. Are you still
   interested in what you asked us about? Reply STOP to opt out." Wait for approval; enter its name,
   language and exact text in RRE's authorization form.

## Operate, pause, disconnect, remove
- **Global sending switch**: founder → WhatsApp diagnostics (off by default). Per business: owner → *Pause recovery now*.
- **Unconfirmed sends** (timeouts): founder diagnostics → check the owner's app → *It was sent* / *It was not sent*. Never resent automatically.
- **Disconnect**: owner → *Disconnect WhatsApp* (unsubscribes the app, deletes RRE's credential; the app and chats are untouched).
- **Remove**: delete the `whatsapp` function and its secrets, remove the webhook in the Meta app, run `wa_integration_remove.sql`,
  remove the app in Meta Business settings. Delete the isolated Supabase and Pages projects if no longer needed.

## Meta requirements (status as researched on 4 Nov 2026; developers.facebook.com and business.whatsapp.com were NOT reachable from the build environment — every item below is from search excerpts and must be confirmed in Meta's docs or by an authorized eligibility check)
| Item | Finding | Status |
|---|---|---|
| Existing Business-app number, app keeps working | Embedded Signup with `featureType: whatsapp_business_app_onboarding`; app v2.24.17+; 20 msg/s; groups, broadcast lists, disappearing messages unsupported via API | documented (excerpts) |
| Nigeria | Meta changelog reportedly lists Nigerian Business-app numbers as supported (date not visible); some vendors still say unsupported | UNCONFIRMED — an authorized onboarding attempt is the decisive check (`HISTORY_SYNC_*` / signup refusal is surfaced as Action required) |
| History | up to 6 months of 1:1 chats, one-time, requested within 24 h of onboarding; owner may decline; groups not synced | documented (excerpts) |
| API-sent messages in the app | vendors describe mirroring; app messages arrive as `smb_message_echoes` | NOT PROVEN — needs a live screenshot |
| Who can onboard | Solution Partner or Tech Provider; Tech Provider = business verification + App Review (video) for advanced `whatsapp_business_messaging` / `whatsapp_business_management` | documented (excerpts) |
| Own account vs third parties | with Standard access an app can act only on assets of businesses it owns/administers; third-party businesses need Advanced access (App Review) | own-account route plausible; UNCONFIRMED for coexistence |
| Messaging rules | free text only within 24 h of the customer's last message; otherwise approved templates; opt-in required for business-initiated messages | documented (policy excerpts) |
| Pricing (Nigeria, USD per delivered message) | marketing ≈ 0.0516, utility ≈ 0.0067; service messages reported chargeable from 1 Oct 2026 (≈ 0.0101) after a monthly free allowance, with a payment method required | third-party figures; UNVERIFIED against Meta's rate card |

## Proposed rollout (for founder review; nothing is authorized yet)
1. Isolated environment set up (above) with synthetic data only. 2. Meta: RRE's own business verified;
app in development; Embedded Signup configured. 3. Live test with RRE's own (or a consenting pilot's)
Nigerian Business-app number and a consenting test contact: steps A–G of the checklist.
4. Founder review of live evidence and costs. 5. App Review (Tech Provider) before any third-party business.
6. Pilot with 1–3 consenting businesses, small spending limits, global switch under founder control.
7. Only then: plan a separate, reviewed cutover into the prototype (new migrations, deploy, CSP), with rollback.

## Status — 4 Nov 2026 (after the approved five steps)
| Step | Result |
|---|---|
| 1. History-import sequencing | DONE, SIMULATED PASS: authorization and verified mapping saved before history is requested; immediate and out-of-order batches; no analysis until history is complete and settled (10 min); late history added as labelled evidence, case back to re-analysis, outdated approval unusable |
| 2. Independent private preview | TOOLING DONE (workflow job `wa-preview`, tested offline); deployment BLOCKED on a new Supabase project and the `wa-preview` environment |
| 3. Historical-chat access, live | BLOCKED (Meta app, number, consent) |
| 4. One complete live cycle | BLOCKED (3 + spending approval) |
| 5. Budget | proposed below; nothing spent |

### Deploy the preview (once the inputs exist)
Actions → "Deploy recovery prototype" → Run workflow → branch `claude/whatsapp-integration`, target
`wa-preview-deploy`, `expected_sha` = the branch's latest commit → approve. Then add yourself as a user
in the PREVIEW Supabase project (Authentication → Add user) and run target `wa-preview-founder` with
your email. Check any time with `wa-preview-readiness`.

### Inputs needed (GitHub → Settings → Environments → `wa-preview`; never in chat)
- Protection: required reviewer `INVESTOR-bnb`; deployment branch `claude/whatsapp-integration` only.
- Variables: `WA_PREVIEW_PROJECT_REF` (the new project's 20-letter reference), `WA_PREVIEW_PUBLISHABLE_KEY`
  (its `sb_publishable_…` key; public), `WA_PREVIEW_PAGES_PROJECT` = `rre-whatsapp-preview`, `WA_APP_ID`, `WA_ES_CONFIG_ID`.
- Secrets: `WA_PREVIEW_SUPABASE_ACCESS_TOKEN` (scoped to the NEW project only: Database, Edge Functions,
  Edge Function Secrets read-write; 30 days), `WA_APP_SECRET`, `WA_VERIFY_TOKEN` (any random 24+ characters;
  the same value goes into the Meta webhook settings).
- The Cloudflare token already used by the site deploy creates the separate Pages project.

### Partner fallback (only if Meta refuses direct onboarding of the Nigerian number)
360dialog lists coexistence; reported price ≈ EUR 49 (≈ USD 49–59) per number per month plus Meta's
message fees (third-party reports, not a quote). Not needed unless the direct route is refused.

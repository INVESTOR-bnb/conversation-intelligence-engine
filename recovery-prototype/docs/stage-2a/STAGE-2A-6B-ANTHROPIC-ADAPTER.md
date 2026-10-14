# Stage 2A-6b — Anthropic provider adapter (offline only)

**Status.** Implemented and tested **offline**. Every Anthropic response in the tests is
mocked.
- No live API call was made.
- No credential exists.
- Nothing was deployed.
- No database or staging change.
- Spending stays disabled.

**The fake provider and its pipeline are unchanged in behaviour.** The fake path now also
reads the reservation terms (Stage 2A-6a, already on staging).

## What exists now

| Part | File | What it does |
|---|---|---|
| Adapter | `supabase/functions/_shared/edge/anthropicProvider.ts` | One Messages API request per call through the official SDK. Holds the model allowlist, conservative usage accounting, and error classification. Imports no SDK itself; the client is injected. |
| SDK | `supabase/functions/analyze-case/index.ts` | `npm:@anthropic-ai/sdk@0.133.0` (pinned; also a devDependency, for tests). Built with an explicit key and base URL, `authToken: null`, `maxRetries: 0`, SDK logging off. |
| Configuration | `supabase/functions/_shared/edge/config.ts` | `ANALYSIS_PROVIDER=anthropic` is accepted only with every condition below. |
| Pipeline | `supabase/functions/_shared/analysis-pipeline/pipeline.ts` | Reservation-terms check, input-token count before dispatch, schema validation, refusal code. |
| Schemas | `supabase/functions/_shared/analysis-pipeline/structuredOutput.ts` | Checks the schemas against the documented structured-output limits, and validates every answer against them. |
| Prompts | `supabase/functions/_shared/analysis-pipeline/prompts.ts` | `rre-6b-analyst-v2+reviewer-v2`: commercial usefulness, and no invented motives. |

**Conditions for `ANALYSIS_PROVIDER=anthropic`:**
- `ALLOW_PAID_PROVIDER=staging-only`, on the staging project or a local host only;
- `ANTHROPIC_API_KEY` of the right shape;
- `ANALYST_MODEL` and `REVIEWER_MODEL` on the allowlist;
- `ANTHROPIC_EFFORT` set to `low`, `medium` or `high` (default `medium`);
- **none** of the 19 other `ANTHROPIC_*` variables the SDK reads by itself is set. These cover the base URL, other credentials, profiles, extra headers and SDK logging. If any is set, the function refuses with `PROVIDER_ENV_UNSAFE`.

### Model allowlist

Verified against the official models overview and pricing pages for this stage:

| Model | Input / output, USD per million tokens | Max output | Notes |
|---|---|---|---|
| `claude-opus-5-5` | 4 / 20 | 128,000 | adaptive thinking always on |
| `claude-sonnet-5-5` | 2 / 10 | 128,000 | adaptive thinking on by default |

- Neither model has a long-context premium.
- US-only inference costs 1.1×, so requests ask for `inference_geo: "global"`.
- Priority tier is priced differently, so requests ask for `service_tier: "standard_only"`.

Analyst and reviewer models are chosen **separately**. This is what allows a later
Sonnet-versus-Opus comparison. There is no default model: the choice must be explicit.

### What a request is, and is not

- **It is:**
  - the approved model;
  - `max_tokens` set to **the database-approved cap**;
  - the system prompt;
  - one user turn: the evidence as delimited, untrusted text;
  - `output_config` with `format: {type: "json_schema", schema}` and `effort`.
- **It never has:**
  - retries (SDK client and every request: `maxRetries: 0`);
  - a `fallbacks` parameter or any second model;
  - tools, prompt caching, beta headers or a `thinking` field;
  - streaming;
  - images. The paid provider is **text-only**: a case with screenshots is refused (`PAID_PROVIDER_TEXT_ONLY`) before any reservation.

### Before anything is sent (each refusal costs USD 0)

All of these run before the dispatch record:
1. **The database reserves** (unchanged): spending enabled, models priced, rate limits, budget.
2. **The reservation's terms must match this run** (`SPEND_TERMS_MISMATCH`, or `SPEND_TERMS_UNAVAILABLE` if they cannot be read). The terms come from `internal_ai_reservation_terms`. The checks:
   - the status is `RESERVED`;
   - each call's model and output cap equal the reservation's and the configuration's;
   - the snapshotted prices **exactly** equal the allowlist prices;
   - the cap is within the model's maximum;
   - the worst case of both calls (`input bound × input price + cap × output price`) is covered by the reserved amount.
3. **The exact request's input is counted**, using the free `count_tokens` endpoint, which generates nothing. With a 10% margin for the estimate, the count must fit the reserved input bound.
   - Over the bound: `INPUT_EXCEEDS_RESERVATION_<ROLE>`.
   - The count fails or hangs: `TOKEN_COUNT_FAILED_<ROLE>`.
   - A priced call from a provider that cannot count: `TOKEN_COUNT_UNAVAILABLE_<ROLE>`.

### After a request: accounting

| What happened | Ledger | Why |
|---|---|---|
| Never sent (any refusal above) | `SETTLED` / `NO_DISPATCH`, USD 0 | No dispatch record: nothing could have left. |
| Answer with trusted usage, including a **refusal** (HTTP 200, billed) or a cut-off/invalid/off-schema answer | `SETTLED` / `REPORTED_USAGE` at the real tokens | Usage is reported **before** the answer is judged. |
| Timeout, abort, connection error, any HTTP error (400/429/500/529…), malformed body | `HELD` / `UNKNOWN_USAGE` | It may have been billed. It is **never** settled at USD 0 automatically; the founder reconciles it. |
| An answer whose bill cannot be trusted | `HELD` | Covers: a different model than requested, a non-standard tier, non-global geography, server-tool use, or missing or implausible usage. |

- **Usage counted:**
  - input = `input_tokens + 2 × cache_creation_input_tokens + cache_read_input_tokens`. No caching is requested; if any is reported, it is over-counted, never under-counted;
  - output = `output_tokens` (thinking included).
- **After an answer**, each of these fails closed, with the billed usage already recorded:
  - output over the cap (`PROVIDER_LIMIT_EXCEEDED_<ROLE>`);
  - input over the bound (`PROVIDER_INPUT_EXCEEDED_<ROLE>`);
  - `refusal` (`PROVIDER_REFUSED_<ROLE>`);
  - `max_tokens` or another stop (`PROVIDER_INCOMPLETE_<ROLE>`);
  - invalid JSON;
  - an answer outside the schema (`SCHEMA_INVALID_<ROLE>`).
- **Logs** carry fixed values only: error kind, HTTP status, the provider's request id (for reconciliation), and token counts. They never contain provider text, evidence, output or the key.

### Unchanged protections

- Founder-only access to analyses, reviews, findings, spending and terms (RLS and grants: no permission was changed).
- Opt-out and contact restrictions are checked before start and in the snapshot.
- Evidence is loaded only from the frozen snapshot and re-hashed.
- The database contract judges citations, quotes and consistency.
- The adversarial review: a rejected recommendation is removed.
- Evidence is presented as untrusted data.

## Deployment is deliberately blocked

- `deploy-analyze-case-staging.sh` still refuses any function code containing an AI-provider SDK, endpoint or key. This branch's code now contains the pinned SDK, so **the script refuses to deploy it**. A test proves this.
- The fake e2e script (`fake-pipeline-e2e.sh`) likewise refuses a deployed function containing it.
- Staging keeps running the deployed fake-only function (code as of `9ee3767`). The tests verify the e2e script against that code.
- Deploying the paid adapter needs its own separately approved stage, with its own guarded script.

## What staging would need before any paid test (not done; each needs founder approval)

1. **Price rows** for the chosen models in `private.ai_model_prices`, at exactly the allowlist prices, with output caps. This is a database change. Without it the database refuses with `MODEL_NOT_PRICED`.
2. **An Anthropic workspace and key with a provider-side spending limit**, confirmed independently, as the 2A-6 approval requires.
3. **A guarded deployment stage** that sets `ANALYSIS_PROVIDER=anthropic`, `ALLOW_PAID_PROVIDER=staging-only`, the key and the models, and later restores the fake.
4. **The paid evaluation itself** (proposed $2–$3, absolute ceiling $15), synthetic text cases only.

## Tests (all offline)

| Suite | New or changed |
|---|---|
| `tests/unit/anthropicProvider.spec.ts` (26) | Scripted client. Covers: request mapping (no retry, fallback, tools, thinking, caching, streaming); count body; usage accounting; untrusted bills; error classification; success, refusal, timeout, HTTP errors, uncertain usage, malformed and off-schema output, token limits, over-bound input, failed counts, terms mismatches, text-only, the review verdict, no leaks; schema limits and validation. |
| `tests/unit/anthropicSdk.spec.ts` (7) | **The real SDK** against a local mock API. Covers: the exact body; key header; no beta header and no Authorization header; retry count 0; exactly one request on 429, 500, 503 (with a retry hint) and 529; abort; malformed bodies; environment variables cannot redirect or re-authenticate the client; the full pipeline over the SDK. |
| `tests/pipeline/anthropic-db.spec.ts` (8) | **The real local ledger**. Covers: settlement at the real cost; a refusal is billed; timeout, 500 and wrong model are HELD; over-bound input is NO_DISPATCH at USD 0; a price mismatch is refused; an unpriced model; spending disabled; businesses denied. |
| `tests/pipeline/edge-anthropic.spec.ts` (5) | The handler with the paid configuration. Covers: a founder run; business tokens refused; text-only; 13 configuration refusals; every SDK environment override refused. |
| `tests/pipeline/edge-deno.spec.ts` (+1) | The pinned `npm:` SDK under **Deno 2.1.4** (no environment permission at all) against a local mock. Covers: one request on 529, the explicit key, no beta header. |
| Updated | Covers: the terms call in the service-call order; refusal codes; the stricter schema check; log fields; the e2e and deploy tests pinned to the deployed code, plus the refusal of the new code. |

**Mutation testing:** 23 deliberate defects in the new guards, all caught. They covered:
- the pipeline: the input count, the price, coverage, status and cap checks, the count margin, schema validation, the post-call input check, text-only, an uncountable provider, refusal mapping;
- the adapter: retries on the request and on the client, model mismatch, cache accounting, tier and geography checks, the allowlist, `authToken`, the service tier;
- the configuration: the environment check, staging-only, the key shape.

## Unresolved risks (honest list)

1. **Latency against the timeouts.** Each paid call gets 55 s, and the whole run at most 130 s. Adaptive thinking spends output tokens and time before the JSON. At the output caps the database will grant, a call may time out. A timeout is HELD (potentially billed, with no result). Real latency is unknown until the paid evaluation, and the caps should be set from it. Streaming or a background design may be needed.
2. **Unverified live behaviour.** These are documented, but not yet seen on the wire:
   - whether the API accepts `inference_geo: "global"` and `service_tier: "standard_only"` on these models;
   - whether the response `model` equals the requested id exactly;
   - whether `count_tokens` with `output_config` includes the structured-output overhead.

   If any of these differs, it fails **safe**: a refusal at USD 0, or HELD. It never under-counts. But it would block the evaluation until fixed.
3. **`count_tokens` is an estimate.** The 10% margin and the post-call check (`PROVIDER_INPUT_EXCEEDED`) cover small differences. The reserved input bound (`6 × bytes + …`) is far larger than real text token counts, so a mismatch is unlikely to matter.
4. **Refusals.** The models' safety classifiers may refuse some sales-psychology analyses. A refusal is billed and yields no result. The evaluation will show how often this happens.
5. **The prompt changes are untested for quality.** The new commercial-usefulness rules are only exercised for shape. Their value is exactly what the paid Sonnet-versus-Opus evaluation must measure.
6. **HELD reservations need manual reconciliation.** The provider's request id is logged for this. Settlement against Anthropic's usage records stays a manual founder step.
7. **SDK supply chain.** The SDK is pinned exactly (`0.133.0`, published 2026-10-09). `npm audit` reports nothing for it; its 2 findings (esbuild/vite, development server only) were there before this stage.

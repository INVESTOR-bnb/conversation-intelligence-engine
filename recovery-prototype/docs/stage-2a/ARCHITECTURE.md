# Revenue Recovery Engine — Stage 2A Architecture (approved)

Status: **approved with founder modifications** (2026-10-09). Implementation is
authorised one increment at a time; this document authorises nothing by itself.

Stage-1 baseline: tag `stage-1-baseline` → commit `92aa6832fe02e4496c612dfe103d08571f0dcb11`.

## 1. Purpose and boundaries

A human-supervised revenue-recovery system. The AI produces private,
evidence-referenced analysis; **the founder is the final authority** and
nothing reaches a client without founder approval. The system must be able to
conclude "do not pursue". It never contacts prospects.

Out of scope for Stage 2A: WhatsApp/messaging integrations, automatic or mass
outreach, billing/payments, analytics dashboards, autonomous agents, CRM,
native apps, multi-model orchestration, redesign of the approved Stage-1 UI.

## 2. Founder decisions (binding)

| Area | Decision |
|---|---|
| Frontend hosting | Cloudflare Pages (static build; no secrets in the bundle) |
| Backend | Supabase **Free** for development, **synthetic data only** |
| Auth | Supabase Auth, **invite-only email + password**; public sign-up disabled |
| Storage | Private Supabase Storage bucket; authorised, short-lived signed URLs only |
| AI | Server-side Anthropic API only. Start with a current **Sonnet**, evaluate against a suitable **Opus** |
| AI trigger | **Founder-triggered only** (initial analysis and reanalysis) |
| Messaging | No automatic prospect messaging, ever |
| Scores | No fabricated recovery scores (numeric score removed from the AI schema) |
| AI schema | Adds structured transcript, evidence references and a short client deal situation |
| Stage 1 demo | Preserved, selectable as demo mode |
| Uploads | Original readability preserved; ≤ 10 MB per image; ≤ 10 screenshots per case (start) |
| Budget | Anthropic API budget **$20** initially; token usage and estimated cost tracked; request limits enforced |
| Paid usage | No paid infrastructure or API usage without explicit founder authorisation |
| Retention | Provisional: screenshots deleted **30 days after case closure**; deletion controls designed in |
| Real data | Only after privacy, authorisation and third-party-processing documentation is approved |

### Security rules (binding)

1. Client isolation enforced **in the database** (row-level security + guarded functions), not in the UI.
2. Private founder intelligence never sent to client browsers.
3. Every client-visible recommendation requires founder approval.
4. Every analysis records the **evidence version** it was based on.
5. A **stale analysis cannot be approved** (evidence changed since analysis) without a new review.
6. **Explicit opt-outs / prohibited contact cannot be overridden for sales purposes.**
7. Service-role and Anthropic credentials never reach the frontend, the repository or chat.

## 3. System overview

```
Android browser ── Cloudflare Pages (static React build, anon key only)
   │  supabase-js (anon key + user JWT)
   ├─► Supabase Auth            invite-only; founder role held in DB, not in user metadata
   ├─► Postgres                 RLS on every table; all state changes via guarded RPCs
   ├─► Storage (private)        {business_id}/{case_id}/… ; signed URLs ≤ 60 s
   └─► Edge Function analyze-case   (founder JWT required)
          ├─ founder check → budget/rate check → case lock
          ├─ load evidence (service role, server-side only) → evidence manifest + version
          ├─ Claude Messages API, structured JSON output, no tools
          ├─ schema validation + server-side invariants
          └─ store analysis + usage/cost → AWAITING_ADMIN_REVIEW
```

**Demo mode** keeps the Stage-1 local store; **live mode** uses Supabase. Both
sit behind one data-access interface so the approved screens are unchanged.

## 4. Data protection model

- Client-visible data comes only from a **server-side projection** equivalent
  to Stage-1 `ClientCaseView` (`src/domain/clientView.ts`, covered by
  `tests/unit/clientView.spec.ts`).
- Founder notes, analyses, AI proposals, approvals history, contact
  restrictions and usage data have **no client read path**.
- Screenshot contents are untrusted input (may contain prompt-injection text).
  They are passed to the model as data, the model has no tools, output is
  schema-constrained, and results reach only the founder.
- Logs must not contain conversation text, screenshots, tokens or keys.

## 5. AI integration (Stage 2A-3, not yet authorised)

- Model IDs/pricing from the bundled Claude API reference (cached
  2026-10-06): `claude-sonnet-5-5` ($2 / $10 per MTok in/out) as the starting
  model; `claude-opus-5-5` ($4 / $20) as the comparison. **Re-verify against
  live official documentation / Models API at the start of 2A-3** before any
  call is made.
- Structured outputs (`output_config.format`, JSON schema) + backend schema
  validation; malformed or refused responses are stored as `ERROR` and never
  shown to clients.
- Server-side invariants (cannot be bypassed by model output): DO_NOT_PURSUE,
  any contact restriction, or a non-commercial conversation ⇒ no proposed
  message; detected opt-out ⇒ an `AI_DETECTED` contact restriction.
- Evidence items reference a screenshot number and a verbatim quote; there is
  no OCR cross-check, so founder review remains the control for misreadings.
- Estimated cost per 10-screenshot analysis (to be measured): Sonnet ≈
  $0.10–0.15, Opus ≈ $0.20–0.30. A 10-case evaluation on both models ≈ $3–5.
  The $20 budget allows roughly 4 evaluation rounds plus development runs.
- Spend controls: in-app monthly cap (stop at 90 % of $20), per-business and
  per-case daily limits, plus a spend limit on a dedicated Anthropic Console
  workspace as a hard backstop. A Claude subscription does not include API credit.

## 6. Implementation sequence

Each increment: tests run → changes and failures reported → security concerns
reported → separate commit → **stop for founder approval**.

| Step | Content | Exit criteria |
|---|---|---|
| **2A-0** ✅ | Repo audit, committed Playwright suite + unit tests, baseline tag, this document, 2A-1 plan | Stage-1 regression green |
| 2A-1 (DB layer done locally) | Schema, RLS, guarded RPCs, invite-only auth, founder role, demo/live data adapter | Isolation, escalation, stale-approval and opt-out tests pass locally **and** on the Supabase project |
| 2A-2 | Private storage, upload with progress/retry, reorder, content validation, idempotent submit, retention/deletion controls | Upload persistence, invalid-file and partial-failure tests |
| 2A-3 | `analyze-case` Edge Function, prompt v1, schema validation, usage/cost tracking, synthetic eval set (Sonnet vs Opus) | Real-content, uncertainty, non-commercial, opt-out, failure-safety tests |
| 2A-4 | Founder review/approval UI with immutable approval history | Edit-and-approve; stale approval blocked |
| 2A-5 | Client screens on the server projection | No unapproved or private data in responses; bundle secret scan |
| 2A-6 | Prospect response → founder-triggered reanalysis loop | Response creates new evidence version and analysis cycle |
| 2A-7 | Full regression, security review, Android test, one synthetic end-to-end recovery | All Stage-2A acceptance tests |

## 7. Open items before real client data

- Privacy notice and client terms covering third-party (prospect) data and
  sub-processors (Supabase, Anthropic, Cloudflare); legal review (likely
  Nigeria Data Protection Act 2023 — not legal advice).
- Confirm Anthropic API data-retention terms for the account.
- Supabase Pro (backups, no auto-pause) before real data.
- Final retention periods and a deletion runbook.

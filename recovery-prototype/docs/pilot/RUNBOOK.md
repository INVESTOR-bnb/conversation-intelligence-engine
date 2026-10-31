# Revenue Recovery Engine V0 — operating runbook (founder, Android)

Status labels: **TESTED OFFLINE** = automated tests in this repository; **VERIFIED ON STAGING** =
run against the real staging project; **REQUIRES FOUNDER ACTION** = needs your login, a
credential or an approval.

## Daily workflow (browser only, no terminal)

| Step | Where | Status |
|---|---|---|
| Business submits a stalled conversation (text or screenshots) | `/app/client` → New case | TESTED OFFLINE; backend VERIFIED ON STAGING |
| You see all submitted cases | `/app/founder` | TESTED OFFLINE; backend VERIFIED ON STAGING |
| You open a case and read the conversation | case page | TESTED OFFLINE; backend VERIFIED ON STAGING |
| You press **Run paid analysis** (one analysis plus independent review, capped at USD 1; offered only while paid analysis is switched on) | case page → Analysis | TESTED OFFLINE; deployed |
| You read the private report: evidence, hypotheses, uncertainty, the reviewer's challenges | case page | TESTED OFFLINE; backend VERIFIED ON STAGING (fake provider) |
| You approve, edit or mark RED, or request a re-analysis; a preview shows exactly what the business will get | case page → Your decision | TESTED OFFLINE (screens at 390px + real-database test `20_v0_workflow`) |
| The business sees only the approved message: Copy / Open in WhatsApp, then "I sent it" | `/app/client` → Open | TESTED OFFLINE (screens + real database) |
| The business adds the prospect's reply, records the outcome, or reports an opt-out | business case page | TESTED OFFLINE (screens + real database) |
| You see what was sent, the reply and the outcome | case page → After your decision | TESTED OFFLINE (screens + real database) |

Analysis runs only while AI spending is enabled. When it is off, the button is replaced by
"Analysis is currently switched off…" — by design.

## What a business sees (demo presentation)
Businesses and the sign-in page show "Revenue Recovery Engine" with a small DEMO label and
"Demo workspace · sample conversations only"; the New case form repeats that only sample
conversations may be submitted. Only your founder login shows "Staging · synthetic data only".
This is wording only: the restriction itself is unchanged (staging may hold synthetic data only),
and what each business can see is enforced by the database (tests `20_v0_workflow`,
`21_new_business_isolation`). Never use the demo for a real customer conversation.

## Deploying the new screens to the staging site (REQUIRES FOUNDER ACTION)
Pushes never deploy. GitHub (phone browser) → the repository → **Actions** →
"Deploy recovery prototype (Cloudflare Pages)" → **Run workflow** → branch
`claude/revenue-recovery-engine-stage-1-8xg8vf` → Run. Takes about 3 minutes.

## Paid analysis from the dashboard (durable Kimi configuration)
Configured once by the "Deploy recovery prototype" GitHub Actions workflow, target `paid-activate`
with `expected_sha` = the full commit hash to run (setup, token permissions and security:
`PAID-STAGING-WORKFLOW.md`). A gate job checks the run and the `staging-paid` environment's
protection first; the paid job then waits for your approval. It deploys the `analyze-case` code
without touching its settings, sets the Kimi settings, switches spending on with a USD 3
allowance and the USD 1 per-analysis cap (one atomic database change keyed on `id = true`),
prepares a synthetic case `DASH-PAID-…`, then runs a readiness check. It never calls Kimi and
never starts an analysis.
- **Each analysis:** open an eligible case → **Run paid analysis** → confirm. Nothing else.
- **Check without changing anything:** target `paid-readiness`.
- **Switch paid analysis off:** target `paid-deactivate` (the key is kept); `paid-deactivate-and-remove-key` also deletes the paid settings.
- **Deploying function code** (`deploy-analyze-case-2a6d.sh` with no option) never changes the provider; the fake provider is set only with `--set-fake`, which refuses while Kimi is configured. `deploy-analyze-case-staging.sh` is retired.
- The guarded Codespace script (`paid-pipeline-e2e.sh`) refuses while Kimi is configured; its `--paid-off` switches everything off.

## If something goes wrong
| Symptom | Do this |
|---|---|
| Paid analysis must stop now | GitHub → Actions → "Deploy recovery prototype" → Run workflow → target `paid-deactivate`, expected_sha = latest commit → approve |
| "HELD" in a paid-run result | Tell me the analysis id; I give you the one-line reconciliation SQL |
| "Run paid analysis" says the service is unreachable | Reload the page: the case state shows whether anything started |
| A business sees something it shouldn't | Stop sharing the link and tell me. Access is enforced by the database, tested 51/51 on staging |

## Demo: a Nigerian training academy (synthetic — every name, fee and reply is invented)
1. Sign in as the **test business** → New case → Reference `DEMO-ACADEMY-1`, product
   "Data analysis course", then paste:
   ```
   [05/10/2026, 19:12] Synthetic Prospect: Good evening. I want to ask about the data analysis course. When is the next class?
   [05/10/2026, 19:40] Synthetic Academy B: Good evening! Next cohort starts 20 October, 8 weeks, weekends.
   [05/10/2026, 19:41] Synthetic Prospect: How much is it?
   [05/10/2026, 19:55] Synthetic Academy B: The fee is 250,000.
   [05/10/2026, 20:03] Synthetic Prospect: Ok. Can it be paid in instalments?
   [06/10/2026, 11:30] Synthetic Academy B: Full payment is required before resumption.
   [09/10/2026, 10:00] Synthetic Academy B: Hello, registration closes soon. Should I reserve your seat?
   ```
   Submit. The seller in this paste is "Synthetic Academy B". If your test business has another
   name (the staging test business is "Synthetic Autos A"), replace "Synthetic Academy B" with that
   name before submitting, so the case and the conversation name the same business. A mismatch is
   cosmetic (the case still belongs only to the business that submitted it) but confuses a demo.
2. Sign in as **founder** → open the case → Run paid analysis → review the evidence, the competing
   explanations and the reviewer's challenge (the unanswered instalment question is the friction to look for).
3. Approve or edit the message → Release.
4. Back as the business → Open the case → only the approved message is shown → "I sent it".
5. Either show the reply loop: "The prospect replied" → paste `[SIMULATED] Can I pay half now and
   half in November?` → Add reply. The case returns to you for a new analysis and decision, and
   the outcome is recorded after that round.
6. Or close it directly from "Waiting for prospect": Record the outcome, with the note
   "SIMULATED DEMO — not a real sale".
Never present a demo outcome as a real recovery.

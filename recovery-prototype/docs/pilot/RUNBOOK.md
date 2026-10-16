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
| You press **Run analysis** (one analysis plus independent review; result in plain language) | case page → Analysis | TESTED OFFLINE — needs the new frontend deployed |
| You read the private report: evidence, hypotheses, uncertainty, the reviewer's challenges | case page | TESTED OFFLINE; backend VERIFIED ON STAGING (fake provider) |
| You approve, edit or mark RED, or request a re-analysis; a preview shows exactly what the business will get | case page → Your decision | TESTED OFFLINE (screens at 390px + real-database test `20_v0_workflow`) |
| The business sees only the approved message: Copy / Open in WhatsApp, then "I sent it" | `/app/client` → Open | TESTED OFFLINE (screens + real database) |
| The business adds the prospect's reply, records the outcome, or reports an opt-out | business case page | TESTED OFFLINE (screens + real database) |
| You see what was sent, the reply and the outcome | case page → After your decision | TESTED OFFLINE (screens + real database) |

Analysis runs only where AI spending is enabled. On staging spending stays **off** except inside a
guarded paid run (below), so "Run analysis" normally answers "AI spending is switched off" — by design.

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

## One guarded paid Kimi analysis (REQUIRES FOUNDER ACTION)
Codespace terminal, one line:
```
cd /workspaces/conversation-intelligence-engine/recovery-prototype && git checkout claude/revenue-recovery-engine-stage-1-8xg8vf && git pull --ff-only && bash supabase/scripts/paid-pipeline-e2e.sh
```
- **Another synthetic situation:** start the line's last command with `PAID_SCENARIO=academy-price ` (or `too-little`, `declined`).
- **Before you run it:** a new scoped Supabase token and a rotated Kimi key (see `PRIVACY-AND-PILOT-READINESS.md` and `../stage-2a/KIMI-FIRST-PAID-RUN.md`).
- **Cost:** at most about USD 0.37 reserved per run. Spending is switched off again automatically.
- **Judging the output:** `KIMI-QUALITY-EVALUATION.md`.

## If something goes wrong
| Symptom | Do this |
|---|---|
| A paid run was interrupted and spending may be on | Same Codespace line, but end it with `paid-pipeline-e2e.sh --paid-off` |
| "HELD" in a paid-run result | Tell me the analysis id; I give you the one-line reconciliation SQL |
| "Run analysis" says the service is unreachable | Reload the page: the case state shows whether anything started |
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
2. Sign in as **founder** → open the case → Run analysis → review the evidence, the competing
   explanations and the reviewer's challenge (the unanswered instalment question is the friction to look for).
3. Approve or edit the message → Release.
4. Back as the business → Open the case → only the approved message is shown → "I sent it".
5. Either show the reply loop: "The prospect replied" → paste `[SIMULATED] Can I pay half now and
   half in November?` → Add reply. The case returns to you for a new analysis and decision, and
   the outcome is recorded after that round.
6. Or close it directly from "Waiting for prospect": Record the outcome, with the note
   "SIMULATED DEMO — not a real sale".
Never present a demo outcome as a real recovery.

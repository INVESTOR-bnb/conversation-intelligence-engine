# Stage 2A-5d-4a — analysis pipeline core (offline, fake provider)

**Status.** Code and tests only.
- No AI provider is connected and no API key exists.
- Nothing is deployed and the live database is unchanged: no migration, no
  contract change.
- The Edge Function wrapper, a real provider, spend limits (5d-3) and the Run
  button (5d-6) come later.

## What it is

`supabase/functions/_shared/analysis-pipeline/` holds plain TypeScript. It uses
explicit `.ts` imports and erasable syntax only, so the same files run in a
Supabase Edge Function (Deno) and in the Node test suite. Everything with side
effects is injected:

| Interface | Runs as | Used for |
|---|---|---|
| `FounderDb` | the founder's own JWT (RLS applies) | restriction pre-check, `founder_start_analysis` (lock + snapshot), reading the snapshot's messages and screenshots, `founder_abandon_analysis` |
| `ServiceDb` | service role | **only** `internal_complete_analysis` |
| `AnalysisProvider` | — | one model call (a fake in tests) |
| `PipelineLogger` | — | event names, ids, codes and counts only |

## Flow

1. **Active restriction?** Refused with `CONTACT_RESTRICTED`, before an analysis
   row exists or any provider is called.
2. **`founder_start_analysis`.** The founder check, the usable-evidence check, the
   per-case lock and the frozen snapshot all stay in the database.
   - Refusals pass through as codes: `INSUFFICIENT_EVIDENCE`, `FORBIDDEN`,
     `INVALID_STATE` (an analysis is already running), `NOT_FOUND`.
3. **The snapshot's restriction list is checked again.** A restriction added
   between steps 1 and 2 is in the snapshot. Same fail-closed rule as the 2A-5d-1
   contract; no provider call.
4. **Evidence is loaded strictly from the snapshot** (manifest v2 only) and
   re-hashed: message text against `body_sha256`, screenshot bytes against
   `sha256`.
   - A missing item, a different hash, kind or position, a wrong file type or an
     oversize file fails closed before any call.
5. **Call A, the forensic analyst.**
6. **Call B, the adversarial reviewer.** This is a separate request with its own
   instructions and schema.
   - It gets the evidence and the analyst's output as data.
   - It never gets the analyst's instructions or reasoning.
   - If the reviewer fails, the run fails: an unreviewed analysis is never stored.
7. **Merge into `rre-analysis/2`.**
   - The review is stored exactly as written.
   - On `REJECT_RECOMMENDATION`, the message is removed. A recommendation that
     wasn't already DO_NOT_PURSUE is replaced by a fixed "No contact" WAIT action
     that says the review rejected it, and the classification becomes null.
   - The rejection stays visible (verdict unchanged, red card in the workspace).
8. **`internal_complete_analysis`.** The unchanged database contract decides.
   - A rejection there is reported as `REJECTED` / `CONTRACT_REJECTED`.

**Untrusted data.**
- Conversation text, screenshots and the analyst's output are passed as JSON with
  `<` encoded, so they can't contain a delimiter.
- Both prompts say the data is never an instruction, and the model has no tools.

**What the caller receives:** `{outcome, code, analysisId}`.
- No analysis content; the founder reads that through RLS.
- No provider or database text: errors are stored as `PIPELINE_ERROR: <CODE>`.

## Lock handling and its limit

From step 2 on, every handled failure records the analysis as `ERROR`. That
releases the lock, restores the case, and keeps any restriction the analyst
detected (2A-5b). If recording fails:
1. the pipeline checks whether the success write had in fact committed;
2. if not, it tries `founder_abandon_analysis`;
3. if that fails too, it returns `LOCK_HELD` with the analysis id.

**Not solvable in code:** if the host kills the run (hard wall-clock limit, crash,
out-of-memory), no code runs at all.
- The analysis stays `PENDING`, the case stays `ANALYZING`, and no new analysis
  can start for it.
- The pipeline keeps its own deadline (`deadlineMs`) and time back for the final
  write (`completionReserveMs`), so set `deadlineMs` well below the host's limit.
- **Recovery:** the founder runs
  `select public.founder_abandon_analysis('<analysis id>');` in the SQL Editor,
  until the Abandon button exists (5d-6).
- An analysis abandoned this way does not record restrictions the analyst had
  detected. This is reported as `restrictionsNotRecorded` in the log event.

## Tests
- `tests/unit/pipeline.spec.ts` (31): fake provider, in-memory database double.
- `tests/pipeline/pipeline-db.spec.ts` (17): the same core against the real
  database contract on a local PostgreSQL (`supabase/scripts/test-pipeline-db.sh`,
  migrations and deploy-file installs).
  - It covers fabricated citations by the analyst and by the reviewer, the
    real per-case lock, and recovery from LOCK_HELD via `founder_abandon_analysis`.
  - It confirms business users read nothing.
- `npm run check:functions`: type-checks the core and loads it with Node's native
  type stripping (which, like Deno, rejects non-erasable TypeScript).
- 19 mutation tests (weakened copies of the core); all were detected.

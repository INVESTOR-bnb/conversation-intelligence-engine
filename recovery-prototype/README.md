# Revenue Recovery Engine — Stage 1 Prototype

A clickable, mobile-first **frontend prototype** using **fake local data only**.
It is not production software. There is no backend, database, authentication,
AI call, messaging integration or payment integration. All "analysis" is
hand-written mock data or a deliberately simple local placeholder.

This folder is independent of the Python/Streamlit engine in the repository
root; nothing here calls it.

## Run

```bash
cd recovery-prototype
npm install
npm run dev        # http://localhost:5173 (also exposed on your LAN for phone testing)
```

Production-style static build: `npm run build`, then `npm run preview`.
To open it on an Android phone, run `npm run dev` and visit the "Network" URL
Vite prints, with the phone on the same Wi-Fi.

## Tests

```bash
npm run test:unit   # domain logic: privacy projection + state-machine guards (no browser)
npm run test:e2e    # builds, serves and runs the Stage-1 acceptance suite at 390px
npm test            # both
```

Uses `@playwright/test` (pinned to 1.56.1, which matches the Chromium build
preinstalled in the cloud dev environment). On another machine run
`npx playwright install chromium` once.

Stage 2A planning: `docs/stage-2a/ARCHITECTURE.md` (approved architecture) and
`docs/stage-2a/STAGE-2A-1-PLAN.md` (2A-1 plan and status), `docs/stage-2a/SUPABASE-SETUP.md` (runbook).

Database (Stage 2A-1): `supabase/migrations/` and `npm run test:db` (local
PostgreSQL with a Supabase emulation; requires PostgreSQL 16 binaries).

## Demo controls (Stage-1 only)

The dark bar at the top is a **prototype control, not authentication**.

- **Client Demo / Admin Demo** switches between the two interfaces.
- **Options → Client Demo views as** picks which fake business the client view
  shows (Pasom Autos, Fineez Designs Academy, Vee Culinary Arts, or any client
  added in the admin).
- **Options → Reset Demo Data** restores the original mock cases (asks for confirmation).

State is saved to this browser's `localStorage` so it survives a refresh. That
is a demo convenience, not persistence.

## Seeded cases

| Ref | Client | State at start | Shows |
|---|---|---|---|
| P-001 | Pasom Autos | Awaiting admin review (mock AI: GREEN) | Approval gate, client sees UNDER REVIEW |
| P-002 | Fineez Designs Academy | Approved YELLOW | Needs Clarification, diagnostic message |
| P-003 | Pasom Autos | Approved RED | Installment blocker, no message |
| P-004 | Pasom Autos | Approved GREEN (admin-edited) | Copy / I Sent It |
| P-005 | Vee Culinary Arts | Prospect replied → awaiting review | Response loop |
| P-006 | Vee Culinary Arts | Waiting for prospect (client changed message) | Add Prospect Response |
| P-007 | Pasom Autos | Won | Recovered view |

## Workflow notes

- The client adds the historical conversation primarily as **screenshots**
  (PNG/JPG/WebP, multiple, previewed in order, removable). "Paste conversation
  instead" is a secondary option. Screenshots stay in the browser as downscaled
  JPEG copies: there is no upload, storage service or OCR, so the admin reviews
  them visually. They are admin-only evidence and are never in the client view.
  Each real phone screenshot uses roughly 300 KB of the browser's ~5 MB local
  storage. Past that, the demo keeps working but stops saving across refreshes.
- Prospect responses after a recovery message are still typed/pasted as text.
- Submitting a case puts it in `ANALYZING`. A submitted prospect response puts it
  in `PROSPECT_REPLIED`. The admin presses **Run Mock Analysis** to move it to
  `AWAITING_ADMIN_REVIEW`. No AI runs.
- For cases created during the demo, the placeholder analysis lists only
  mechanically known facts. It marks everything else Unknown, defaults to YELLOW
  and proposes **no message**: the admin writes one. Explicit opt-out phrases
  (e.g. "don't contact me") force RED.
- Every approval stores both `mockAiProposedMessage` and `adminApprovedMessage`.
- Client screens receive only `ClientCaseView` (`src/domain/clientView.ts`), a
  field-by-field projection that contains no analysis, scores or notes.

## Structure

```
src/domain/      types, labels, client-safe projection, state transitions, mock-analysis placeholder
src/data/        seed mock data
src/state/       React store + localStorage
src/client/      client screens (C01–C13)
src/admin/       admin screens (A01–A03)
src/components/  shared UI + demo bar
```

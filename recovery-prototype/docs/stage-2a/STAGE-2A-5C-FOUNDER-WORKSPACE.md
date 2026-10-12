# Stage 2A-5c — founder-only analysis workspace (staging only)

**What it is.** A read-only "Analysis" section on the founder case page
(`/app/founder/case/<id>`) for reviewing an analysis that passed contract
`rre-analysis/1`. **No AI is connected**, so on staging every case shows "No
analysis yet" until an analysis exists.

## Security model
- **The boundary is the database, not the page.** The workspace reads
  `public.analyses`, `public.contact_restrictions` and `public.case_messages`
  directly. Their row-level security returns rows **only to the founder**
  (Stage 2A-1/2A-4b policies, unchanged).
  - A business user calling the Data API directly with their own session gets
    zero rows; an anonymous caller gets "permission denied".
  - Nobody can write to these tables through the API.
  - `supabase/tests/13_analysis_workspace_access.test.sql` runs the workspace's
    exact reads as each kind of caller.
- **The page is founder-only too:** the router shows it only to a
  server-verified FOUNDER, and a client is shown "Not authorised" without any
  request for analysis data being made.
- **No new database function, migration or grant.** This stage adds no API
  surface.
- **Nothing sends a message.**
  - The workspace has no send, approve or copy control and issues no writes.
  - A proposed message is shown only as "Draft for your review — not sent".
  - It is **withheld** when the case has an active contact restriction or the
    analysis is not current.
- **All analysis text is rendered as plain text**, never HTML.

## What the founder sees
- **A status line** for the latest analysis:
  - ready;
  - in progress;
  - insufficient evidence (only what is missing);
  - **stale** (evidence changed: kept for reference, marked, message withheld);
  - **rejected** (the contract reason, no findings);
  - failed.
- **Active contact restrictions first**, as "do not contact".
- **Evidence assessment and screenshots excluded** because their files were
  deleted.
- **Observed behaviour (evidence-backed)**, each with its citation.
  Screenshot quotes are labelled "model-reported, not verified".
- **Interpretations (hypotheses, not facts)**, grouped as:
  - emotional barriers;
  - trust and perceived risk;
  - buying motivations;
  - decision friction;
  - seller-created resistance.

  Each item is labelled *Stated by prospect* or *Hypothesis — interpretation,
  not fact*, and shows its confidence, uncertainty, supporting and
  contradicting observations, and competing hypotheses. A category with no
  evidence-backed hypothesis says so.
- **Unknowns.**
- **Adversarial challenges:**
  - contradicting evidence;
  - competing explanations;
  - weak support behind the recommendation;
  - reasons not to pursue;
  - open questions;
  - restrictions.

  These are drawn from the analysis itself; contract v1 has no separate
  challenger pass.
- **Recommendation (internal):** decision, strategy, psychological rationale,
  what it is based on, and the next action or diagnostic question.

## Deployment (after review)
- **Supabase:** nothing to deploy. Requires Stages 2A-5a and 2A-5b, which are
  already on staging.
- **Site:** the existing manual GitHub Actions workflow, started from
  `claude/revenue-recovery-engine-stage-1-8xg8vf`. It runs the unit, browser
  and live (mocked) tests before deploying to Cloudflare Pages.
- **Check on staging:**
  - as the founder, open any case: the Analysis section shows "No analysis
    yet";
  - as a client, open `/app/founder/case/<id>`: "Not authorised".
- **Rollback:** Cloudflare → `revenue-recovery-v0` → Deployments → previous →
  Rollback. There are no database changes to undo.

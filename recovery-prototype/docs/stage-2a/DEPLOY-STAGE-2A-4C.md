# Stage 2A-4c — screenshot intake (synthetic staging only)

**What changes**

- **Database:** one migration, `20261012120000_stage2a4c_screenshots.sql`.
  - a private Storage bucket `case-screenshots` (5 MB per file, PNG and JPEG only);
  - two Storage policies: members may upload into their own draft screenshot
    case; the founder may read;
  - three functions: `client_screenshot_status`, `client_finalize_screenshots`,
    and the upload rule `private.screenshot_upload_allowed`, plus an internal
    file lister;
  - one nullable column, `case_screenshots.file_deleted_at`.
- **Site:** "Upload screenshots" next to "Paste conversation" when creating a
  case, resuming incomplete drafts, and a founder screenshot viewer.
- **Unchanged:** the pasted-conversation workflow, onboarding, sign-in, 2A-4b
  RLS, and the audit log.

**What is NOT verified server-side.** Supabase Storage enforces only the size
limit and the *declared* file type. Nothing server-side checks that a stored file
is really an image, or that its SHA-256 (taken from the file name) is correct.
The phone re-encodes images and strips metadata, but a modified client could
skip that. **A server-side content check must exist before any analysis reads
these files.** Synthetic screenshots only.

---

## Order (each step needs your approval)

1. Database migration and verification (Step 1).
2. Frontend through the manual GitHub Actions workflow (Step 2).
3. Real Storage and Android tests with synthetic accounts and images (Step 3).

## Step 1 — Database (Supabase SQL Editor)

Files are in `recovery-prototype/supabase/deploy/` on branch
`claude/revenue-recovery-engine-stage-1-8xg8vf`. On GitHub: open the file → **Raw**
→ select all → copy → new query → paste → **Run**.

1. `stage2a4c_deploy.sql` — expected: "Success. No rows returned". All or nothing.
   It refuses, changing nothing, if:
   - 2A-4b is missing;
   - 2A-4c is already applied;
   - `storage.objects` already has policies (it names them);
   - the bucket exists and is public;
   - your SQL Editor role cannot bypass RLS (assumption A9 below).
2. `stage2a4c_verify.sql` — all rows **PASS**; rows 10 and 11 are INFO.
3. `stage2a4b_verify.sql` — **OVERALL PASS**.
4. `stage2a1_verify.sql` — **OVERALL PASS**, including rows 10, 12 and 20.

If anything says FAIL or REFUSED, stop and send the output. Do not deploy the site.

## Step 2 — Site

Use the existing manual workflow, started from
`claude/revenue-recovery-engine-stage-1-8xg8vf`. It runs the unit and browser
tests first.

## Step 3 — Real Storage and Android checks

You need two synthetic businesses, each with a linked synthetic client (A and B),
and a few made-up screenshots (draw or type a fake chat; no real people).

| # | Check | Expected | Proves |
|---|---|---|---|
| 1 | Client A: New case → Upload screenshots → pick 2 images → Submit Case | "submitted … with 2 screenshots"; case shows Under review | A1 upload works with INSERT only; A5 |
| 2 | Founder: open the case | both images, in order | founder read; download path |
| 3 | Client A: new screenshot case, turn on airplane mode after picking, Submit → error; turn it off, reload | draft shows "upload incomplete"; Continue → Submit Saved Screenshots / Upload and Submit works | resume |
| 4 | SQL Editor: `stage2a4c_isolation_check.sql` with client B's user ID and client A's business and case IDs | `REFUSED…`, `0`, `REFUSED: NOT_FOUND…`, `CLIENT` | cross-business isolation (it *attempts* a write, always rolled back) |
| 5 | Signed out, open `https://aqwdwswpmbnzmkvyuqil.supabase.co/storage/v1/object/public/case-screenshots/<any path>` | error, no image | bucket is not public |
| 6 | Client A: pick a 6 MB PNG photo of noise / a large photo | the app converts it or explains it is too large | client limit (server limit via 7) |
| 7 | Read-only SQL: `select name, owner_id, metadata->>'size', metadata->>'mimetype' from storage.objects where bucket_id = 'case-screenshots';` | `owner_id` = client A's user ID; size and type present | A2, A3 |
| 8 | Paste-conversation case, onboarding, sign-out | still work | no regression |

The browser IDs for check 4 are on the founder case page (address bar) and the
founder business list. The user ID is on the client's "Account not yet
authorised" screen, or in Supabase → Authentication → Users.

## Rollback

- **Site:** Cloudflare → `revenue-recovery-v0` → Deployments → previous → Rollback.
- **Database:** `stage2a4c_rollback.sql`, then `stage2a4b_verify.sql` and
  `stage2a1_verify.sql`.
  - It removes the two policies and the new functions.
  - It **keeps** every `case_screenshots` row, the audit history, the bucket and
    its files. Without policies, no API user can reach the files; delete them
    in the dashboard if you want.
  - It keeps `file_deleted_at` if any row has a retention timestamp; the schema
    then differs from 2A-4b by that one nullable column. The audit entry
    records which happened.
  - A second run is refused. Re-deploying afterwards works.

## Retention (manual; synthetic staging only)

1. `admin/screenshot_retention_report.sql` (read-only) lists eligible files:
   - closed cases at least 30 days after closure;
   - drafts older than 7 days;
   - unrecorded files older than 7 days.
2. Delete those files in **Supabase → Storage → case-screenshots**.
3. `admin/screenshot_mark_deleted.sql` sets `file_deleted_at` only where the
   file is confirmed gone, and writes `SCREENSHOT_FILES_DELETED`. It never
   deletes rows. Re-running it is harmless.

The founder then sees "File deleted under retention" for those screenshots.
Records and hashes stay as evidence.

## Assumptions still to confirm on staging

| # | Assumption | Check |
|---|---|---|
| A1 | Storage uploads succeed with only the INSERT policy (no read-back) | Step 3 #1 |
| A2 | `owner_id` is set by Storage from the signed-in user | Step 3 #7 |
| A3 | `metadata.size` is the stored size; `metadata.mimetype` is the declared type | Step 3 #7 |
| A4 | Bucket size and type limits are enforced by Storage | Step 3 #6, plus an optional upload of a disguised file via a tool |
| A5 | The SQL Editor role may create the bucket, storage policies and cross-schema helper; Storage's `authenticated` role can run the upload rule | Step 1 succeeds; Step 3 #1 |
| A6 | Deleting in the dashboard removes the stored file | retention runbook |
| A7 | List, copy and move map to SELECT, INSERT and UPDATE | the policies allow none of these for clients |
| A8 | **File contents and hashes are not verified server-side** | known; must be fixed before AI analysis |
| A9 | The deploying role (`postgres`) bypasses RLS, so the helpers see every stored file | deploy preflight and verify row 7 check this |

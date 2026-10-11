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
3. Real Storage API script, then Android tests, with synthetic accounts and images (Steps 3a and 3b).

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
   - row level security is off on `storage.objects`;
   - your SQL Editor role cannot bypass RLS (assumption A9 below);
   - your role lacks SELECT on `storage.objects` ("the helpers need it") or
     SELECT/INSERT/UPDATE on `storage.buckets` ("needed to create the bucket").
   Its last step re-checks the result. Then it aborts and undoes everything
   ("DEPLOYMENT ABORTED") if any of these is wrong: RLS, the exact policy
   expressions, the helper owner's SELECT on `storage.objects`, or the function
   privileges.
2. `stage2a4c_verify.sql` — expected OVERALL: **PASS (12 pass, 0 fail, 2 info)**.
   Rows 10 and 11 are INFO. The rows added after the audit:
   - row 12: RLS is enabled on `storage.objects`;
   - row 13: both policy expressions are exactly the reviewed ones (the detail
     column shows the actual expressions);
   - row 14: the helpers' owner has SELECT on `storage.objects`.
   If row 13 alone FAILs, send its detail column before doing anything else. It
   can be a false alarm if staging's PostgreSQL prints the same expression
   differently. It can also be a real edit; the detail tells which.
3. `stage2a4b_verify.sql` — **OVERALL PASS**.
4. `stage2a1_verify.sql` — **OVERALL PASS**, including rows 10, 12 and 20.

If anything says FAIL or REFUSED, stop and send the output. Do not deploy the site.

## Step 2 — Site

Use the existing manual workflow, started from
`claude/revenue-recovery-engine-stage-1-8xg8vf`. It runs the unit and browser
tests first.

## Step 3a — Real authenticated Storage API test (script)

`supabase/scripts/storage-live-check.mjs` calls the real Storage API with the
same library the app uses, signed in as three **synthetic** accounts. It runs
no SQL in the editor, needs no secret key (it refuses one), and changes
nothing except creating two synthetic cases and a few test files.

**You need:**
- the staging URL;
- the publishable key (`sb_publishable_…`, the same one the site uses);
- synthetic client A and synthetic client B, in **different** synthetic
  businesses;
- the founder account.

**Where to run it from Android** (pick one; never paste a password into chat,
an issue or a commit):
- **GitHub Codespaces** (browser): on the repository page choose Code →
  Codespaces → create on branch `claude/revenue-recovery-engine-stage-1-8xg8vf`.
  In its terminal run `cd recovery-prototype && npm ci`.
- **Termux:**
  1. `pkg install nodejs-lts git`.
  2. Clone the repository and check out the branch.
  3. `cd recovery-prototype && npm ci`.

Node 20 or newer. Then type each value at a hidden prompt, so it is not saved
in shell history:

```sh
read -r  -p 'Staging URL: '        RRE_SUPABASE_URL
read -r  -p 'Publishable key: '    RRE_PUBLISHABLE_KEY
read -r  -p 'Client A email: '     CLIENT_A_EMAIL
read -rs -p 'Client A password: '  CLIENT_A_PASSWORD; echo
read -r  -p 'Client B email: '     CLIENT_B_EMAIL
read -rs -p 'Client B password: '  CLIENT_B_PASSWORD; echo
read -r  -p 'Founder email: '      FOUNDER_EMAIL
read -rs -p 'Founder password: '   FOUNDER_PASSWORD; echo
export RRE_SUPABASE_URL RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD
node supabase/scripts/storage-live-check.mjs
```

Close the terminal afterwards. Send back the printed lines; they contain no
passwords or keys.

**Expected:** every line PASS, except the lines below. The last line says
`… 0 fail …`, and the exit code is 0.
- `INFO plain text declared as image/png — ACCEPTED`: expected. It confirms A8
  (contents are not validated).
- The signed-upload-URL line: PASS or WARN (see below). Either result is safe,
  but tell me which.

| Group | What it does through the real API | Proves |
|---|---|---|
| Upload | client A uploads a 1×1 synthetic PNG with `upsert: false` | A1 (INSERT-only policy is enough) |
| Metadata | reads back size and type through `client_screenshot_status` | A3: `metadata.size` = bytes sent; `metadata.mimetype` = declared type |
| Client A's own file | download, list, signed download URL, copy, move, upsert, update, delete | all refused; the founder can still download it after A's delete attempt (A7) |
| Client B | upload into A's case, download, list, sign, status | all refused (isolation) |
| Anonymous | download; the public URL | refused (private bucket) |
| Bucket limits | a 6 MB file; `image/gif` | refused by Storage (A4) |
| Contents | plain text declared `image/png` | INFO — Storage accepts it (A8) |
| Signed upload URL | created while the case is a draft, used after it is submitted | see below |
| Founder | download (bytes match the hash in the name); exactly one recorded row; founder upload attempt | founder read works; founder cannot upload |

It leaves two synthetic cases named `LIVE-CHECK-<time>` (submitted) and
`LIVE-CHECK-<time>-X` (abandoned draft holding the text file). The retention
runbook below removes the draft's file after 7 days.

### Signed upload URLs (`createSignedUploadUrl`)

The app does not use signed upload URLs, but any signed-in client can request
one for a path the upload rule allows at that moment.

- **Unconfirmed:** whether Storage re-applies the INSERT policy when the URL
  is *used*, rather than only when it is *created*. I have not confirmed this
  against Storage's source. That is why the script tests it.
- **PASS** — the use after submission was refused, so the rule is re-checked
  at upload.
- **WARN** — the use was accepted. The file then sits in the submitted case's
  folder but is never recorded:
  - finalize refuses any case that is not a draft;
  - the founder viewer shows recorded screenshots only;
  - the retention report lists it as an unrecorded file.

  It also means one URL per position could exceed 10 files, or place two files
  at one position, in a draft. Finalize refuses such a draft ("conflicting
  screenshots"), so nothing unchecked is recorded. The worst outcome is a
  client spoiling their own draft or leaving stray files in their own
  business's folder.
- **Also unconfirmed:** whether a file uploaded through a signed URL gets
  `owner_id`. If it does not, finalize refuses it as "failed checks", which is
  safe.

### How Storage metadata is used

- **`owner_id`:** set by Storage from the signed-in user (A2). Finalize records
  a file only if `owner_id` equals the caller. So another member of the same
  business cannot have their upload recorded under someone else's
  finalization.
- **`metadata.size`:** must be between 1 byte and 5 MB.
- **`metadata.mimetype`:** must match the extension in the name (`png` →
  `image/png`, `jpg` → `image/jpeg`).
- **Recording:** size and type are copied into `case_screenshots`.
- **Status function:** clients see position, hash (from the file name), size
  and type, and never paths.
- **Not checked:** the hash and the actual contents (A8).

## Step 3b — Real Storage and Android checks (manual)

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

## Uploads that happen while finalizing or submitting

Uploads do not lock the case, so a file can arrive while
`client_finalize_screenshots` is running.

- **Snapshot:** finalize reads the case's stored files **once**. Every check
  and the INSERT use only that snapshot, and the INSERT re-applies the
  per-file checks:
  - uploader is the caller;
  - size is 1 byte–5 MB;
  - type matches the extension;
  - position is 1–10, with no duplicates and no gaps;
  - nothing conflicts with existing records.
- **Late files:** a file committed after that read is not recorded by that
  call. The next finalize checks it like any other.
- **Count check:** finalize then refuses unless the case's records exactly
  equal the checked files.
- **Row lock:** finalize and submit take a row lock on the case, so they run
  one after the other. A file that lands while a submission is committing stays
  unrecorded: finalize refuses non-draft cases.
- **Tests:** `supabase/scripts/test-concurrency-2a4c.sh` reproduces each of
  these with real concurrent sessions, including the pre-fix version of the
  function as a control.

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
| A1 | Storage uploads succeed with only the INSERT policy (no read-back) | Step 3a upload line; Step 3b #1 |
| A2 | `owner_id` is set by Storage from the signed-in user | Step 3b #7 |
| A3 | `metadata.size` is the stored size; `metadata.mimetype` is the declared type | Step 3a metadata lines; Step 3b #7 |
| A4 | Bucket size and type limits are enforced by Storage | Step 3a (6 MB, GIF); Step 3b #6 |
| A5 | The SQL Editor role may create the bucket, storage policies and cross-schema helper; Storage's `authenticated` role can run the upload rule | Step 1 succeeds; Step 3a upload line |
| A6 | Deleting in the dashboard removes the stored file | retention runbook |
| A7 | List, copy and move map to SELECT, INSERT and UPDATE; signed upload URLs | Step 3a (copy, move, list, signed-URL lines) |
| A8 | **File contents and hashes are not verified server-side** | known; must be fixed before AI analysis |
| A9 | The deploying role (`postgres`) bypasses RLS and may read `storage.objects`, so the helpers see every stored file | deploy preflight; verify rows 7 and 14 |
| A10 | Staging PostgreSQL prints the policy expressions the same way as local PostgreSQL 16 | verify row 13 (see Step 1) |

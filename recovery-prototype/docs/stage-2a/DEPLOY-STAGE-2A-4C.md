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
4. Stage 2A-4c-1 upload guard (Step 4), then Step 3a again.

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
no SQL and changes nothing except creating two synthetic cases and a few test
files. Before connecting to anything, it refuses to start unless:
- the URL is exactly `https://aqwdwswpmbnzmkvyuqil.supabase.co` (staging), and
- the key starts with `sb_publishable_`. Secret keys and legacy `eyJ…` keys are
  refused, because a legacy key could be the service_role key.

It never prints an email, password, key or token. When it finishes, it signs
out the three sessions it opened, including after a failure or Ctrl-C. It uses
"this session only" sign-out, so your phone and other devices stay signed in.

**You need:**
- the publishable key (`sb_publishable_…`, the same one the site uses);
- synthetic client A and synthetic client B, in **different** synthetic
  businesses;
- the founder account.

Use **GitHub Codespaces** in Chrome on Android. Termux is not recommended: it
needs a separate GitHub login to clone the private repository. Never paste a
password into chat, an issue, a commit or a file.

### Before you start: protect what you type on the phone

- **Keyboard:** a terminal is not a password box, so your keyboard may learn
  and later suggest what you type. Open the Codespace in a **Chrome Incognito
  tab**: Gboard stops learning in Incognito tabs. Otherwise, turn off your
  keyboard's personalised suggestions or "learn from typing" setting for the
  test.
- **Clipboard:** type passwords rather than pasting them. If you do paste one
  from a password manager, delete it from the keyboard's clipboard history
  afterwards (in Gboard: clipboard icon → long-press the item → Delete).
- Keep the screen on during the run. If the phone sleeps and the tab
  disconnects, the script cannot sign out.

### 1. Open a Codespace

On the repository page: **Code → Codespaces → ⋯ → New with options**. Choose
branch `claude/revenue-recovery-engine-stage-1-8xg8vf` and the smallest
machine, then open its **Terminal**.

### 2. Prepare: bash, no history, install (no credentials yet)

Type these one line at a time:

```sh
bash
echo "$0"
set +o history
unset HISTFILE
cd "$(git rev-parse --show-toplevel)/recovery-prototype"
git log --oneline -1
npm ci
```

- `echo "$0"` **must print `bash`**. The hidden prompts below only work in
  bash; in another shell a password could end up visible on the command line.
- `set +o history` and `unset HISTFILE` stop anything you type from now on
  being saved to shell history.
- `git log` must show the commit you were told to test.
- `npm ci` installs packages **before** any credential exists in this
  terminal. Package install scripts can read whatever settings are set at the
  time.

### 3. Enter the values at prompts (passwords are hidden)

```sh
RRE_SUPABASE_URL=https://aqwdwswpmbnzmkvyuqil.supabase.co
read -r  -p 'Publishable key: '    RRE_PUBLISHABLE_KEY
read -r  -p 'Client A email: '     CLIENT_A_EMAIL
read -rs -p 'Client A password: '  CLIENT_A_PASSWORD; echo
read -r  -p 'Client B email: '     CLIENT_B_EMAIL
read -rs -p 'Client B password: '  CLIENT_B_PASSWORD; echo
read -r  -p 'Founder email: '      FOUNDER_EMAIL
read -rs -p 'Founder password: '   FOUNDER_PASSWORD; echo
export RRE_SUPABASE_URL RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD
```

Nothing appears while you type a password; that is expected. If you make a
mistake, re-run that one `read` line.

### 4. Run, then clear everything

```sh
node supabase/scripts/storage-live-check.mjs; echo "exit code: $?"
unset RRE_SUPABASE_URL RRE_PUBLISHABLE_KEY CLIENT_A_EMAIL CLIENT_A_PASSWORD CLIENT_B_EMAIL CLIENT_B_PASSWORD FOUNDER_EMAIL FOUNDER_PASSWORD
env | grep -E 'RRE_|_EMAIL|_PASSWORD' || echo "cleared"
exit
```

The last check must print `cleared`.

1. Copy the printed test lines. Glance over them first: they should contain no
   password. If one ever appears, do not send it; change that password.
2. Stop and delete the Codespace: **github.com/codespaces → ⋯ next to it →
   Delete**. Closing the tab is not enough.
3. Close the Incognito tab.

### Expected output

Every check line is PASS, except:
- `INFO plain text declared as image/png — ACCEPTED`: expected. It confirms A8
  (contents are not validated).

Since Stage 2A-4c-1 (Step 4), both signed-upload-URL checks must PASS. Before
it, the "after submission" line is a FAIL; that is the known issue Step 4
fixes.

Then come these lines, in this order:
- `== N pass, 0 fail, …`;
- `Synthetic cases created: LIVE-CHECK-<time>, LIVE-CHECK-<time>-X (for cleanup).`;
- three lines `CLIENT_A / CLIENT_B / FOUNDER: signed out (this session only)`;
- `exit code: 0`.

The run is only valid if these two lines PASS, because the script counts any
error, including a network failure, as "refused":
- `client A uploads a valid PNG…`;
- `founder downloads the screenshot…`.

| Message | Meaning | What to do |
|---|---|---|
| `refused: this is not the staging project` | The URL is not exactly the staging URL | Re-run step 3 |
| `refused: … Use the publishable key` | A secret, legacy or malformed key was typed | Re-enter the `sb_publishable_…` key |
| `missing environment variable …` | A value is empty | Re-run that `read` line |
| `stopped: …` (exit code 2) | The run stopped early; its sessions were still signed out | Send me the lines |
| `WARN … sign-out failed` | One session could not be signed out | Tell me; that session's token expires on its own |
| any `FAIL` (exit code 1) | A security check failed | Send me the lines |

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

It leaves the two synthetic cases named on the `Synthetic cases created` line:
`LIVE-CHECK-<time>` (submitted) and `LIVE-CHECK-<time>-X` (abandoned draft
holding the text file). The retention
runbook below removes the draft's file after 7 days.

### Signed upload URLs (`createSignedUploadUrl`)

The app does not use signed upload URLs, but any signed-in client can request
one for a path the upload rule allows at that moment.

**What staging showed (before Stage 2A-4c-1):** a URL created while the case
was a draft still worked after the case was submitted. The file landed in the
submitted case's folder, unrecorded.

**Why (confirmed in Supabase Storage's source):**
- Creating a signed upload URL checks the INSERT policy as the client.
- *Using* the URL only checks the URL's signature. Storage then writes the file
  as `service_role`, which bypasses row level security, so the policy is never
  re-checked.
- Every ordinary upload is also finally written as `service_role`, after the
  policy was tested as the client. The URL stays usable for its whole lifetime
  (Supabase documents two hours).

**What a client could do with this** (only a signed-in member of the business,
only in that business's own folder):
- **Observed:** add unrecorded files to a submitted case.
- **From the source, not observed:** with URLs created for many file names at
  a free position, add an unlimited number of files of up to 5 MB each.
- **From the source, not observed:** with a URL created with `upsert`, replace
  the *contents* of a screenshot that is already recorded. The founder would
  then see a different image than the one submitted, while the record keeps
  the original hash and size.

What it could **not** do: reach another business, read any file, or get a file
recorded. Finalize only works on drafts, and the founder viewer shows only
recorded screenshots.

**Fix: Stage 2A-4c-1 (Step 4).** A trigger on `storage.objects` re-applies the
upload rule to every insert into this bucket made without row level security
— Storage's own writes. It checks that:
- the recorded uploader is a member of the business;
- the case is an open screenshot draft;
- the position is free;
- the case holds fewer than 10 files.

Storage's replace (upsert) is an insert too, so it is covered. Client uploads
checked by the policy are unchanged.

### Stage 2A-4c-1 — what the guard does not cover

- Two truly simultaneous uploads to the same position can still both land;
  finalize then refuses the draft as "conflicting screenshots" (unchanged).
- If Storage's upload fails at the database step, Storage removes the bytes it
  wrote. I have read this in Storage's source but not observed it.
- Storage's *move* is an update, not an insert. Clients have no update policy,
  so Storage refuses a client's move before writing. Only `service_role` or the
  dashboard could move files.

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

## Step 4 — Stage 2A-4c-1: upload guard (Supabase SQL Editor)

Run after Stage 2A-4c, in the **staging** project only. Files are in
`recovery-prototype/supabase/deploy/`.

1. `stage2a4c1_deploy.sql` — expected: "Success. No rows returned". All or
   nothing. It refuses, changing nothing, if:
   - Stage 2A-4c is missing;
   - 2A-4c-1 is already applied;
   - your role lacks the TRIGGER privilege on `storage.objects` (see below);
   - your role cannot bypass RLS.

   Its self-check aborts and undoes everything if the trigger, the function or
   its privileges are not exactly as reviewed.
2. `stage2a4c1_verify.sql` — expected **PASS (7 pass, 0 fail, 1 info)**.
   - Row 8 (INFO) counts unrecorded files, such as the one from the earlier
     live test.
   - If row 3 alone FAILs, send its detail column. As with 2A-4c row 13, the
     cause can be PostgreSQL printing the same definition differently.
3. `stage2a4c_verify.sql`, `stage2a4b_verify.sql`, `stage2a1_verify.sql` — all
   **OVERALL PASS**.
4. Run the live check (Step 3a) again. Every line must PASS, including:
   - `upload with that URL after submission is refused`;
   - `the first is accepted while the case is a draft`;
   - `the second is refused: the position is now taken`.

   The legitimate upload lines must still PASS, which shows the guard doesn't
   block real uploads.

**If the deploy says "lacks the TRIGGER privilege on storage.objects":** stop.
Your project does not let the SQL Editor role add triggers to Storage's table,
so the database cannot enforce this. Do not try to work around it. The secure
alternative is server-mediated: uploads go through a small server function that
re-checks the case and writes with the service key. Clients then get no
INSERT policy and no way to request signed URLs. That is a larger change and
needs its own approval. Until then, the risk stays as described above, and the
cleanup report below finds any stray files.

**Rollback:** `stage2a4c1_rollback.sql`.
- It removes only the trigger and its function, keeps every file, record and
  audit entry, and is audited.
- `stage2a4c_rollback.sql` refuses to run while the guard is installed: roll
  back 2A-4c-1 first.

## Cleaning up synthetic live-check cases and files

The live check creates two cases per run, named `LIVE-CHECK-<time>` and
`LIVE-CHECK-<time>-X`, plus a few small files.

1. **List** (read-only): run `admin/live_check_cleanup_report.sql` in the SQL
   Editor. It shows:
   - each LIVE-CHECK case with its `folder_to_delete` and file counts;
   - every unrecorded file in any other case, such as the file from the
     signed-URL test.
2. **Delete the files** in **Supabase → Storage → case-screenshots**: open each
   listed folder (business ID, then case ID), select all files → Delete. Delete
   each listed unrecorded file the same way.
   - Do not delete in SQL: Supabase blocks direct deletes from
     `storage.objects`, and they would leave the stored bytes behind.
   - The guard does not affect deleting.
3. **Mark the records:** run `admin/screenshot_mark_deleted.sql`. It sets
   `file_deleted_at` on recorded rows whose file is gone and audits it. It
   never deletes rows.
4. **Re-run the report:** `stored_files` must be 0 for every LIVE-CHECK case,
   with no unrecorded files listed.

The case rows and audit entries stay as the record of the test. They are
synthetic and clearly named. Deleting case rows is not part of this procedure
and would need separate approval.

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
| A7 | List, copy and move map to SELECT, INSERT and UPDATE | Step 3a (copy, move, list lines) |
| A11 | Storage writes signed and ordinary uploads through an INSERT that fires the 2A-4c-1 guard; the SQL Editor role may create triggers on `storage.objects` | Step 4 deploy succeeds; Step 3a signed-URL and upload lines |
| A8 | **File contents and hashes are not verified server-side** | known; must be fixed before AI analysis |
| A9 | The deploying role (`postgres`) bypasses RLS and may read `storage.objects`, so the helpers see every stored file | deploy preflight; verify rows 7 and 14 |
| A10 | Staging PostgreSQL prints the policy expressions the same way as local PostgreSQL 16 | verify row 13 (see Step 1) |

# Stage 2A-1 — HTTPS staging site and invite-only sign-in (Android runbook)

Everything below is done from an Android phone in Chrome. No terminal is
needed. **Synthetic data only.** Never paste a secret key, service-role key,
database password or access token anywhere in this process or into chat.

Supabase project URL (note the spelling, **…uqil**, not …uqli):

```
https://aqwdwswpmbnzmkvyuqil.supabase.co
```

Do the steps in order. Each step names what must be true before the next.

---

## Step 1 — Create the Cloudflare Pages project (the one next action)

1. Open <https://dash.cloudflare.com> → **Workers & Pages** → **Create** →
   **Pages** tab → **Connect to Git**.
2. Authorise GitHub and select **only** the repository
   `investor-bnb/conversation-intelligence-engine`.
3. Set up builds and deployments:

   | Field | Value |
   |---|---|
   | Project name | e.g. `rre-staging` (this becomes `https://rre-staging.pages.dev`) |
   | Production branch | `claude/revenue-recovery-engine-stage-1-8xg8vf` |
   | Framework preset | None |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory (advanced) | `recovery-prototype` |

4. Under **Environment variables (advanced)** add, **before** the first deploy:

   | Variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://aqwdwswpmbnzmkvyuqil.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API Keys → **Publishable key** (`sb_publishable_…`) |
   | `NODE_VERSION` | `22` |

   Use the **publishable** key only. If you paste a secret (`sb_secret_…`) or
   service-role key by mistake, the site refuses to run and shows
   "misconfigured and has been stopped for safety" — delete the variable,
   rotate that key in Supabase, and set the publishable key instead.

5. **Save and Deploy.** Wait for "Success".

**Check (must pass before Step 2):** open `https://<your-project>.pages.dev`
on the phone. You must see the **Sign in** page with a "Staging · synthetic
data only" bar and **no** sign-up option.

- If you instead see the Stage-1 demo (Inbox / cases with fake data), the
  environment variables were missing at build time: add them under
  *Settings → Variables and Secrets* for **Production**, then *Deployments →
  … → Retry deployment*.
- `.pages.dev` is served over HTTPS automatically. The build also publishes
  security headers (`_headers`): a Content-Security-Policy that only allows
  connections to the Supabase project, no framing, no referrer.

Note the exact URL, e.g. `https://rre-staging.pages.dev`. It is called
`<SITE>` below. Do not use a preview URL (`https://<hash>.<project>.pages.dev`)
— those change on every deploy.

---

## Step 2 — Tell Supabase where the site is

Only after Step 1's check passes. Supabase → **Authentication** →
**URL Configuration**:

| Setting | Value |
|---|---|
| Site URL | `<SITE>` (exactly, no trailing slash, e.g. `https://rre-staging.pages.dev`) |
| Redirect URLs → Add URL | `<SITE>/auth/callback` |

No wildcards. Remove `http://localhost:3000` from Site URL if it is still
there. Invitations sent from the dashboard return to the **Site URL**; the app
handles the invitation at `/` as well as `/auth/callback`.

Also confirm (Authentication → **Sign In / Providers**):

- **Allow new users to sign up: OFF** (invite-only).
- Email provider enabled; **Confirm email: ON**.
- Anonymous sign-ins: OFF.

---

## Step 3 — Send a fresh founder invitation

**Only now** — after the site loads the Sign in page over HTTPS **and** the
Site URL / Redirect URL are saved. Any invitation sent earlier points to the
old Site URL and must not be used.

If your email already exists under Authentication → Users from an earlier
attempt and has never set a password, delete that user first (this only
removes an unused synthetic login), then:

Authentication → Users → **Invite user** → your email.

---

## Step 4 — Accept the invitation on the phone

1. Open the email **on the phone** and tap the link (within 24 hours; it
   works once).
2. You land on **Set your password** (the tokens are removed from the address
   bar). Choose at least 10 characters and confirm it.
3. You then see **Account not yet authorised** with your **Email** and
   **User ID**. That is correct: no one has any access until the database says so.
4. Copy the User ID (long-press → copy).

If the page says the link **has expired or has already been used**: send a
new invitation (Step 3). Do not reuse old emails.

---

## Step 5 — Make yourself founder (one time)

Supabase → **SQL Editor** → new query → paste the contents of
`supabase/admin/bootstrap_founder.sql` → replace:

- `REPLACE_WITH_FOUNDER_EMAIL` → your email
- `REPLACE_WITH_FOUNDER_USER_ID` → the User ID copied in Step 4

→ **Run**. Expected: `NOTICE: Founder role granted to <email>`.

The script changes nothing and stops with a message if the email and User ID
do not belong to the same account, the invitation was not completed (no
password / never signed in), the account is a client member, or another
founder already exists. Running it twice is harmless.

Back on the site: tap **Check again** (or reload). You land on **Founder
workspace**. The Stage-1 prototype (mock data) is at `<SITE>/demo` for the
founder only.

---

## Step 6 — Phone checks (report the results)

1. Sign out → sign in again with the new password → founder workspace.
2. Close Chrome completely, reopen `<SITE>` → still signed in.
3. Sign out, then open `<SITE>/app/founder` → you are sent to Sign in.
4. Sign in with a wrong password → "Email or password is incorrect."
5. Tap the (already used) invitation link again → "expired or has already
   been used" message, no access.

---

## What the app enforces, and what it does not

- The role comes **only** from the database (`public.whoami()`), never from
  user metadata, the URL or the browser. If it cannot be checked, access is
  denied.
- Route guards in the browser are convenience. The protection that matters is
  Row Level Security and the guarded functions, tested locally
  (`npm run test:db`) — **not yet re-run against the staging project**.
- There is no sign-up form, no password-reset screen yet, and no client
  onboarding UI; clients are linked by the founder via SQL functions in a
  later step.

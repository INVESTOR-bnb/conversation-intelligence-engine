# Verified pre-existing objects in the staging project

`rls_auto_enable.verified.sql` is the definition of `public.rls_auto_enable()`
exactly as read from the Supabase staging project with `pg_get_functiondef`
(founder-verified, 2026-10-10). It is Supabase's "automatically enable RLS on
new tables" helper, called by the event trigger `ensure_rls`
(`ddl_command_end`).

It is **reference data only**: the deployment never runs it, never replaces,
drops or alters the live function or its event trigger, and never changes its
privileges. `scripts/build-deploy.sh` copies the function body from this file
into the preflight guard, which accepts the live function only if it matches:

| Property | Required |
|---|---|
| Schema / name / arguments | `public.rls_auto_enable()`, exactly one overload, plain function |
| Returns / language | `event_trigger` / `plpgsql` |
| Owner | `postgres` |
| Security | `SECURITY DEFINER` with `search_path=pg_catalog` and no other settings |
| Body | identical to this file after whitespace normalisation (see below) |
| Callers | exactly one event trigger, named `ensure_rls`, on `ddl_command_end`; no table triggers; nothing else depends on it |

Whitespace normalisation: leading/trailing whitespace removed and every run of
whitespace (spaces, tabs, newlines) collapsed to one space, on both sides. This
tolerates copy/paste or line-ending differences only; any change to a keyword,
identifier, string or operator is a mismatch and the deployment is refused.

If Supabase ever changes this function, the deployment refuses with a clear
message. Re-verify the new definition before updating this file.

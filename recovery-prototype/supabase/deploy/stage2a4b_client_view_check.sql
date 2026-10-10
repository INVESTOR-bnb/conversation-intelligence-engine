-- ===================================================================
-- STAGE 2A-4b — READ-ONLY CLIENT VIEW CHECK (changes nothing)
-- Shows what ONE client account can read, by simulating that client's
-- signed-in session inside a transaction that is always rolled back.
--
-- 1. Replace REPLACE_WITH_CLIENT_USER_ID with the synthetic client's User ID
--    (shown on their "Account not yet authorised" screen before linking, or
--    Authentication → Users in Supabase).
-- 2. Run the whole file as one query in the SQL Editor.
--
-- Expected after stage2a4b_deploy.sql, for a client with at least one case:
--   direct_cases = 0, direct_outcomes = 0, direct_messages = 0,
--   direct_screenshots = 0, via_client_function >= 1, role_seen = CLIENT
-- ===================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'REPLACE_WITH_CLIENT_USER_ID', 'role', 'authenticated')::text, true);
select
  (select count(*) from public.cases)                   as direct_cases,
  (select count(*) from public.outcomes)                as direct_outcomes,
  (select count(*) from public.case_messages)           as direct_messages,
  (select count(*) from public.case_screenshots)        as direct_screenshots,
  (select count(*) from public.client_list_cases())     as via_client_function,
  (public.whoami() ->> 'role')                          as role_seen;
rollback;

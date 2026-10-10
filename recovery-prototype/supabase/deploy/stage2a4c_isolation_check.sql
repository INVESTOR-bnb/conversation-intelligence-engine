-- ===================================================================
-- STAGE 2A-4c — STAGING ISOLATION CHECK (always rolled back)
-- Simulates client B's signed-in session and ATTEMPTS to (1) upload a file
-- row into client A's case folder and (2) read stored files, then rolls
-- everything back. It does attempt a write (step 1) inside a transaction that
-- always ends with ROLLBACK; nothing is kept whatever the outcome.
--
-- Replace the three placeholders (synthetic accounts only):
--   REPLACE_CLIENT_B_USER_ID   user ID of a client linked to business B
--   REPLACE_BUSINESS_A_ID      business ID of client A
--   REPLACE_CASE_A_ID          a case ID of client A (any state)
-- Run the whole file as one query.
-- Expected: upload_attempt = REFUSED…, files_visible = 0,
--           status_of_case_a = REFUSED…, role_seen = CLIENT
-- ===================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'REPLACE_CLIENT_B_USER_ID', 'role', 'authenticated')::text, true);
do $check$
begin
  begin
    insert into storage.objects (bucket_id, name, owner_id, metadata)
    values ('case-screenshots', 'REPLACE_BUSINESS_A_ID/REPLACE_CASE_A_ID/9-' || repeat('0', 64) || '.png',
            'REPLACE_CLIENT_B_USER_ID', '{"size": 1, "mimetype": "image/png"}');
    perform set_config('rre.upload', 'ALLOWED — SECURITY PROBLEM', true);
  exception when others then
    perform set_config('rre.upload', 'REFUSED: ' || sqlerrm, true);
  end;
  begin
    perform public.client_screenshot_status('REPLACE_CASE_A_ID');
    perform set_config('rre.status', 'ALLOWED — SECURITY PROBLEM', true);
  exception when others then
    perform set_config('rre.status', 'REFUSED: ' || sqlerrm, true);
  end;
end
$check$;
select current_setting('rre.upload') as upload_attempt,
       (select count(*) from storage.objects where bucket_id = 'case-screenshots') as files_visible,
       current_setting('rre.status') as status_of_case_a,
       (public.whoami() ->> 'role') as role_seen;
rollback;

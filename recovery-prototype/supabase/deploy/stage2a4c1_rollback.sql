-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4c-1 ROLLBACK (single transaction)
-- Removes the screenshot upload guard (trigger rre_case_screenshots_guard and
-- private.screenshot_object_guard). Stage 2A-4c stays as it is.
-- Changes no data: every file, screenshot record and audit entry is kept.
-- WARNING: without the guard, signed upload URLs can again add or replace
-- files after a case is submitted (see the runbook).
-- Safe to re-run: if 2A-4c-1 is not applied it refuses and changes nothing.
-- Afterwards run stage2a4c_verify.sql.
-- ===================================================================

begin;

do $preflight$
begin
  if to_regprocedure('private.screenshot_object_guard()') is null
     or not exists (select 1 from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'rre_case_screenshots_guard') then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-4c-1 is not applied.';
  end if;
  perform set_config('rre.rows_before', (select count(*) from public.case_screenshots)::text, true);
  perform set_config('rre.audit_before', (select count(*) from public.audit_log)::text, true);
  perform set_config('rre.files_before', (select count(*) from storage.objects where bucket_id = 'case-screenshots')::text, true);
end
$preflight$;

drop trigger rre_case_screenshots_guard on storage.objects;
drop function private.screenshot_object_guard();

do $postcheck$
begin
  if to_regprocedure('private.screenshot_object_guard()') is not null
     or exists (select 1 from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'rre_case_screenshots_guard') then
    raise exception 'ROLLBACK ABORTED (rolled back): the guard remains';
  end if;
  if (select count(*) from public.case_screenshots)::text <> current_setting('rre.rows_before')
     or (select count(*) from public.audit_log)::text <> current_setting('rre.audit_before')
     or (select count(*) from storage.objects where bucket_id = 'case-screenshots')::text <> current_setting('rre.files_before') then
    raise exception 'ROLLBACK ABORTED (rolled back): records, files or audit history would change';
  end if;
  raise notice 'Rollback self-check passed: upload guard removed; records, files and audit history unchanged.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_ROLLED_BACK', jsonb_build_object('stage', '2A-4c-1', 'removed', 'screenshot upload guard'));

commit;
-- END OF ROLLBACK FILE — if this line is missing, the copy is incomplete: do not run.

-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-4c ROLLBACK (single transaction)
-- Removes screenshot intake: the two storage policies on storage.objects and
-- the functions client_finalize_screenshots, client_screenshot_status,
-- private.screenshot_upload_allowed and private.screenshot_objects.
--
-- PRESERVES (never deleted by this file):
--   * every case_screenshots row (screenshot evidence records);
--   * the audit log;
--   * the bucket case-screenshots and any stored files — with no policies left,
--     no API user can read, list, upload, replace or delete them (delete them
--     in the Supabase dashboard if wanted);
--   * case_screenshots.file_deleted_at IF any row has a retention timestamp.
--     It is dropped only when every value is empty, so no recorded
--     information is lost. If kept, the schema differs from 2A-4b by that one
--     nullable column (reported in the notice and the audit entry).
-- Safe to re-run: if 2A-4c is not applied it refuses and changes nothing.
-- Afterwards run stage2a4b_verify.sql and stage2a1_verify.sql.
-- ===================================================================

begin;

do $preflight$
begin
  if to_regprocedure('public.client_finalize_screenshots(uuid)') is null
     or (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'rre_case_screenshots_%') <> 2 then
    raise exception 'ROLLBACK REFUSED (nothing changed): Stage 2A-4c is not applied.';
  end if;
  perform set_config('rre.rows_before', (select count(*) from public.case_screenshots)::text, true);
  perform set_config('rre.audit_before', (select count(*) from public.audit_log)::text, true);
  raise notice 'Rollback preflight passed: removing Stage 2A-4c policies and functions; records are kept.';
end
$preflight$;

drop policy rre_case_screenshots_insert on storage.objects;
drop policy rre_case_screenshots_select on storage.objects;
drop function public.client_finalize_screenshots(uuid);
drop function public.client_screenshot_status(uuid);
drop function private.screenshot_upload_allowed(text);
drop function private.screenshot_objects(uuid, uuid);

do $column$
declare
  v_marked bigint := (select count(*) from public.case_screenshots where file_deleted_at is not null);
begin
  if v_marked = 0 then
    alter table public.case_screenshots drop column file_deleted_at;
    perform set_config('rre.column_kept', 'false', true);
    raise notice 'Column case_screenshots.file_deleted_at dropped (it held no values).';
  else
    perform set_config('rre.column_kept', 'true', true);
    raise notice 'Column case_screenshots.file_deleted_at KEPT: % row(s) carry a retention timestamp. Schema differs from 2A-4b by this nullable column.', v_marked;
  end if;
end
$column$;

do $postcheck$
begin
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'rre_case_screenshots_%')
     or to_regprocedure('public.client_finalize_screenshots(uuid)') is not null
     or to_regprocedure('private.screenshot_upload_allowed(text)') is not null then
    raise exception 'ROLLBACK ABORTED (rolled back): Stage 2A-4c objects remain';
  end if;
  if (select count(*) from public.case_screenshots)::text <> current_setting('rre.rows_before')
     or (select count(*) from public.audit_log)::text <> current_setting('rre.audit_before') then
    raise exception 'ROLLBACK ABORTED (rolled back): screenshot records or audit history would change';
  end if;
  raise notice 'Rollback self-check passed: Stage 2A-4c removed; records and audit history unchanged.';
end
$postcheck$;

insert into public.audit_log (actor, actor_role, action, details)
values (null, 'SYSTEM', 'SCHEMA_ROLLED_BACK', jsonb_build_object('stage', '2A-4c',
  'screenshot_records_kept', (select count(*) from public.case_screenshots),
  'file_deleted_at_column_kept', current_setting('rre.column_kept')::boolean,
  'bucket_kept', 'case-screenshots (no policies: inaccessible through the API)'));

commit;
-- END OF ROLLBACK FILE — if this line is missing, the copy is incomplete: do not run.

-- ===================================================================
-- LIVE-CHECK CLEANUP REPORT (administrator, SQL Editor) — READ-ONLY
-- Lists the synthetic cases created by supabase/scripts/storage-live-check.mjs
-- (reference LIVE-CHECK-…) and every stored file in their folders, so they can
-- be deleted in the Supabase dashboard. Also lists unrecorded files in any
-- other case (e.g. a file added through a signed upload URL before the
-- Stage 2A-4c-1 guard). Changes nothing. Contains no credentials.
--
-- Afterwards: delete the listed folders in Supabase → Storage → case-screenshots
-- (direct SQL deletes from storage.objects are blocked by Supabase), then run
-- admin/screenshot_mark_deleted.sql to mark the recorded rows. Case rows and
-- the audit log are kept as the record of the test.
-- ===================================================================
select 'LIVE-CHECK case' as kind,
       c.reference,
       c.workflow_state::text as state,
       c.business_id || '/' || c.id || '/' as folder_to_delete,
       (select count(*) from storage.objects o where o.bucket_id = 'case-screenshots' and o.name like c.business_id || '/' || c.id || '/%') as stored_files,
       (select count(*) from public.case_screenshots s where s.case_id = c.id) as recorded_rows,
       (select count(*) from public.case_screenshots s where s.case_id = c.id and s.file_deleted_at is null) as rows_not_yet_marked_deleted
from public.cases c
where c.reference like 'LIVE-CHECK-%'
union all
select 'unrecorded file (other case)',
       c.reference,
       c.workflow_state::text,
       o.name,
       1, 0, 0
from storage.objects o
left join public.cases c on o.name like c.business_id || '/' || c.id || '/%'
where o.bucket_id = 'case-screenshots'
  and (c.reference is null or c.reference not like 'LIVE-CHECK-%')
  and not exists (select 1 from public.case_screenshots s where s.storage_path = o.name)
order by 1, 2;

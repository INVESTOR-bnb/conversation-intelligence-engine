-- ===================================================================
-- SCREENSHOT RETENTION — MARK DELETED FILES (administrator, SQL Editor)
-- Run AFTER deleting files in the Supabase dashboard (Storage). Sets
-- case_screenshots.file_deleted_at only for rows whose stored file is
-- confirmed absent, and records one audit entry per case. Never deletes rows.
-- Safe to re-run (already marked rows are skipped).
-- ===================================================================
begin;
with marked as (
  update public.case_screenshots s set file_deleted_at = now()
  where s.file_deleted_at is null
    and not exists (select 1 from storage.objects o where o.bucket_id = 'case-screenshots' and o.name = s.storage_path)
  returning s.case_id, s.business_id, s.position)
insert into public.audit_log (actor, actor_role, action, case_id, business_id, details)
select null, 'SYSTEM', 'SCREENSHOT_FILES_DELETED', case_id, business_id,
       jsonb_build_object('positions', jsonb_agg(position order by position), 'method', 'admin/screenshot_mark_deleted.sql')
from marked group by case_id, business_id;
select count(*) as rows_marked_now from public.case_screenshots where file_deleted_at > now() - interval '1 minute';
commit;

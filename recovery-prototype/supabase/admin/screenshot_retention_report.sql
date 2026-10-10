-- ===================================================================
-- SCREENSHOT RETENTION REPORT (read-only, administrator, SQL Editor)
-- Synthetic staging only. Lists stored files that the manual retention rule
-- makes eligible for deletion. Delete them in Supabase → Storage →
-- case-screenshots (dashboard), then run admin/screenshot_mark_deleted.sql.
--   closed      : case closed (WON/LOST/PAUSED/DISQUALIFIED) >= 30 days ago
--   abandoned   : case still DRAFT, created >= 7 days ago
--   unrecorded  : file with no case_screenshots row, uploaded >= 7 days ago
-- ===================================================================
select o.name as storage_path,
       case when s.id is null then 'unrecorded'
            when c.workflow_state = 'DRAFT' then 'abandoned draft'
            else 'closed case' end as reason,
       c.workflow_state, c.closed_at, o.created_at as uploaded_at,
       (o.metadata ->> 'size')::bigint as size_bytes
from storage.objects o
left join public.case_screenshots s on s.storage_path = o.name
left join public.cases c on c.id = coalesce(s.case_id,
  case when o.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/' then split_part(o.name, '/', 2)::uuid end)
where o.bucket_id = 'case-screenshots'
  and ((s.id is null and o.created_at <= now() - interval '7 days')
    or (c.workflow_state = 'DRAFT' and c.created_at <= now() - interval '7 days')
    or (c.workflow_state in ('WON', 'LOST', 'PAUSED', 'DISQUALIFIED') and c.closed_at <= now() - interval '30 days'))
order by reason, o.name;

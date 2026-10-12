-- ===================================================================
-- REVENUE RECOVERY ENGINE — STAGE 2A-5b VERIFICATION (read-only)
-- One SELECT statement: changes nothing, safe to run any number of times.
-- Run after stage2a5b_deploy.sql; then re-run stage2a5a_verify.sql and the
-- earlier verification files.
-- ===================================================================
with
fns(sig) as (values ('private.evidence_manifest(uuid, integer)'), ('private.tg_evidence_changed()'), ('private.preserve_detected_restrictions(uuid, jsonb, integer)')),
fsa as (select prosrc from pg_proc where oid = to_regprocedure('public.founder_start_analysis(uuid)')),
ica as (select prosrc from pg_proc where oid = to_regprocedure('public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)')),
trg as (select t.tgname, t.tgtype, t.tgenabled, pg_get_triggerdef(t.oid) as def from pg_trigger t
        where not t.tgisinternal and t.tgfoid = to_regprocedure('private.tg_evidence_changed()')),
checks(ord, check_name, status, detail) as (
  select 1, 'The 3 evidence-integrity functions exist',
    case when (select count(*) from fns where to_regprocedure(sig) is not null) = 3 then 'PASS' else 'FAIL' end,
    coalesce((select 'missing: ' || string_agg(sig, ', ') from fns where to_regprocedure(sig) is null), 'all present')
  union all
  select 2, 'They are SECURITY DEFINER with an empty search_path',
    case when (select count(*) from fns f join pg_proc p on p.oid = to_regprocedure(f.sig) where p.prosecdef and p.proconfig @> array['search_path=""']) = 3
         then 'PASS' else 'FAIL' end, 'private schema'
  union all
  select 3, 'No API role can call them directly',
    case when (select count(*) from fns where to_regprocedure(sig) is not null) = 3
          and not exists (select 1 from fns f where has_function_privilege('anon', to_regprocedure(f.sig), 'EXECUTE')
                          or has_function_privilege('authenticated', to_regprocedure(f.sig), 'EXECUTE') or has_function_privilege('service_role', to_regprocedure(f.sig), 'EXECUTE'))
         then 'PASS' else 'FAIL' end, 'anon, authenticated, service_role'
  union all
  select 4, 'Analyses start only from usable evidence (manifest v2; refused when none remains)',
    case when (select prosrc from fsa) like '%private.evidence_manifest(%' and (select prosrc from fsa) like '%INSUFFICIENT_EVIDENCE%'
          and has_function_privilege('authenticated', 'public.founder_start_analysis(uuid)', 'EXECUTE') then 'PASS' else 'FAIL' end,
    'founder_start_analysis'
  union all
  select 5, 'Completion enforces the 2A-5a contract and preserves detected restrictions',
    case when (select prosrc from ica) like '%private.analysis_output_problems(%' and (select prosrc from ica) like '%private.preserve_detected_restrictions(%'
         then 'PASS' else 'FAIL' end, 'internal_complete_analysis'
  union all
  select 6, 'Four evidence triggers enabled (messages and screenshots, update and delete)',
    case when (select count(*) from trg where tgenabled = 'O' and (
                 (tgname = 'rre_case_screenshots_evidence_update' and tgtype = 17 and def like '%ON public.case_screenshots%' and def like '%file_deleted_at%')
              or (tgname = 'rre_case_screenshots_evidence_delete' and tgtype = 9 and def like '%ON public.case_screenshots%')
              or (tgname = 'rre_case_messages_evidence_update' and tgtype = 17 and def like '%ON public.case_messages%' and def like '%body%')
              or (tgname = 'rre_case_messages_evidence_delete' and tgtype = 9 and def like '%ON public.case_messages%'))) = 4
         then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(tgname::text || '=' || tgenabled::text, ', ' order by tgname) from trg), 'none')
  union all
  select 7, 'Analyses and contact restrictions remain founder-only',
    case when (select count(*) from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')) = 2
          and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')
                          and (cmd <> 'SELECT' or qual not like '%is_founder%' or qual like '%is_member%')) then 'PASS' else 'FAIL' end,
    coalesce((select string_agg(tablename || ': ' || qual, ' | ') from pg_policies where schemaname = 'public' and tablename in ('analyses', 'contact_restrictions')), 'none')
  union all
  select 8, 'Stage 2A-5b deployment recorded in the audit log',
    case when (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.audit_log where action = 'SCHEMA_DEPLOYED' and details->>'stage' = '2A-5b'$q$, false, true, '')))[1]::text::int >= 1
         then 'PASS' else 'FAIL' end, 'action SCHEMA_DEPLOYED, stage 2A-5b'
  union all
  select 9, 'Analyses in progress that started before 2A-5b (manifest v1)', 'INFO',
    (select count(*) from public.analyses where status = 'PENDING' and evidence_manifest ->> 'manifest_version' is null)::text
    || ' — finish or abandon them; they are still judged by the contract'
  union all
  select 10, 'Cases waiting for analysis with no usable evidence (cannot be analysed)', 'INFO',
    (select count(*) from public.cases c
     where c.workflow_state in ('SUBMITTED', 'PROSPECT_REPLIED', 'REANALYZING')
       and not exists (select 1 from public.case_messages m where m.case_id = c.id)
       and not exists (select 1 from public.case_screenshots s where s.case_id = c.id and s.file_deleted_at is null))::text
)
select 0 as ord, 'OVERALL' as check_name,
  case when exists (select 1 from checks where status = 'FAIL') then 'FAIL' else 'PASS' end as status,
  (select count(*) filter (where status = 'PASS') || ' pass, ' || count(*) filter (where status = 'FAIL') || ' fail, '
          || count(*) filter (where status = 'INFO') || ' info' from checks) as detail
union all
select * from checks
order by ord;

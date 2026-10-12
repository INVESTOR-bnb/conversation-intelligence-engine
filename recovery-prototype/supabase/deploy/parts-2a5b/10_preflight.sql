-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-5a is applied
-- and 2A-5b is not yet applied.
-- ===================================================================
do $preflight$
begin
  if to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5a (analysis contract) is not applied.';
  end if;
  if to_regprocedure('private.evidence_manifest(uuid, integer)') is not null
     or exists (select 1 from pg_trigger where tgname in ('rre_case_screenshots_evidence_update', 'rre_case_messages_evidence_update')) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5b is already applied.';
  end if;
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): role % cannot bypass RLS, so the functions could not read the evidence', current_user;
  end if;
  raise notice 'Preflight passed: installing Stage 2A-5b evidence integrity.';
end
$preflight$;

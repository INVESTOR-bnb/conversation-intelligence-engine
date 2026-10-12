-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-4c is applied
-- and 2A-5a is not yet applied.
-- ===================================================================
do $preflight$
declare
  v_problems text[] := '{}';
begin
  if to_regprocedure('public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)') is null
     or to_regprocedure('public.founder_start_analysis(uuid)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-1 analysis functions are not installed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'case_screenshots' and column_name = 'file_deleted_at')
     or to_regprocedure('public.client_finalize_screenshots(uuid)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-4c is not applied (the contract needs case_screenshots.file_deleted_at).';
  end if;
  if to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)') is not null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5a is already applied.';
  end if;
  -- The contract functions run as their owner (this role) and must see every case and message.
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    v_problems := array_append(v_problems, format('role %s cannot bypass RLS, so the contract could not read the evidence', current_user));
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Preflight passed: installing the Stage 2A-5a analysis output contract (rre-analysis/1).';
end
$preflight$;

-- ===================================================================
-- PREFLIGHT — refuses (and changes nothing) unless Stage 2A-5d-1 is applied
-- and the analysis contract is exactly the reviewed Stage 2A-5d-1 version,
-- and 2A-5d-2 is not yet applied.
-- ===================================================================
do $preflight$
declare
  v_body text := (select prosrc from pg_proc
                  where oid = to_regprocedure('private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'));
begin
  if v_body is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5a (analysis contract) is not applied.';
  end if;
  if to_regprocedure('private.evidence_manifest(uuid, integer)') is null then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5b (evidence integrity) is not applied.';
  end if;
  if v_body like '%Stage 2A-5d-2%' then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5d-2 is already applied.';
  end if;
  if v_body not like '%Stage 2A-5d-1%' then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): Stage 2A-5d-1 (restriction contract) is not applied.';
  end if;
  if md5(v_body) <> 'bf447c01cdd3897008436b017d91906b' then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): private.analysis_output_problems is not the reviewed Stage 2A-5d-1 version (md5 %); it was changed outside the deployment files', md5(v_body);
  end if;
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    raise exception 'DEPLOYMENT REFUSED (nothing changed): role % cannot bypass RLS, so the contract could not read the evidence', current_user;
  end if;
  raise notice 'Preflight passed: installing Stage 2A-5d-2 (contract rre-analysis/2 with an independent adversarial review).';
end
$preflight$;

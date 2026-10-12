-- ===================================================================
-- POST-INSTALL SELF-CHECK — still inside the transaction. Any problem
-- rolls everything back.
-- ===================================================================
do $postcheck$
declare
  v_problems text[] := '{}';
  v_fns text[] := array['private.ac_text(jsonb, integer)', 'private.ac_extra_keys(jsonb, text[])', 'private.ac_norm(text)', 'private.ac_arr(jsonb)',
    'private.ac_ref_problems(public.analyses, jsonb, text)', 'private.ac_refs_problems(public.analyses, jsonb, text, integer)',
    'private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)'];
  v_ica regprocedure := 'public.internal_complete_analysis(uuid, public.analysis_status, text, text, jsonb, public.classification, text, jsonb, integer, integer, numeric, text)'::regprocedure;
  v_f text;
begin
  foreach v_f in array v_fns loop
    if to_regprocedure(v_f) is null then
      v_problems := array_append(v_problems, v_f || ' is missing');
    elsif not (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = to_regprocedure(v_f))
       or has_function_privilege('anon', to_regprocedure(v_f), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE')
       or has_function_privilege('service_role', to_regprocedure(v_f), 'EXECUTE') then
      v_problems := array_append(v_problems, v_f || ' is callable by an API role or does not pin search_path');
    end if;
  end loop;
  if (select prosrc from pg_proc where oid = v_ica) not like '%private.analysis_output_problems(%'
     or not has_function_privilege('service_role', v_ica, 'EXECUTE') or has_function_privilege('authenticated', v_ica, 'EXECUTE')
     or has_function_privilege('anon', v_ica, 'EXECUTE') then
    v_problems := array_append(v_problems, 'internal_complete_analysis does not enforce the contract, or is not server-side only');
  end if;
  -- Behaviour: an empty object is rejected; a non-final status is not judged.
  if cardinality(private.analysis_output_problems(null::public.analyses, 'COMPLETE', '{}'::jsonb, null, null, '[]'::jsonb)) = 0
     or cardinality(private.analysis_output_problems(null::public.analyses, 'ERROR', '{}'::jsonb, null, null, '[]'::jsonb)) <> 0 then
    v_problems := array_append(v_problems, 'the contract does not behave as reviewed');
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'analyses') <> 1
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'analyses' and cmd = 'SELECT'
                    and qual like '%is_founder%' and qual not like '%is_member%') then
    v_problems := array_append(v_problems, 'public.analyses is no longer founder-only'::text);
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'DEPLOYMENT ABORTED (rolled back): %', array_to_string(v_problems, '; ');
  end if;
  raise notice 'Post-install self-check passed: analysis contract rre-analysis/1 enforced; analyses remain founder-only.';
end
$postcheck$;

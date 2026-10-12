-- Stage 2A-5a — analysis output contract v1 ("rre-analysis/1"), enforced in the database.
--
-- No AI is connected by this stage. It defines what an analysis must look like
-- before internal_complete_analysis will store it, so that no analysis (from
-- any producer) can reach the founder with invented evidence, unlabelled
-- psychological claims, or findings on insufficient or deleted evidence.
-- Analyses stay founder-only (unchanged RLS on public.analyses); nothing here
-- is visible to business users.
--
-- Shape (every key required; arrays may be empty unless stated; no other keys):
-- {
--   "contract_version": "rre-analysis/1",
--   "evidence_assessment": { "sufficiency": SUFFICIENT|PARTIAL|INSUFFICIENT,
--                            "summary": text, "missing_evidence": [text] },
--   "observations": [ { "id": "O1", "actor": PROSPECT|SELLER|UNCLEAR,
--                       "behavior": text, "evidence": [ref, ...1+] } ],
--   "hypotheses": [ { "id": "H1",
--       "category": EMOTIONAL_BARRIER|TRUST_AND_RISK|BUYING_MOTIVATION|DECISION_FRICTION|SELLER_CREATED_RESISTANCE,
--       "statement": text, "basis": STATED_BY_PROSPECT|HYPOTHESIS,
--       "supporting_observations": ["O1", ...1+], "contradicting_observations": ["O2"],
--       "competing_hypotheses": ["H2"], "confidence": HIGH|MEDIUM|LOW|UNKNOWN,
--       "uncertainty": text } ],
--   "unknowns": [ { "question": text, "why_it_matters": text } ],
--   "recommendation": { "pursue": PURSUE|DO_NOT_PURSUE|UNKNOWN,
--       "strategy": text|"UNKNOWN", "psychological_rationale": text|"UNKNOWN",
--       "based_on_hypotheses": ["H1"],
--       "next_action": { "type": SEND_MESSAGE|ASK_DIAGNOSTIC_QUESTION|WAIT|STOP_CONTACT, "text": text } },
--   "contact_restrictions": [ { "kind": EXPLICIT_OPT_OUT|PROHIBITED_CONTACT|OTHER, "reason": text, "evidence": [ref, ...1+] } ],
--   "reasons_not_to_pursue": [ { "reason": text, "evidence": [ref] } ]
-- }
-- ref: { "type": "MESSAGE", "message_id": uuid, "quote": text }  quote must appear in that message
--      { "type": "SCREENSHOT", "position": 1-10, "quote"?: text } quote is model-reported (no OCR)
--
-- Rules (each enforced below; a violation records the analysis as ERROR):
--  * evidence: every reference is in THIS analysis's evidence manifest; message
--    quotes appear verbatim (whitespace-normalised) in the message; a screenshot
--    is citable only if its file is still stored (not deleted under retention)
--    and unchanged since the manifest; PROSPECT/SELLER observations cannot cite
--    the other side's messages (recovery messages are the seller's, prospect
--    responses the prospect's).
--  * psychology: every hypothesis rests on at least one observation. It may be
--    STATED_BY_PROSPECT only if a supporting PROSPECT observation quotes the
--    evidence; otherwise it is a HYPOTHESIS, which needs a competing hypothesis
--    and can never be HIGH confidence. HIGH is also impossible when anything
--    contradicts it. Confidence may be UNKNOWN.
--  * insufficiency: INSUFFICIENT_EVIDENCE ⇔ sufficiency INSUFFICIENT; it carries
--    no hypotheses, classification or proposed message, a strategy of UNKNOWN,
--    and states what is missing. A case without usable evidence can only be
--    INSUFFICIENT_EVIDENCE. COMPLETE needs at least one observation; PARTIAL
--    needs at least one unknown.
--  * recommendation: PURSUE needs a strategy, a rationale and the hypotheses it
--    rests on; any contact restriction forces DO_NOT_PURSUE and STOP_CONTACT;
--    classification RED ⇔ DO_NOT_PURSUE, GREEN/YELLOW ⇔ PURSUE, none ⇔ UNKNOWN;
--    a proposed message exists only for SEND_MESSAGE and equals its text; the
--    restrictions in the output are exactly the ones recorded.
--
-- Rollback: supabase/deploy/stage2a5a_rollback.sql.

-- ---------------------------------------------------------------- small helpers
create function private.ac_text(p_v jsonb, p_max integer) returns boolean
language sql immutable security definer set search_path = '' as $$
  select coalesce(jsonb_typeof(p_v) = 'string' and char_length(btrim(p_v #>> '{}')) between 1 and p_max, false)
$$;

create function private.ac_extra_keys(p_obj jsonb, p_allowed text[]) returns text
language sql immutable security definer set search_path = '' as $$
  select string_agg(k, ', ' order by k)
  from jsonb_object_keys(case when jsonb_typeof(p_obj) = 'object' then p_obj else '{}'::jsonb end) k
  where k <> all (p_allowed)
$$;

create function private.ac_norm(p_text text) returns text
language sql immutable security definer set search_path = '' as $$
  select btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'))
$$;

-- The array, or an empty array if the value is not an array (the caller reports that).
create function private.ac_arr(p_v jsonb) returns jsonb
language sql immutable security definer set search_path = '' as $$
  select case when jsonb_typeof(p_v) = 'array' then p_v else '[]'::jsonb end
$$;

-- ---------------------------------------------------------------- one evidence reference
create function private.ac_ref_problems(p_analysis public.analyses, p_ref jsonb, p_where text) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p text[] := '{}';
  v_extra text;
  v_id text;
  v_body text;
  v_pos integer;
  v_sha text;
begin
  if jsonb_typeof(p_ref) is distinct from 'object' then
    return array[p_where || ': evidence reference must be an object'];
  end if;
  if p_ref ->> 'type' = 'MESSAGE' then
    v_extra := private.ac_extra_keys(p_ref, array['type', 'message_id', 'quote']);
    v_id := p_ref ->> 'message_id';
    if v_id is null or v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from jsonb_array_elements(private.ac_arr(p_analysis.evidence_manifest -> 'messages')) m where m ->> 'id' = v_id) then
      v_p := array_append(v_p, p_where || ': message is not part of this analysis''s evidence');
    elsif not private.ac_text(p_ref -> 'quote', 500) then
      v_p := array_append(v_p, p_where || ': a message reference needs a quote (1-500 characters)');
    else
      select m.body into v_body from public.case_messages m where m.id = v_id::uuid and m.case_id = p_analysis.case_id;
      if v_body is null or strpos(private.ac_norm(v_body), private.ac_norm(p_ref ->> 'quote')) = 0 then
        v_p := array_append(v_p, p_where || ': quote does not appear in the cited message');
      end if;
    end if;
  elsif p_ref ->> 'type' = 'SCREENSHOT' then
    v_extra := private.ac_extra_keys(p_ref, array['type', 'position', 'quote']);
    if jsonb_typeof(p_ref -> 'position') is distinct from 'number' or (p_ref ->> 'position') !~ '^([1-9]|10)$' then
      v_p := array_append(v_p, p_where || ': screenshot position must be 1-10');
    else
      v_pos := (p_ref ->> 'position')::integer;
      select m ->> 'sha256' into v_sha
      from jsonb_array_elements(private.ac_arr(p_analysis.evidence_manifest -> 'screenshots')) m
      where (m ->> 'position')::integer = v_pos;
      if v_sha is null then
        v_p := array_append(v_p, p_where || ': screenshot is not part of this analysis''s evidence');
      elsif not exists (select 1 from public.case_screenshots s
                        where s.case_id = p_analysis.case_id and s.position = v_pos and s.sha256 = v_sha and s.file_deleted_at is null) then
        v_p := array_append(v_p, p_where || ': screenshot was deleted or changed and cannot be cited');
      end if;
    end if;
    if p_ref ? 'quote' and not private.ac_text(p_ref -> 'quote', 500) then
      v_p := array_append(v_p, p_where || ': screenshot quote must be 1-500 characters');
    end if;
  else
    return array[p_where || ': evidence type must be MESSAGE or SCREENSHOT'];
  end if;
  if v_extra is not null then
    v_p := array_append(v_p, p_where || ': unexpected keys ' || v_extra);
  end if;
  return v_p;
end $$;

-- Validates a list of references; p_min is the minimum number required.
create function private.ac_refs_problems(p_analysis public.analyses, p_refs jsonb, p_where text, p_min integer) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p text[] := '{}';
  v_r record;
begin
  if jsonb_typeof(p_refs) is distinct from 'array' or jsonb_array_length(p_refs) < p_min or jsonb_array_length(p_refs) > 10 then
    return array[format('%s: must be a list of %s-10 evidence references', p_where, p_min)];
  end if;
  for v_r in select e, i from jsonb_array_elements(p_refs) with ordinality as t(e, i) loop
    v_p := v_p || private.ac_ref_problems(p_analysis, v_r.e, format('%s[%s]', p_where, v_r.i - 1));
  end loop;
  return v_p;
end $$;

-- ---------------------------------------------------------------- the contract
create function private.analysis_output_problems(
  p_analysis public.analyses,
  p_status public.analysis_status,
  p_output jsonb,
  p_ai_classification public.classification,
  p_ai_proposed_message text,
  p_detected_restrictions jsonb
) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p text[] := '{}';
  v_x text;
  v_ea jsonb;
  v_obs jsonb;
  v_hyp jsonb;
  v_unk jsonb;
  v_rec jsonb;
  v_na jsonb;
  v_res jsonb;
  v_rnp jsonb;
  v_r record;
  v_s record;
  v_w text;
  v_obs_ids text[];
  v_hyp_ids text[];
  v_suff text;
  v_pursue text;
  v_na_type text;
  v_usable integer;
begin
  if p_status not in ('COMPLETE', 'INSUFFICIENT_EVIDENCE') then
    return v_p;
  end if;
  if jsonb_typeof(p_output) is distinct from 'object' then
    return array['output must be a JSON object'];
  end if;
  if octet_length(p_output::text) > 200000 then
    return array['output is larger than 200 kB'];
  end if;
  if p_output ->> 'contract_version' is distinct from 'rre-analysis/1' then
    v_p := array_append(v_p, 'contract_version must be rre-analysis/1');
  end if;
  v_x := private.ac_extra_keys(p_output, array['contract_version', 'evidence_assessment', 'observations', 'hypotheses',
                                              'unknowns', 'recommendation', 'contact_restrictions', 'reasons_not_to_pursue']);
  if v_x is not null then v_p := array_append(v_p, 'unexpected keys ' || v_x); end if;
  foreach v_x in array array['evidence_assessment', 'observations', 'hypotheses', 'unknowns', 'recommendation',
                             'contact_restrictions', 'reasons_not_to_pursue'] loop
    if not p_output ? v_x then v_p := array_append(v_p, 'missing ' || v_x); end if;
  end loop;
  if cardinality(v_p) > 0 then
    return v_p;
  end if;

  v_ea := p_output -> 'evidence_assessment';
  v_obs := p_output -> 'observations';
  v_hyp := p_output -> 'hypotheses';
  v_unk := p_output -> 'unknowns';
  v_rec := p_output -> 'recommendation';
  v_res := p_output -> 'contact_restrictions';
  v_rnp := p_output -> 'reasons_not_to_pursue';
  foreach v_x in array array['observations', 'hypotheses', 'unknowns', 'contact_restrictions', 'reasons_not_to_pursue'] loop
    if jsonb_typeof(p_output -> v_x) is distinct from 'array' or jsonb_array_length(p_output -> v_x) > 60 then
      v_p := array_append(v_p, v_x || ' must be a list (at most 60)');
    end if;
  end loop;
  if jsonb_typeof(v_ea) is distinct from 'object' or jsonb_typeof(v_rec) is distinct from 'object' then
    v_p := array_append(v_p, 'evidence_assessment and recommendation must be objects');
  end if;
  if cardinality(v_p) > 0 then
    return v_p;
  end if;

  -- evidence assessment
  v_suff := v_ea ->> 'sufficiency';
  if v_suff is null or v_suff not in ('SUFFICIENT', 'PARTIAL', 'INSUFFICIENT') then
    v_p := array_append(v_p, 'evidence_assessment.sufficiency must be SUFFICIENT, PARTIAL or INSUFFICIENT');
  end if;
  if not private.ac_text(v_ea -> 'summary', 1000) then
    v_p := array_append(v_p, 'evidence_assessment.summary is required (1-1000 characters)');
  end if;
  if jsonb_typeof(v_ea -> 'missing_evidence') is distinct from 'array' or jsonb_array_length(v_ea -> 'missing_evidence') > 20
     or exists (select 1 from jsonb_array_elements(private.ac_arr(v_ea -> 'missing_evidence')) e where not private.ac_text(e, 500)) then
    v_p := array_append(v_p, 'evidence_assessment.missing_evidence must be a list of texts (1-500 characters)');
  end if;
  v_x := private.ac_extra_keys(v_ea, array['sufficiency', 'summary', 'missing_evidence']);
  if v_x is not null then v_p := array_append(v_p, 'evidence_assessment: unexpected keys ' || v_x); end if;

  -- observations
  select array_agg(o ->> 'id') into v_obs_ids from jsonb_array_elements(v_obs) o;
  v_obs_ids := coalesce(v_obs_ids, '{}');
  if exists (select 1 from unnest(v_obs_ids) i where i is null or i !~ '^O[0-9]{1,3}$')
     or cardinality(v_obs_ids) <> (select count(distinct i) from unnest(v_obs_ids) i) then
    v_p := array_append(v_p, 'observation ids must be unique and look like O1, O2, ...');
  end if;
  for v_r in select o, i from jsonb_array_elements(v_obs) with ordinality as t(o, i) loop
    v_w := format('observations[%s]', v_r.i - 1);
    if jsonb_typeof(v_r.o) is distinct from 'object' then
      v_p := array_append(v_p, v_w || ' must be an object');
      continue;
    end if;
    if v_r.o ->> 'actor' is null or v_r.o ->> 'actor' not in ('PROSPECT', 'SELLER', 'UNCLEAR') then
      v_p := array_append(v_p, v_w || '.actor must be PROSPECT, SELLER or UNCLEAR');
    end if;
    if not private.ac_text(v_r.o -> 'behavior', 1000) then
      v_p := array_append(v_p, v_w || '.behavior is required (1-1000 characters)');
    end if;
    v_p := v_p || private.ac_refs_problems(p_analysis, v_r.o -> 'evidence', v_w || '.evidence', 1);
    -- An actor cannot be evidenced only by the other side's own messages.
    if exists (select 1 from jsonb_array_elements(private.ac_arr(v_r.o -> 'evidence')) e
               join public.case_messages m on m.id::text = e ->> 'message_id' and m.case_id = p_analysis.case_id
               where e ->> 'type' = 'MESSAGE'
                 and ((v_r.o ->> 'actor' = 'PROSPECT' and m.kind = 'RECOVERY_SENT')
                   or (v_r.o ->> 'actor' = 'SELLER' and m.kind = 'PROSPECT_RESPONSE'))) then
      v_p := array_append(v_p, v_w || ': cites a message written by the other party');
    end if;
    v_x := private.ac_extra_keys(v_r.o, array['id', 'actor', 'behavior', 'evidence']);
    if v_x is not null then v_p := array_append(v_p, v_w || ': unexpected keys ' || v_x); end if;
  end loop;

  -- hypotheses
  select array_agg(h ->> 'id') into v_hyp_ids from jsonb_array_elements(v_hyp) h;
  v_hyp_ids := coalesce(v_hyp_ids, '{}');
  if exists (select 1 from unnest(v_hyp_ids) i where i is null or i !~ '^H[0-9]{1,3}$')
     or cardinality(v_hyp_ids) <> (select count(distinct i) from unnest(v_hyp_ids) i) then
    v_p := array_append(v_p, 'hypothesis ids must be unique and look like H1, H2, ...');
  end if;
  for v_r in select h, i from jsonb_array_elements(v_hyp) with ordinality as t(h, i) loop
    v_w := format('hypotheses[%s]', v_r.i - 1);
    if jsonb_typeof(v_r.h) is distinct from 'object' then
      v_p := array_append(v_p, v_w || ' must be an object');
      continue;
    end if;
    if v_r.h ->> 'category' is null or v_r.h ->> 'category' not in
       ('EMOTIONAL_BARRIER', 'TRUST_AND_RISK', 'BUYING_MOTIVATION', 'DECISION_FRICTION', 'SELLER_CREATED_RESISTANCE') then
      v_p := array_append(v_p, v_w || '.category is not a known category');
    end if;
    if not private.ac_text(v_r.h -> 'statement', 1000) then
      v_p := array_append(v_p, v_w || '.statement is required (1-1000 characters)');
    end if;
    if not private.ac_text(v_r.h -> 'uncertainty', 1000) then
      v_p := array_append(v_p, v_w || '.uncertainty is required: say what would change this view');
    end if;
    if v_r.h ->> 'confidence' is null or v_r.h ->> 'confidence' not in ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN') then
      v_p := array_append(v_p, v_w || '.confidence must be HIGH, MEDIUM, LOW or UNKNOWN');
    end if;
    foreach v_x in array array['supporting_observations', 'contradicting_observations', 'competing_hypotheses'] loop
      if jsonb_typeof(v_r.h -> v_x) is distinct from 'array' or exists (select 1 from jsonb_array_elements(private.ac_arr(v_r.h -> v_x)) e where jsonb_typeof(e) is distinct from 'string') then
        v_p := array_append(v_p, format('%s.%s must be a list of ids', v_w, v_x));
      end if;
    end loop;
    if jsonb_array_length(private.ac_arr(v_r.h -> 'supporting_observations')) = 0 then
      v_p := array_append(v_p, v_w || ' rests on no observation; record it as an unknown instead');
    end if;
    if exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'supporting_observations')) e where e <> all (v_obs_ids))
       or exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'contradicting_observations')) e where e <> all (v_obs_ids)) then
      v_p := array_append(v_p, v_w || ' refers to an observation that does not exist');
    end if;
    if exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'supporting_observations')) e
               where e in (select jsonb_array_elements_text(private.ac_arr(v_r.h -> 'contradicting_observations')))) then
      v_p := array_append(v_p, v_w || ': an observation cannot both support and contradict it');
    end if;
    if exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'competing_hypotheses')) e
               where e <> all (v_hyp_ids) or e = v_r.h ->> 'id') then
      v_p := array_append(v_p, v_w || '.competing_hypotheses must name other hypotheses');
    end if;
    if v_r.h ->> 'basis' = 'STATED_BY_PROSPECT' then
      -- Only what the prospect actually said, quoted, may be presented as stated.
      if not exists (select 1 from jsonb_array_elements_text(private.ac_arr(v_r.h -> 'supporting_observations')) s
                     join jsonb_array_elements(v_obs) o on o ->> 'id' = s
                     where o ->> 'actor' = 'PROSPECT'
                       and exists (select 1 from jsonb_array_elements(private.ac_arr(o -> 'evidence')) e where private.ac_text(e -> 'quote', 500))) then
        v_p := array_append(v_p, v_w || ' is not directly supported by a quoted prospect statement; label it HYPOTHESIS');
      end if;
    elsif v_r.h ->> 'basis' = 'HYPOTHESIS' then
      if jsonb_array_length(private.ac_arr(v_r.h -> 'competing_hypotheses')) = 0 then
        v_p := array_append(v_p, v_w || ' is a hypothesis and must name at least one competing hypothesis');
      end if;
      if v_r.h ->> 'confidence' = 'HIGH' then
        v_p := array_append(v_p, v_w || ': an unstated psychological hypothesis cannot be HIGH confidence');
      end if;
    else
      v_p := array_append(v_p, v_w || '.basis must be STATED_BY_PROSPECT or HYPOTHESIS');
    end if;
    if v_r.h ->> 'confidence' = 'HIGH' and jsonb_array_length(private.ac_arr(v_r.h -> 'contradicting_observations')) > 0 then
      v_p := array_append(v_p, v_w || ': HIGH confidence is impossible while observations contradict it');
    end if;
    v_x := private.ac_extra_keys(v_r.h, array['id', 'category', 'statement', 'basis', 'supporting_observations',
                                             'contradicting_observations', 'competing_hypotheses', 'confidence', 'uncertainty']);
    if v_x is not null then v_p := array_append(v_p, v_w || ': unexpected keys ' || v_x); end if;
  end loop;

  -- unknowns
  for v_r in select u, i from jsonb_array_elements(v_unk) with ordinality as t(u, i) loop
    if not (private.ac_text(v_r.u -> 'question', 500) and private.ac_text(v_r.u -> 'why_it_matters', 500))
       or private.ac_extra_keys(v_r.u, array['question', 'why_it_matters']) is not null then
      v_p := array_append(v_p, format('unknowns[%s] needs exactly question and why_it_matters (1-500 characters)', v_r.i - 1));
    end if;
  end loop;

  -- contact restrictions and reasons not to pursue
  for v_r in select c, i from jsonb_array_elements(v_res) with ordinality as t(c, i) loop
    v_w := format('contact_restrictions[%s]', v_r.i - 1);
    if v_r.c ->> 'kind' is null or v_r.c ->> 'kind' not in ('EXPLICIT_OPT_OUT', 'PROHIBITED_CONTACT', 'OTHER') then
      v_p := array_append(v_p, v_w || '.kind must be EXPLICIT_OPT_OUT, PROHIBITED_CONTACT or OTHER');
    end if;
    if not private.ac_text(v_r.c -> 'reason', 1000) then
      v_p := array_append(v_p, v_w || '.reason is required');
    end if;
    v_p := v_p || private.ac_refs_problems(p_analysis, v_r.c -> 'evidence', v_w || '.evidence', 1);
    v_x := private.ac_extra_keys(v_r.c, array['kind', 'reason', 'evidence']);
    if v_x is not null then v_p := array_append(v_p, v_w || ': unexpected keys ' || v_x); end if;
  end loop;
  for v_r in select c, i from jsonb_array_elements(v_rnp) with ordinality as t(c, i) loop
    v_w := format('reasons_not_to_pursue[%s]', v_r.i - 1);
    if not private.ac_text(v_r.c -> 'reason', 1000) then
      v_p := array_append(v_p, v_w || '.reason is required');
    end if;
    v_p := v_p || private.ac_refs_problems(p_analysis, coalesce(v_r.c -> 'evidence', '[]'::jsonb), v_w || '.evidence', 0);
    v_x := private.ac_extra_keys(v_r.c, array['reason', 'evidence']);
    if v_x is not null then v_p := array_append(v_p, v_w || ': unexpected keys ' || v_x); end if;
  end loop;
  -- The restrictions in the output must be exactly the ones being recorded.
  if jsonb_typeof(coalesce(p_detected_restrictions, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(v_res) <> jsonb_array_length(coalesce(p_detected_restrictions, '[]'::jsonb))
     or exists (select 1 from jsonb_array_elements(v_res) with ordinality a(c, i)
                join jsonb_array_elements(coalesce(p_detected_restrictions, '[]'::jsonb)) with ordinality b(d, j) on a.i = b.j
                where a.c ->> 'kind' is distinct from b.d ->> 'kind') then
    v_p := array_append(v_p, 'contact_restrictions do not match the restrictions being recorded');
  end if;

  -- recommendation
  v_pursue := v_rec ->> 'pursue';
  v_na := v_rec -> 'next_action';
  v_na_type := v_na ->> 'type';
  if v_pursue is null or v_pursue not in ('PURSUE', 'DO_NOT_PURSUE', 'UNKNOWN') then
    v_p := array_append(v_p, 'recommendation.pursue must be PURSUE, DO_NOT_PURSUE or UNKNOWN');
  end if;
  if not private.ac_text(v_rec -> 'strategy', 1500) then
    v_p := array_append(v_p, 'recommendation.strategy is required (text or UNKNOWN)');
  end if;
  if not private.ac_text(v_rec -> 'psychological_rationale', 1500) then
    v_p := array_append(v_p, 'recommendation.psychological_rationale is required (text or UNKNOWN)');
  end if;
  if jsonb_typeof(v_rec -> 'based_on_hypotheses') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(private.ac_arr(v_rec -> 'based_on_hypotheses')) e
                where jsonb_typeof(e) is distinct from 'string' or (e #>> '{}') <> all (v_hyp_ids)) then
    v_p := array_append(v_p, 'recommendation.based_on_hypotheses must list existing hypotheses');
  end if;
  if jsonb_typeof(v_na) is distinct from 'object' or v_na_type is null
     or v_na_type not in ('SEND_MESSAGE', 'ASK_DIAGNOSTIC_QUESTION', 'WAIT', 'STOP_CONTACT')
     or not private.ac_text(v_na -> 'text', 2000)
     or private.ac_extra_keys(v_na, array['type', 'text']) is not null then
    v_p := array_append(v_p, 'recommendation.next_action needs a type (SEND_MESSAGE, ASK_DIAGNOSTIC_QUESTION, WAIT, STOP_CONTACT) and a text');
  end if;
  v_x := private.ac_extra_keys(v_rec, array['pursue', 'strategy', 'psychological_rationale', 'based_on_hypotheses', 'next_action']);
  if v_x is not null then v_p := array_append(v_p, 'recommendation: unexpected keys ' || v_x); end if;

  if v_pursue = 'PURSUE' then
    if v_rec ->> 'strategy' = 'UNKNOWN' or v_rec ->> 'psychological_rationale' = 'UNKNOWN'
       or jsonb_array_length(private.ac_arr(v_rec -> 'based_on_hypotheses')) = 0 then
      v_p := array_append(v_p, 'PURSUE needs a strategy, a psychological rationale and the hypotheses it rests on');
    end if;
    if v_na_type not in ('SEND_MESSAGE', 'ASK_DIAGNOSTIC_QUESTION') then
      v_p := array_append(v_p, 'PURSUE needs a message or a diagnostic question as the next action');
    end if;
  elsif v_pursue = 'DO_NOT_PURSUE' then
    if v_na_type is distinct from 'STOP_CONTACT' then
      v_p := array_append(v_p, 'DO_NOT_PURSUE needs STOP_CONTACT as the next action');
    end if;
    if jsonb_array_length(v_res) = 0 and jsonb_array_length(v_rnp) = 0 then
      v_p := array_append(v_p, 'DO_NOT_PURSUE needs a contact restriction or a reason not to pursue');
    end if;
  elsif v_pursue = 'UNKNOWN' then
    if v_na_type not in ('ASK_DIAGNOSTIC_QUESTION', 'WAIT') then
      v_p := array_append(v_p, 'UNKNOWN pursuit needs a diagnostic question or WAIT as the next action');
    end if;
  end if;
  if jsonb_array_length(v_res) > 0 and v_pursue is distinct from 'DO_NOT_PURSUE' then
    v_p := array_append(v_p, 'a contact restriction requires DO_NOT_PURSUE');
  end if;
  -- classification and proposed message agree with the recommendation
  if (v_pursue = 'DO_NOT_PURSUE' and p_ai_classification is distinct from 'RED')
     or (v_pursue = 'PURSUE' and p_ai_classification is distinct from 'GREEN' and p_ai_classification is distinct from 'YELLOW')
     or (v_pursue = 'UNKNOWN' and p_ai_classification is not null) then
    v_p := array_append(v_p, 'classification does not match the recommendation (RED = DO_NOT_PURSUE, GREEN/YELLOW = PURSUE, none = UNKNOWN)');
  end if;
  if nullif(btrim(coalesce(p_ai_proposed_message, '')), '') is not null then
    if v_na_type is distinct from 'SEND_MESSAGE' or private.ac_norm(p_ai_proposed_message) <> private.ac_norm(v_na ->> 'text') then
      v_p := array_append(v_p, 'a proposed message is allowed only for SEND_MESSAGE and must equal its text');
    end if;
  elsif v_na_type = 'SEND_MESSAGE' then
    v_p := array_append(v_p, 'SEND_MESSAGE needs the proposed message');
  end if;

  -- sufficiency and status
  select count(*) into v_usable from (
    select 1 from jsonb_array_elements(private.ac_arr(p_analysis.evidence_manifest -> 'messages'))
    union all
    select 1 from jsonb_array_elements(private.ac_arr(p_analysis.evidence_manifest -> 'screenshots')) m
    where exists (select 1 from public.case_screenshots s where s.case_id = p_analysis.case_id
                  and s.position = (m ->> 'position')::integer and s.sha256 = m ->> 'sha256' and s.file_deleted_at is null)) u;
  if p_status = 'INSUFFICIENT_EVIDENCE' then
    if v_suff is distinct from 'INSUFFICIENT' then
      v_p := array_append(v_p, 'INSUFFICIENT_EVIDENCE requires sufficiency INSUFFICIENT');
    end if;
    if jsonb_array_length(v_hyp) > 0 or p_ai_classification is not null or nullif(btrim(coalesce(p_ai_proposed_message, '')), '') is not null
       or v_rec ->> 'strategy' is distinct from 'UNKNOWN' then
      v_p := array_append(v_p, 'INSUFFICIENT_EVIDENCE carries no hypotheses, classification, proposed message or strategy (strategy UNKNOWN)');
    end if;
    if v_pursue = 'PURSUE' then
      v_p := array_append(v_p, 'INSUFFICIENT_EVIDENCE cannot recommend PURSUE');
    end if;
    if jsonb_array_length(v_unk) = 0 or jsonb_array_length(private.ac_arr(v_ea -> 'missing_evidence')) = 0 then
      v_p := array_append(v_p, 'INSUFFICIENT_EVIDENCE must state what is missing (missing_evidence and unknowns)');
    end if;
  else
    if v_usable = 0 then
      v_p := array_append(v_p, 'no usable evidence remains (none recorded, or all deleted): only INSUFFICIENT_EVIDENCE is allowed');
    end if;
    if v_suff = 'INSUFFICIENT' then
      v_p := array_append(v_p, 'sufficiency INSUFFICIENT requires status INSUFFICIENT_EVIDENCE');
    end if;
    if jsonb_array_length(v_obs) = 0 then
      v_p := array_append(v_p, 'COMPLETE needs at least one observation');
    end if;
    if v_suff = 'PARTIAL' and jsonb_array_length(v_unk) = 0 then
      v_p := array_append(v_p, 'PARTIAL evidence must list at least one unknown');
    end if;
  end if;
  return v_p;
exception when others then
  -- Fail closed: anything unexpected in the output rejects it.
  return array['output could not be validated: ' || sqlerrm];
end $$;

-- ---------------------------------------------------------------- record results only if they meet the contract
create or replace function public.internal_complete_analysis(
  p_analysis_id uuid,
  p_status public.analysis_status,
  p_model text default null,
  p_prompt_version text default null,
  p_output jsonb default null,
  p_ai_classification public.classification default null,
  p_ai_proposed_message text default null,
  p_detected_restrictions jsonb default '[]'::jsonb,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_estimated_cost_usd numeric default null,
  p_error text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_analysis public.analyses;
  v_case public.cases;
  v_restrictions jsonb := coalesce(p_detected_restrictions, '[]'::jsonb);
  v_message text;
  v_item jsonb;
  v_problems text[];
  v_failure text;
begin
  if coalesce((select auth.jwt()) ->> 'role', '') <> 'service_role' then
    perform private.fail('FORBIDDEN', 'server-side only');
  end if;
  select * into v_analysis from public.analyses where id = p_analysis_id for update;
  if not found then
    perform private.fail('NOT_FOUND', 'analysis not found');
  end if;
  if v_analysis.status <> 'PENDING' then
    perform private.fail('INVALID_STATE', 'analysis already completed');
  end if;
  if p_status = 'PENDING' then
    perform private.fail('VALIDATION', 'a completed analysis cannot be PENDING');
  end if;
  if jsonb_typeof(v_restrictions) is distinct from 'array' then
    perform private.fail('VALIDATION', 'detected restrictions must be an array');
  end if;
  select * into v_case from public.cases where id = v_analysis.case_id for update;

  if p_status = 'ERROR' then
    v_failure := coalesce(p_error, 'analysis failed');
  elsif v_case.evidence_version <> v_analysis.evidence_version or v_case.workflow_state <> 'ANALYZING' then
    v_failure := 'STALE: evidence changed during analysis';
  else
    v_problems := private.analysis_output_problems(v_analysis, p_status, p_output, p_ai_classification,
                                                   p_ai_proposed_message, v_restrictions);
    if cardinality(v_problems) > 0 then
      v_failure := 'REJECTED by analysis contract rre-analysis/1: ' || array_to_string(v_problems[1:10], '; ')
                   || case when cardinality(v_problems) > 10 then format(' (+%s more)', cardinality(v_problems) - 10) else '' end;
    end if;
  end if;

  if v_failure is not null then
    -- Nothing from a failed, stale or rejected analysis is kept as findings.
    update public.analyses set status = 'ERROR', error = left(v_failure, 2000),
      model = p_model, prompt_version = p_prompt_version, input_tokens = p_input_tokens,
      output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
    where id = v_analysis.id;
    update public.cases set workflow_state = v_analysis.prior_state
    where id = v_case.id and workflow_state = 'ANALYZING';
    perform private.audit(case when v_problems is not null and cardinality(v_problems) > 0 then 'ANALYSIS_REJECTED' else 'ANALYSIS_FAILED' end,
      v_case.id, v_case.business_id, 'SERVICE', null,
      jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version)
      || case when cardinality(v_problems) > 0 then jsonb_build_object('problems', cardinality(v_problems)) else '{}'::jsonb end);
    return;
  end if;

  -- Invariant: no proposed message for RED or when any restriction is detected.
  v_message := case when p_ai_classification = 'RED' or jsonb_array_length(v_restrictions) > 0 then null
                    else nullif(btrim(coalesce(p_ai_proposed_message, '')), '') end;

  update public.analyses set status = p_status, model = p_model, prompt_version = p_prompt_version, output = p_output,
    ai_classification = p_ai_classification, ai_proposed_message = v_message, input_tokens = p_input_tokens,
    output_tokens = p_output_tokens, estimated_cost_usd = p_estimated_cost_usd, completed_at = now()
  where id = v_analysis.id;

  for v_item in select * from jsonb_array_elements(v_restrictions) loop
    insert into public.contact_restrictions (case_id, business_id, kind, source, note, evidence)
    values (v_case.id, v_case.business_id, (v_item ->> 'kind')::public.restriction_kind, 'AI_DETECTED',
            left(v_item ->> 'note', 1000), v_item -> 'evidence');
  end loop;

  update public.cases set workflow_state = 'AWAITING_ADMIN_REVIEW' where id = v_case.id;
  perform private.audit('ANALYSIS_COMPLETED', v_case.id, v_case.business_id, 'SERVICE', null,
    jsonb_build_object('analysis_id', v_analysis.id, 'version', v_analysis.version, 'status', p_status,
                       'detected_restrictions', jsonb_array_length(v_restrictions)));
end $$;

-- ---------------------------------------------------------------- privileges: nobody calls the contract directly
revoke all on function private.ac_text(jsonb, integer), private.ac_extra_keys(jsonb, text[]), private.ac_norm(text),
  private.ac_arr(jsonb), private.ac_ref_problems(public.analyses, jsonb, text),
  private.ac_refs_problems(public.analyses, jsonb, text, integer),
  private.analysis_output_problems(public.analyses, public.analysis_status, jsonb, public.classification, text, jsonb)
  from public, anon, authenticated, service_role;

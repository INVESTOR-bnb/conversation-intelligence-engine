-- Stage 2A-5b: evidence integrity — usable evidence only, no analysis without
-- evidence, staleness on any evidence change, and detected restrictions that are
-- never lost. Synthetic data only; no AI.
begin;
select tests.as_owner();
select tests.seed();

-- A submitted screenshot case of client A with three recorded screenshots (fixture rows).
create function pg_temp.shot_case(p_ref text, p_positions int[]) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform tests.login(tests.client_a());
  v := public.client_create_case(gen_random_uuid(), p_ref, 'Synthetic Hilux', 'Referral', 'SCREENSHOTS');
  perform tests.as_owner();
  insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
  select v, tests.biz_a(), p, format('%s/%s/%s-%s.png', tests.biz_a(), v, p, repeat(p::text, 64)), 'image/png', 1000, repeat(p::text, 64), tests.client_a()
  from unnest(p_positions) p;
  update public.cases set workflow_state = 'SUBMITTED', evidence_version = 1 where id = v;
  return v;
end $$;
create function pg_temp.ev(p_case uuid) returns integer language sql as $$ select evidence_version from public.cases where id = p_case $$;
create function pg_temp.start(p_case uuid) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform tests.login(tests.founder());
  v := public.founder_start_analysis(p_case);
  perform tests.as_owner();
  return v;
end $$;
-- A contract-valid output for a screenshot case citing one stored position.
create function pg_temp.shot_output(p_pos int) returns jsonb language sql as $$
  select jsonb_build_object('contract_version', 'rre-analysis/1',
    'evidence_assessment', '{"sufficiency": "SUFFICIENT", "summary": "Screenshots.", "missing_evidence": []}'::jsonb,
    'observations', jsonb_build_array(jsonb_build_object('id', 'O1', 'actor', 'PROSPECT', 'behavior', 'Asked about delivery.',
       'evidence', jsonb_build_array(jsonb_build_object('type', 'SCREENSHOT', 'position', p_pos)))),
    'hypotheses', '[]'::jsonb, 'unknowns', '[]'::jsonb,
    'recommendation', '{"pursue": "UNKNOWN", "strategy": "UNKNOWN", "psychological_rationale": "UNKNOWN", "based_on_hypotheses": [],
                        "next_action": {"type": "ASK_DIAGNOSTIC_QUESTION", "text": "Ask when delivery is needed."}}'::jsonb,
    'contact_restrictions', '[]'::jsonb, 'reasons_not_to_pursue', '[]'::jsonb)
$$;
create function pg_temp.complete(p_analysis uuid, p_status public.analysis_status, p_output jsonb,
  p_class public.classification default null, p_msg text default null, p_restr jsonb default '[]') returns void language plpgsql as $$
begin
  perform tests.as_service();
  perform public.internal_complete_analysis(p_analysis, p_status, 'synthetic-model', 'v1', p_output, p_class, p_msg, p_restr);
  perform tests.as_owner();
end $$;

-- ---------------------------------------------------------------- usable evidence (manifest v2)
select pg_temp.shot_case('INT-1', array[1, 2, 3]) as s1 \gset
update public.case_screenshots set file_deleted_at = now() where case_id = :'s1' and position = 2;
select pg_temp.start(:'s1') as a1 \gset
select tests.is((select evidence_manifest ->> 'manifest_version' from public.analyses where id = :'a1'), '2', 'analyses start from manifest v2');
select tests.is((select string_agg(e ->> 'position', ',' order by (e ->> 'position')::int) from public.analyses a, jsonb_array_elements(a.evidence_manifest -> 'screenshots') e where a.id = :'a1'),
  '1,3', 'a screenshot deleted under retention is not usable evidence');
select tests.ok((select evidence_manifest -> 'excluded_screenshots' -> 0 ->> 'position' = '2' and evidence_manifest -> 'excluded_screenshots' -> 0 ->> 'reason' = 'FILE_DELETED'
                 from public.analyses where id = :'a1'), 'the deleted screenshot is listed as excluded (FILE_DELETED), for the founder');
select tests.ok((select (a.evidence_manifest -> 'screenshots') @> '[{"position": 1}]' from public.analyses a where a.id = :'a1')
            and not (select (a.evidence_manifest -> 'screenshots') @> '[{"position": 2}]' from public.analyses a where a.id = :'a1'), 'only stored files are in the manifest');
select pg_temp.complete(:'a1', 'COMPLETE', pg_temp.shot_output(2));
select tests.ok((select status = 'ERROR' and error like '%screenshot is not part of this analysis''s evidence%' from public.analyses where id = :'a1'),
  'citing the excluded screenshot is rejected by the 2A-5a contract');

-- Messages carry a hash of their text.
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'INT-T', 'Synthetic Corolla', 'Referral', 'TEXT', 'Prospect: Is the price final? Business: Yes, synthetic.') as t \gset
select public.client_submit_case(:'t');
select pg_temp.start(:'t') as at \gset
select tests.ok((select a.evidence_manifest -> 'messages' -> 0 ->> 'body_sha256' = encode(sha256(convert_to(m.body, 'UTF8')), 'hex')
                 from public.analyses a join public.case_messages m on m.id = (a.evidence_manifest -> 'messages' -> 0 ->> 'id')::uuid where a.id = :'at'),
  'each message in the manifest carries the SHA-256 of its text');

-- ---------------------------------------------------------------- no usable evidence: no analysis
select pg_temp.shot_case('INT-0', array[1, 2]) as s0 \gset
update public.case_screenshots set file_deleted_at = now() where case_id = :'s0';
select pg_temp.ev(:'s0') as ev0 \gset
select tests.login(tests.founder());
select tests.throws(format('select public.founder_start_analysis(%L)', :'s0'), '^INSUFFICIENT_EVIDENCE: no usable evidence.*\(2 deleted under retention\)',
  'an analysis cannot start when every file was deleted');
select tests.as_owner();
select tests.is(tests.count(format('select 1 from public.analyses where case_id = %L', :'s0')), 0::bigint, 'no analysis row is created');
select tests.ok((select workflow_state = 'SUBMITTED' from public.cases where id = :'s0') and pg_temp.ev(:'s0') = :'ev0'::int, 'the case is unchanged');
select tests.is(tests.count(format($q$select 1 from public.audit_log where case_id = %L and action = 'ANALYSIS_STARTED'$q$, :'s0')), 0::bigint, 'nothing is audited as started');
-- A screenshot case whose evidence was never recorded is refused the same way.
select pg_temp.shot_case('INT-E', array[]::int[]) as se \gset
select tests.login(tests.founder());
select tests.throws(format('select public.founder_start_analysis(%L)', :'se'), '^INSUFFICIENT_EVIDENCE', 'a case with no evidence at all cannot be analysed');
select tests.as_owner();

-- ---------------------------------------------------------------- staleness: evidence changes while analysing
select pg_temp.shot_case('INT-2', array[1, 2]) as s2 \gset
select pg_temp.start(:'s2') as a2 \gset
select pg_temp.ev(:'s2') as ev2 \gset
update public.case_screenshots set file_deleted_at = now() where case_id = :'s2' and position = 2;   -- retention during analysis
select tests.is(pg_temp.ev(:'s2'), :'ev2'::int + 1, 'deleting a file under retention bumps the evidence version');
select pg_temp.complete(:'a2', 'COMPLETE', pg_temp.shot_output(1));
select tests.ok((select status = 'ERROR' and error like 'STALE%' and output is null from public.analyses where id = :'a2'), 'an analysis finished on changed evidence is STALE (no findings kept)');
select tests.is((select workflow_state::text from public.cases where id = :'s2'), 'SUBMITTED', 'the case returns to its prior state');

-- ---------------------------------------------------------------- staleness: evidence changes during founder review
select pg_temp.start(:'s2') as a3 \gset
select pg_temp.complete(:'a3', 'COMPLETE', pg_temp.shot_output(1));
select tests.is((select status::text from public.analyses where id = :'a3'), 'COMPLETE', 'a fresh analysis of the remaining evidence completes');
select tests.ok((select not (evidence_manifest -> 'screenshots') @> '[{"position": 2}]' from public.analyses where id = :'a3'), 'the re-run excludes the deleted file');
update public.case_screenshots set file_deleted_at = now() where case_id = :'s2' and position = 1;
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, %s, %L, %L, %L, null, %L)', :'s2', :'a3', pg_temp.ev(:'s2'), 'YELLOW', 'Unclear.', 'Ask.', 'EDITED'),
  '^STALE_ANALYSIS', 'an analysis whose cited evidence was deleted during review cannot be approved');
select public.founder_request_reanalysis(:'s2');
select tests.throws(format('select public.founder_start_analysis(%L)', :'s2'), '^INSUFFICIENT_EVIDENCE', '... and with every file now deleted it cannot be re-run');
select tests.as_owner();

-- Text evidence: an edited or deleted message makes the analysis stale.
select pg_temp.complete(:'at', 'COMPLETE', tests.contract_output(:'at', 'GREEN', 'Synthetic follow-up.'), 'GREEN', 'Synthetic follow-up.');
select pg_temp.ev(:'t') as evt \gset
update public.case_messages set body = body || ' (edited)' where case_id = :'t';
select tests.is(pg_temp.ev(:'t'), :'evt'::int + 1, 'editing a message bumps the evidence version');
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, %s, %L, %L, %L, %L, %L)', :'t', :'at', pg_temp.ev(:'t'), 'GREEN', 's', 'n', 'Synthetic follow-up.', 'UNCHANGED'),
  '^STALE_ANALYSIS', 'an analysis of an edited message cannot be approved');
select tests.as_owner();
select pg_temp.ev(:'t') as evt2 \gset
insert into public.case_messages (case_id, business_id, kind, body) values (:'t', tests.biz_a(), 'PROSPECT_RESPONSE', 'Synthetic extra line.') returning id as mx \gset
delete from public.case_messages where id = :'mx';
select tests.is(pg_temp.ev(:'t'), :'evt2'::int + 1, 'deleting a message bumps the evidence version');

-- Changes that are not evidence do not.
select pg_temp.ev(:'s1') as ev1 \gset
update public.case_screenshots set width = 1080, height = 2400 where case_id = :'s1';
select tests.is(pg_temp.ev(:'s1'), :'ev1'::int, 'non-evidence columns do not bump the version');
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'INT-D', 'Synthetic', 'Referral', 'SCREENSHOTS') as d \gset
select tests.as_owner();
insert into public.case_screenshots (case_id, business_id, position, storage_path, mime_type, size_bytes, sha256, created_by)
values (:'d', tests.biz_a(), 1, tests.biz_a() || '/' || :'d' || '/1-' || repeat('d', 64) || '.png', 'image/png', 1, repeat('d', 64), tests.client_a());
select pg_temp.ev(:'d') as evd \gset
update public.case_screenshots set file_deleted_at = now() where case_id = :'d';
select tests.is(pg_temp.ev(:'d'), :'evd'::int, 'draft evidence changes do not bump the version (fixed at submission)');

-- ---------------------------------------------------------------- restrictions are never lost
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'INT-R', 'Synthetic', 'Referral', 'TEXT', 'Prospect: Please stop messaging me. Business: Noted, synthetic.') as r \gset
select public.client_submit_case(:'r');
select pg_temp.start(:'r') as ar1 \gset
select pg_temp.ev(:'r') as evr \gset
-- Rejected by the contract (no evidence at all), with a detected opt-out.
select pg_temp.complete(:'ar1', 'COMPLETE', '{"verdict": "keep selling"}', 'GREEN', 'Buy now!',
  '[{"kind": "EXPLICIT_OPT_OUT", "note": "Prospect: Please stop messaging me.", "evidence": {"message": "pasted"}}]');
select tests.ok((select status = 'ERROR' and error like 'REJECTED%' and output is null and ai_proposed_message is null from public.analyses where id = :'ar1'),
  'the rejected analysis keeps no findings and no message');
select tests.ok((select kind = 'EXPLICIT_OPT_OUT' and source = 'AI_DETECTED' and status = 'ACTIVE' and note like 'Detected by analysis v1, which was not accepted.%stop messaging%'
                        and evidence = '{"message": "pasted"}'::jsonb
                 from public.contact_restrictions where case_id = :'r'), 'its detected opt-out is recorded anyway (active, with note and evidence)');
select tests.ok((select (details ->> 'restrictions_preserved')::int = 1 from public.audit_log where case_id = :'r' and action = 'ANALYSIS_REJECTED'), 'the rejection audit says one restriction was preserved');
select tests.ok(exists (select 1 from public.audit_log where case_id = :'r' and action = 'RESTRICTION_ADDED' and actor_role = 'SERVICE' and client_label is null),
  'the restriction is audited (founder-only, no client label)');
select tests.is(pg_temp.ev(:'r'), :'evr'::int + 1, 'recording it bumps the evidence version');
-- A failed (ERROR) and a stale analysis keep their restrictions too; unknown kinds become OTHER; no duplicates.
select pg_temp.start(:'r') as ar2 \gset
select pg_temp.complete(:'ar2', 'ERROR', null, null, null,
  '[{"kind": "EXPLICIT_OPT_OUT"}, {"kind": "DO_NOT_CALL", "note": "synthetic"}, "stop"]');
select tests.is(tests.count(format($q$select 1 from public.contact_restrictions where case_id = %L and kind = 'EXPLICIT_OPT_OUT'$q$, :'r')), 1::bigint,
  'the same active kind is not recorded twice');
select tests.ok(exists (select 1 from public.contact_restrictions where case_id = :'r' and kind = 'OTHER' and note like '%Unrecognised kind "DO_NOT_CALL" recorded as OTHER.%'),
  'an unrecognised kind from a failed analysis is kept as OTHER');
select tests.is(tests.count(format($q$select 1 from public.contact_restrictions where case_id = %L and kind = 'OTHER'$q$, :'r')), 1::bigint,
  'a malformed item adds no second active OTHER (folded into the existing one)');
select tests.is(private.preserve_detected_restrictions(:'t', '["stop"]', 9), 1, 'on its own, a malformed item (a bare string) is kept as OTHER');
select tests.ok(exists (select 1 from public.contact_restrictions where case_id = :'t' and kind = 'OTHER' and note like '%Unrecognised kind "(none)" recorded as OTHER.%'),
  '... with a note saying its kind was unrecognised');
delete from public.contact_restrictions where case_id = :'t';
select pg_temp.start(:'r') as ar3 \gset
update public.case_messages set body = body || ' ' where case_id = :'r';   -- evidence changes mid-analysis
select pg_temp.complete(:'ar3', 'COMPLETE', tests.contract_output(:'ar3', 'RED', null, '[{"kind": "PROHIBITED_CONTACT"}]'), 'RED', null, '[{"kind": "PROHIBITED_CONTACT"}]');
select tests.ok((select status = 'ERROR' and error like 'STALE%' from public.analyses where id = :'ar3')
            and exists (select 1 from public.contact_restrictions where case_id = :'r' and kind = 'PROHIBITED_CONTACT' and status = 'ACTIVE'),
  'a stale analysis is discarded but its restriction is kept');
-- The kept restriction still blocks contact once an analysis is accepted.
select pg_temp.start(:'r') as ar4 \gset
select pg_temp.complete(:'ar4', 'COMPLETE', tests.contract_output(:'ar4', 'GREEN', 'Synthetic pitch.'), 'GREEN', 'Synthetic pitch.');
select tests.login(tests.founder());
select tests.throws(format('select public.founder_approve(%L, %L, %s, %L, %L, %L, %L, %L)', :'r', :'ar4', pg_temp.ev(:'r'), 'GREEN', 's', 'n', 'Synthetic pitch.', 'UNCHANGED'),
  '^CONTACT_RESTRICTED', 'the preserved opt-out blocks a GREEN approval');
-- Accepted analyses behave as before.
select tests.as_owner();
select tests.is(tests.count(format('select 1 from public.contact_restrictions where case_id = %L', :'t')), 0::bigint, 'an accepted analysis without restrictions records none');

-- ---------------------------------------------------------------- confidentiality and isolation
select tests.login(tests.client_a());
select tests.is(tests.count('select 1 from public.contact_restrictions'), 0::bigint, 'the business user reads no restriction');
select tests.is(tests.count('select 1 from public.analyses'), 0::bigint, 'nor any analysis or manifest');
select tests.ok(public.client_get_case(:'r')::text !~* '(Detected by analysis|DO_NOT_CALL|keep selling|Buy now|manifest|excluded)', 'the case detail leaks nothing');
select tests.is((select status from public.client_list_cases() where id = :'r'), 'UNDER_REVIEW', 'the client sees only Under review');
select tests.login(tests.client_b());
select tests.throws(format('select public.client_get_case(%L)', :'r'), '^NOT_FOUND', 'another business sees nothing of the case');
select tests.throws(format('select public.founder_start_analysis(%L)', :'t'), '^FORBIDDEN', 'a business user cannot start an analysis');

-- ---------------------------------------------------------------- privileges and the 2A-5a contract
select tests.as_owner();
select tests.ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'private' and p.proname in ('evidence_manifest', 'tg_evidence_changed', 'preserve_detected_restrictions')
                              and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                   or has_function_privilege('service_role', p.oid, 'EXECUTE') or not (p.prosecdef and p.proconfig @> array['search_path=""']))),
  'the new functions are internal (no API role) and pin search_path');
select tests.ok((select prosrc like '%private.analysis_output_problems(%' and prosrc like '%REJECTED by analysis contract rre-analysis/1%'
                 from pg_proc where proname = 'internal_complete_analysis'), 'internal_complete_analysis still enforces the 2A-5a contract');
select tests.is((select count(*)::int from pg_trigger where tgname in ('rre_case_screenshots_evidence_update', 'rre_case_screenshots_evidence_delete',
                 'rre_case_messages_evidence_update', 'rre_case_messages_evidence_delete') and tgenabled = 'O'), 4, 'the four evidence triggers are enabled');
-- Deleting a whole case (owner) still works with the evidence triggers in place.
select tests.lives(format('delete from public.cases where id = %L', :'d'), 'a case with evidence can still be deleted by the owner');
rollback;

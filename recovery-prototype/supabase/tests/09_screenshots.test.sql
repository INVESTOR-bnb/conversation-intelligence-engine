-- Stage 2A-4c: screenshot intake. Storage rules on storage.objects, the
-- finalize/status functions, isolation, concurrency and evidence retention.
-- Uploads are imitated by inserting storage.objects rows as the signed-in role,
-- which is what the Storage API does (it also sets owner_id and metadata).
-- LOCAL EMULATION ONLY: real Storage behaviour is verified on staging.
begin;
select tests.as_owner();
select tests.seed();
insert into storage.buckets (id, name, public) values ('other-bucket', 'other-bucket', false);

-- An "upload" as the current session (owner_id = caller, like the Storage API).
create function pg_temp.up(p_name text, p_size bigint default 1000, p_mime text default 'image/png') returns void
language sql as $$
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('case-screenshots', p_name, (select auth.uid())::text, jsonb_build_object('size', p_size, 'mimetype', p_mime));
$$;
create function pg_temp.nm(p_biz uuid, p_case uuid, p_pos int, p_hex text default 'a', p_ext text default 'png') returns text
language sql immutable as $$ select format('%s/%s/%s-%s.%s', p_biz, p_case, p_pos, repeat(p_hex, 64), p_ext) $$;
create function pg_temp.objects_in(p_case uuid) returns bigint language sql as $$
  select count(*) from storage.objects where bucket_id = 'case-screenshots' and name like '%/' || p_case || '/%' $$;

-- ---------------------------------------------------------------- bucket configuration
select tests.ok((select not public and file_size_limit = 5242880 and allowed_mime_types = array['image/png', 'image/jpeg']
                 from storage.buckets where id = 'case-screenshots'), 'bucket is private, 5 MB, PNG/JPEG only');

-- ---------------------------------------------------------------- fixtures (created through the real functions)
select tests.login(tests.client_a());
select tests.is(current_user::text, 'authenticated', 'client session runs as the authenticated role');
select tests.ok(not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user), 'client role does not bypass RLS');
select public.client_create_case(gen_random_uuid(), 'SHOT-1', 'Synthetic Corolla', 'Referral', 'SCREENSHOTS') as s1 \gset
select public.client_create_case(gen_random_uuid(), 'SHOT-2', 'Synthetic Hilux', 'Referral', 'SCREENSHOTS') as s2 \gset
select public.client_create_case(gen_random_uuid(), 'SHOT-3', 'Synthetic Lexus', 'Referral', 'SCREENSHOTS') as s3 \gset
select public.client_create_case(gen_random_uuid(), 'TXT-1', 'Synthetic Camry', 'Referral', 'TEXT', 'Prospect: synthetic pasted conversation') as t1 \gset
select tests.login(tests.client_b());
select public.client_create_case(gen_random_uuid(), 'SHOT-B', 'Synthetic Course', 'Google', 'SCREENSHOTS') as sb \gset

-- ---------------------------------------------------------------- uploads: allowed and refused
select tests.login(tests.client_a());
select tests.lives(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'s1', 1)), 'client uploads position 1 to its own draft screenshot case');
select tests.lives(format('select pg_temp.up(%L, 2000, %L)', pg_temp.nm(tests.biz_a(), :'s1', 2, 'b', 'jpg'), 'image/jpeg'), 'client uploads a JPEG at position 2');
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'s1', 1)), 'row-level security', 'the same file again is refused (no second row); the app confirms via status');
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'s1', 1, 'c')), 'row-level security', 'a different file at a used position is refused');
select tests.throws(format('select pg_temp.up(%L)', replace(pg_temp.nm(tests.biz_a(), :'s1', 3), '/3-', '/11-')), 'row-level security', 'position 11 is refused');
select tests.throws(format('select pg_temp.up(%L)', replace(pg_temp.nm(tests.biz_a(), :'s1', 3), '/3-', '/0-')), 'row-level security', 'position 0 is refused');
select tests.throws(format('select pg_temp.up(%L)', replace(pg_temp.nm(tests.biz_a(), :'s1', 3), '.png', '.gif')), 'row-level security', 'a .gif name is refused');
select tests.throws(format('select pg_temp.up(%L)', upper(pg_temp.nm(tests.biz_a(), :'s1', 3))), 'row-level security', 'an upper-case name is refused');
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'s1', 3) || '/x'), 'row-level security', 'a name with extra segments is refused');
select tests.throws(format('select pg_temp.up(%L)', '../' || pg_temp.nm(tests.biz_a(), :'s1', 3)), 'row-level security', 'a traversal-style name is refused');
select tests.throws(format('select pg_temp.up(%L)', tests.biz_a() || '/' || :'s1' || '/3-short.png'), 'row-level security', 'a name without a full SHA-256 is refused');
-- Cross-business attempts
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_b(), :'sb', 1)), 'row-level security', 'client A cannot upload into client B''s business and case');
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'sb', 1)), 'row-level security', 'client A cannot target B''s case under its own business folder');
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_b(), :'s1', 3)), 'row-level security', 'client A cannot put its own case under B''s business folder');
-- Wrong case type / bucket
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'t1', 1)), 'row-level security', 'no uploads into a pasted-text case');
select tests.throws(format($q$insert into storage.objects (bucket_id, name, owner_id, metadata) values ('other-bucket', %L, auth.uid()::text, '{}')$q$, pg_temp.nm(tests.biz_a(), :'s1', 3)),
  'row-level security', 'no uploads into any other bucket');

-- ---------------------------------------------------------------- read, list, copy, replace, move, delete
select tests.is(tests.count('select 1 from storage.objects'), 0::bigint, 'client cannot read or list any stored file, not even its own');
select tests.is(tests.count('select 1 from storage.buckets'), 0::bigint, 'client cannot list buckets');
update storage.objects set name = replace(name, '/1-', '/5-') where bucket_id = 'case-screenshots';
delete from storage.objects where bucket_id = 'case-screenshots';
select tests.throws(format($q$insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', %L, auth.uid()::text, '{"size":1,"mimetype":"image/png"}')
                           on conflict (bucket_id, name) do update set metadata = excluded.metadata$q$, pg_temp.nm(tests.biz_a(), :'s1', 1)),
  'row-level security', 'replacing a stored file (upsert) is refused');
select tests.as_owner();
select tests.is(pg_temp.objects_in(:'s1'), 2::bigint, 'client update (move/replace) and delete changed nothing');
select tests.is((select count(*) from storage.objects where name like '%/5-%'), 0::bigint, 'no file was moved or renamed');

select tests.login(tests.client_b());
select tests.is(tests.count('select 1 from storage.objects'), 0::bigint, 'client B cannot see client A''s files');
select tests.login(tests.unassigned());
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'s1', 3)), 'row-level security', 'an unlinked user cannot upload');
select tests.as_anon();
select tests.throws(format($q$insert into storage.objects (bucket_id, name, metadata) values ('case-screenshots', %L, '{}')$q$, pg_temp.nm(tests.biz_a(), :'s1', 3)),
  'row-level security', 'anon cannot upload');
select tests.is(tests.count('select 1 from storage.objects'), 0::bigint, 'anon cannot read or list files');

select tests.login(tests.founder());
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'s1', 3)), 'row-level security', 'the founder cannot upload (not a business member)');
select tests.is(tests.count($q$select 1 from storage.objects where bucket_id = 'case-screenshots'$q$), 2::bigint, 'the founder can read (download/list) screenshot files');
update storage.objects set name = name || 'x' where bucket_id = 'case-screenshots';
delete from storage.objects where bucket_id = 'case-screenshots';
select tests.is(tests.count($q$select 1 from storage.objects where bucket_id = 'case-screenshots' and name like '%x'$q$), 0::bigint, 'the founder cannot move/rename files');
select tests.is(tests.count($q$select 1 from storage.objects where bucket_id = 'case-screenshots'$q$), 2::bigint, 'the founder cannot delete files through the API');

-- ---------------------------------------------------------------- status (resume) and isolation
select tests.login(tests.client_a());
select tests.is(jsonb_array_length(public.client_screenshot_status(:'s1') -> 'files'), 2, 'status lists the two uploaded files');
select tests.ok(not exists (select 1 from jsonb_array_elements(public.client_screenshot_status(:'s1') -> 'files') e where e ? 'name' or e ? 'storage_path' or e::text ~ ('case-screenshots|' || tests.biz_a() || '|' || :'s1')),
  'status reveals no paths or names');
select tests.ok((public.client_screenshot_status(:'s1') ->> 'registered_count')::int = 0, 'nothing recorded before finalize');
select tests.ok(public.client_screenshot_status(:'s1') -> 'files' @> jsonb_build_array(jsonb_build_object('position', 1, 'sha256', repeat('a', 64), 'size', 1000, 'registered', false)),
  'status lets the client confirm an upload by position, hash and size');
select tests.throws(format('select public.client_screenshot_status(%L)', :'sb'), '^NOT_FOUND', 'client A cannot see the status of B''s case');
select tests.login(tests.founder());
select tests.throws(format('select public.client_screenshot_status(%L)', :'s1'), '^NOT_FOUND', 'status is for clients only');

-- ---------------------------------------------------------------- finalize: all-or-nothing checks
select tests.login(tests.client_a());
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'s3'), '^VALIDATION: no screenshots uploaded', 'finalize with nothing uploaded is refused');
select pg_temp.up(pg_temp.nm(tests.biz_a(), :'s3', 1));
select pg_temp.up(pg_temp.nm(tests.biz_a(), :'s3', 3, 'c'));
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'s3'), '^VALIDATION: missing screenshots at positions 2', 'a gap is reported and nothing is recorded');
select tests.is((public.client_screenshot_status(:'s3') ->> 'registered_count')::int, 0, 'gap: nothing recorded');
select pg_temp.up(pg_temp.nm(tests.biz_a(), :'s3', 2, 'b', 'jpg'), 2000, 'image/png');
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'s3'), '^VALIDATION: screenshot failed checks at positions 2', 'declared type must match the extension');
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'t1'), '^VALIDATION: this case uses pasted text', 'finalize refuses a pasted-text case');
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'sb'), '^NOT_FOUND', 'finalize refuses another business''s case');

-- Oversize (if the bucket limit were bypassed) and foreign uploader
select pg_temp.up(pg_temp.nm(tests.biz_a(), :'s2', 1), 6000000);
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'s2'), '^VALIDATION: screenshot failed checks at positions 1', 'a file over 5 MB is not recorded');
select tests.as_owner();
delete from storage.objects where name = pg_temp.nm(tests.biz_a(), :'s2', 1);
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('case-screenshots', pg_temp.nm(tests.biz_a(), :'s2', 1), tests.client_a2()::text, '{"size": 1000, "mimetype": "image/png"}');
select tests.login(tests.client_a());
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'s2'), '^VALIDATION: screenshot failed checks at positions 1', 'a file uploaded by another account is not recorded');

-- Concurrency: two different files at one position (as two simultaneous uploads could produce)
select tests.as_owner();
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('case-screenshots', pg_temp.nm(tests.biz_a(), :'s1', 2, 'd', 'png'), tests.client_a()::text, '{"size": 1000, "mimetype": "image/png"}');
select tests.login(tests.client_a());
select tests.is((select count(*) from jsonb_array_elements(public.client_screenshot_status(:'s1') -> 'files') e where (e ->> 'position')::int = 2), 2::bigint,
  'status shows both conflicting files at position 2');
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'s1'), '^VALIDATION: conflicting screenshots at positions 2', 'finalize rejects duplicate positions');
select tests.is((public.client_screenshot_status(:'s1') ->> 'registered_count')::int, 0, 'conflict: nothing recorded');
select tests.throws(format('select public.client_submit_case(%L)', :'s1'), '^VALIDATION', 'a conflicting draft cannot be submitted');

-- ---------------------------------------------------------------- finalize: success, idempotency, submit
select tests.as_owner();
delete from storage.objects where name like '%/' || :'s3' || '/2-%';
select tests.login(tests.client_a());
select pg_temp.up(pg_temp.nm(tests.biz_a(), :'s3', 2, 'b', 'jpg'), 2000, 'image/jpeg');
select tests.is(public.client_finalize_screenshots(:'s3') ->> 'added', '3', 'finalize records all three files');
select tests.is(public.client_finalize_screenshots(:'s3') ->> 'added', '0', 'finalize again records nothing new (idempotent)');
select tests.ok(not exists (select 1 from jsonb_array_elements(public.client_screenshot_status(:'s3') -> 'files') e where not (e ->> 'registered')::boolean),
  'status shows every file recorded');
select public.client_submit_case(:'s3');
select tests.is((select status from public.client_list_cases() where id = :'s3'), 'UNDER_REVIEW', 'a screenshot case submits and shows Under review');
select tests.throws(format('select pg_temp.up(%L)', pg_temp.nm(tests.biz_a(), :'s3', 4)), 'row-level security', 'no uploads after submission');
select tests.throws(format('select public.client_finalize_screenshots(%L)', :'s3'), '^INVALID_STATE', 'no finalize after submission');
select tests.ok(public.client_get_case(:'s3')::text !~ ('case-screenshots|sha256|' || tests.biz_a()), 'client_get_case exposes no screenshot paths or hashes');
select tests.is(tests.count('select 1 from public.case_screenshots'), 0::bigint, 'clients still cannot read case_screenshots directly');
select tests.throws(format('update public.case_screenshots set file_deleted_at = now() where case_id = %L', :'s3'), 'permission denied', 'clients cannot set retention markers');

select tests.as_owner();
select tests.ok((select bool_and(storage_path like tests.biz_a() || '/' || :'s3' || '/%' and created_by = tests.client_a() and file_deleted_at is null) from public.case_screenshots where case_id = :'s3'),
  'rows store the path, uploader and no deletion marker');
select tests.is((select string_agg(position || ':' || mime_type || ':' || size_bytes || ':' || left(sha256, 4), ',' order by position) from public.case_screenshots where case_id = :'s3'),
  '1:image/png:1000:aaaa,2:image/jpeg:2000:bbbb,3:image/png:1000:cccc', 'positions, types, sizes and hashes come from Storage records and file names');
select tests.is(tests.count(format($q$select 1 from public.audit_log where action = 'SCREENSHOTS_REGISTERED' and case_id = %L$q$, :'s3')), 1::bigint, 'recording is audited once');

select tests.login(tests.founder());
select tests.is(tests.count(format('select 1 from public.case_screenshots where case_id = %L', :'s3')), 3::bigint, 'the founder reads the screenshot records');
select tests.throws(format('update public.case_screenshots set file_deleted_at = now() where case_id = %L', :'s3'), 'permission denied', 'the founder cannot set retention markers through the API');

-- ---------------------------------------------------------------- privileges of the new functions
select tests.as_owner();
select tests.ok(not has_function_privilege('authenticated', 'private.screenshot_objects(uuid, uuid)', 'EXECUTE'), 'internal file lister is not callable by signed-in users');
select tests.ok(not has_function_privilege('anon', 'private.screenshot_upload_allowed(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.client_screenshot_status(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.client_finalize_screenshots(uuid)', 'EXECUTE'), 'anon cannot call any new function');
select tests.ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
  where oid in ('private.screenshot_upload_allowed(text)'::regprocedure, 'private.screenshot_objects(uuid, uuid)'::regprocedure,
                'public.client_screenshot_status(uuid)'::regprocedure, 'public.client_finalize_screenshots(uuid)'::regprocedure)),
  'new functions are SECURITY DEFINER with an empty search_path');

-- ---------------------------------------------------------------- pasted text unchanged
select tests.login(tests.client_a());
select public.client_submit_case(:'t1');
select tests.is((select status from public.client_list_cases() where id = :'t1'), 'UNDER_REVIEW', 'the pasted-text workflow still works');
rollback;

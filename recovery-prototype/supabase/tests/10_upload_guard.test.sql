-- Stage 2A-4c-1: the screenshot upload guard (trigger rre_case_screenshots_guard).
-- The Storage API writes the final object row as service_role (RLS bypassed),
-- after checking the INSERT policy as the caller; a signed upload URL is only
-- checked when it is created. These tests imitate that final write directly as
-- service_role (and as the table owner and postgres) with owner_id set to the
-- uploader, exactly as Storage records it.
-- LOCAL EMULATION ONLY: real Storage behaviour is verified on staging.
begin;
select tests.as_owner();
select tests.seed();
insert into storage.buckets (id, name, public) values ('other-bucket', 'other-bucket', false);

create function pg_temp.nm(p_biz uuid, p_case uuid, p_pos int, p_hex text default 'a', p_ext text default 'png') returns text
language sql immutable as $$ select format('%s/%s/%s-%s.%s', p_biz, p_case, p_pos, repeat(p_hex, 64), p_ext) $$;
-- Storage's final write: as service_role, owner_id = the uploader the URL or session was issued to.
create function pg_temp.sw(p_name text, p_owner uuid) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('case-screenshots', p_name, p_owner::text, '{"size": 1000, "mimetype": "image/png"}');
$$;
-- Storage's upsert shape (createSignedUploadUrl with upsert: true): INSERT ... ON CONFLICT DO UPDATE.
create function pg_temp.sw_upsert(p_name text, p_owner uuid) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('case-screenshots', p_name, p_owner::text, '{"size": 2222, "mimetype": "image/png"}')
  on conflict (bucket_id, name) do update set metadata = excluded.metadata, owner_id = excluded.owner_id;
$$;
create function pg_temp.objects_in(p_case uuid) returns bigint language sql as $$
  select count(*) from storage.objects where bucket_id = 'case-screenshots' and name like '%/' || p_case || '/%' $$;

-- ---------------------------------------------------------------- the guard is installed as reviewed
select tests.ok(exists (select 1 from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'rre_case_screenshots_guard'
                        and t.tgenabled = 'O' and t.tgtype = 7 and not t.tgisinternal),
  'guard trigger: BEFORE INSERT, FOR EACH ROW, enabled');
select tests.ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'private.screenshot_object_guard()'::regprocedure),
  'guard function is SECURITY DEFINER with an empty search_path');
select tests.ok(not has_function_privilege('anon', 'private.screenshot_object_guard()', 'EXECUTE')
            and not has_function_privilege('authenticated', 'private.screenshot_object_guard()', 'EXECUTE')
            and not has_function_privilege('service_role', 'private.screenshot_object_guard()', 'EXECUTE'),
  'nobody can call the guard function directly');

-- ---------------------------------------------------------------- fixtures
select tests.login(tests.client_a());
select public.client_create_case(gen_random_uuid(), 'GUARD-1', 'Synthetic Corolla', 'Referral', 'SCREENSHOTS') as g1 \gset
select public.client_create_case(gen_random_uuid(), 'GUARD-2', 'Synthetic Hilux', 'Referral', 'SCREENSHOTS') as g2 \gset
select public.client_create_case(gen_random_uuid(), 'GUARD-T', 'Synthetic Camry', 'Referral', 'TEXT', 'Prospect: synthetic pasted conversation') as gt \gset
select tests.login(tests.client_b());
select public.client_create_case(gen_random_uuid(), 'GUARD-B', 'Synthetic Course', 'Google', 'SCREENSHOTS') as gb \gset

-- ---------------------------------------------------------------- legitimate uploads still work
select tests.login(tests.client_a());
select tests.lives(format($q$insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', %L, auth.uid()::text, '{"size": 1000, "mimetype": "image/png"}')$q$,
  pg_temp.nm(tests.biz_a(), :'g1', 1)), 'client upload under RLS into its own draft still works (policy path unchanged)');
select tests.as_service();
select tests.lives(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g1', 2, 'b'), tests.client_a()),
  'Storage''s final write (service_role) for a member''s upload into an open draft is accepted');
select tests.lives(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g1', 3, 'c'), tests.client_a()),
  'a third upload by the same client is accepted');
select tests.login(tests.client_a());
select tests.is((public.client_finalize_screenshots(:'g1') ->> 'registered')::int, 3, 'finalize records all three files written through both paths');
select public.client_submit_case(:'g1');
select tests.is((select status from public.client_list_cases() where id = :'g1'), 'UNDER_REVIEW', 'the case is submitted (Under review)');

-- ---------------------------------------------------------------- REGRESSION: signed upload URL used after submission
-- (the staging WARN: a URL created during the draft, used after submission)
select tests.as_service();
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g1', 4, 'd'), tests.client_a()),
  'screenshot upload refused: the case is not an open screenshot draft', 'a signed upload after submission is refused (no unrecorded file)');
select tests.throws(format('select pg_temp.sw_upsert(%L, %L)', pg_temp.nm(tests.biz_a(), :'g1', 1), tests.client_a()),
  'screenshot upload refused', 'an upsert-signed URL cannot replace a recorded screenshot after submission');
select tests.as_owner();
select tests.is((select metadata ->> 'size' from storage.objects where name = pg_temp.nm(tests.biz_a(), :'g1', 1)), '1000', 'the recorded file is unchanged');
select tests.is(pg_temp.objects_in(:'g1'), 3::bigint, 'no file was added to the submitted case');

-- ---------------------------------------------------------------- the same rule for other write paths
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g1', 4, 'd'), tests.client_a()),
  'not an open screenshot draft', 'refused for postgres too (SQL Editor / dashboard path)');
set local role supabase_storage_admin;
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g1', 4, 'd'), tests.client_a()),
  'not an open screenshot draft', 'refused for the table owner (supabase_storage_admin), which RLS does not cover');
reset role;

-- ---------------------------------------------------------------- the full rule, on the privileged path
select tests.as_service();
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g2', 1), tests.client_b()),
  'uploader is not a member of this business', 'a URL issued to another business''s client cannot write here');
select tests.throws(format('select pg_temp.sw(%L, null)', pg_temp.nm(tests.biz_a(), :'g2', 1)),
  'uploader is not a member', 'a write with no recorded uploader is refused');
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_b(), :'gb', 1), tests.client_a()),
  'uploader is not a member', 'client A''s URL cannot target business B''s case');
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'gt', 1), tests.client_a()),
  'not an open screenshot draft', 'no file into a pasted-text case');
select tests.throws(format('select pg_temp.sw(%L, %L)', replace(pg_temp.nm(tests.biz_a(), :'g2', 1), '.png', '.gif'), tests.client_a()),
  'invalid file name', 'an invalid name is refused');
select tests.lives(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g2', 1), tests.client_a()), 'first file at position 1 of a new draft is accepted');
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g2', 1, 'e'), tests.client_a()),
  'this position already holds a file', 'a second signed URL for a taken position is refused (no unlimited files per position)');
select tests.throws(format('select pg_temp.sw_upsert(%L, %L)', pg_temp.nm(tests.biz_a(), :'g2', 1), tests.client_a()),
  'this position already holds a file', 'an upsert-signed URL cannot replace a file in a draft either');
select tests.lives(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g2', 4, 'b'), tests.client_a2()),
  'another member of the same business may add to the draft (business-level rule, as before)');
-- A member removed from the business can no longer use a URL issued earlier.
select tests.as_owner();
delete from public.business_members where user_id = tests.client_a2();
select tests.as_service();
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g2', 2, 'f'), tests.client_a2()),
  'uploader is not a member', 'a URL issued to a since-removed member is refused');
-- Ten files at most, even if positions were duplicated by a race (seeded with triggers off).
select tests.as_owner();
set local session_replication_role = replica;
insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'case-screenshots', pg_temp.nm(tests.biz_a(), :'g2', 2, h), tests.client_a()::text, '{"size": 1, "mimetype": "image/png"}'
from unnest(array['0','1','2','3','4','5','6','7']) h;
set local session_replication_role = origin;
select tests.is(pg_temp.objects_in(:'g2'), 10::bigint, 'the draft now holds 10 files');
select tests.as_service();
select tests.throws(format('select pg_temp.sw(%L, %L)', pg_temp.nm(tests.biz_a(), :'g2', 5, '9'), tests.client_a()),
  'already holds 10 files', 'an eleventh file is refused');

-- ---------------------------------------------------------------- scope: nothing else is affected
select tests.lives($q$insert into storage.objects (bucket_id, name, owner_id) values ('other-bucket', 'anything/at/all.txt', null)$q$,
  'other buckets are not affected');
select tests.login(tests.client_a());
select tests.throws(format($q$insert into storage.objects (bucket_id, name, owner_id, metadata) values ('case-screenshots', %L, auth.uid()::text, '{}')$q$,
  pg_temp.nm(tests.biz_a(), :'g1', 5)), 'row-level security', 'client uploads are still decided by the RLS policy (same refusal as before)');
select tests.login(tests.founder());
select tests.is(tests.count(format($q$select 1 from storage.objects where name like '%%/%s/%%'$q$, :'g1')), 3::bigint, 'the founder still reads the case''s files');
rollback;

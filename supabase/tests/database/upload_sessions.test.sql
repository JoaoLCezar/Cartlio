begin;
select no_plan();
insert into auth.users (id, instance_id, aud, role, email) values
('eeeeeeee-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'uploads-a@cartlio.test'),
('ffffffff-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'uploads-b@cartlio.test');
insert into public.tenants (id, slug, name, created_by) values
('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'uploads-a', 'Uploads A', 'eeeeeeee-1111-4111-8111-111111111111'),
('ffffffff-ffff-4fff-8fff-ffffffffffff', 'uploads-b', 'Uploads B', 'ffffffff-1111-4111-8111-111111111111');
insert into public.tenant_members (tenant_id, user_id, role) values
('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-1111-4111-8111-111111111111', 'owner'),
('ffffffff-ffff-4fff-8fff-ffffffffffff', 'ffffffff-1111-4111-8111-111111111111', 'owner');
insert into public.galleries (id, tenant_id, title, slug) values
('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Uploads A', 'uploads'),
('ffffffff-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'Uploads B', 'uploads');

-- Test-only invoker helpers keep authorization in the production RPCs.
create function pg_temp.upload_id(n int) returns uuid language sql as $$
select ('eeeeeeee-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.reserve(n int, bytes bigint default 128, mime text default 'image/png')
returns public.upload_sessions language sql as $$
select public.reserve_photo_upload('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-0000-4000-8000-000000000001', pg_temp.upload_id(n), 'foto.png', mime, bytes);
$$;
create function pg_temp.complete(n int) returns uuid language sql as $$
select public.complete_photo_upload('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-0000-4000-8000-000000000001', pg_temp.upload_id(n));
$$;
create function pg_temp.cancel(n int) returns text language sql as $$
select public.begin_upload_cancellation('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-0000-4000-8000-000000000001', pg_temp.upload_id(n));
$$;
create function pg_temp.finish_cancel(n int) returns boolean language sql as $$
select public.finish_upload_cancellation('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-0000-4000-8000-000000000001', pg_temp.upload_id(n));
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'eeeeeeee-1111-4111-8111-111111111111', true);
select throws_ok($$update public.tenants set storage_limit_bytes = 9999999999$$, '42501', null, 'Member cannot increase the quota');
select throws_ok($$insert into public.upload_sessions (id) values (pg_temp.upload_id(100))$$, '42501', null, 'Sessions cannot be inserted directly');
select throws_ok($$select pg_temp.reserve(100, 0)$$, '22023', 'UPLOAD_INVALID', 'Reject zero bytes');
select throws_ok($$select pg_temp.reserve(100, 52428801)$$, '22023', 'UPLOAD_INVALID', 'Reject oversized declaration');
select throws_ok($$select pg_temp.reserve(100, 128, 'image/svg+xml')$$, '22023', 'UPLOAD_INVALID', 'Reject unsupported type');
select is((pg_temp.reserve(101)).id, pg_temp.upload_id(101), 'Member reserves an upload');
select is((pg_temp.reserve(101)).storage_provider, 'supabase', 'Current reservations record the active provider');
select is((pg_temp.reserve(101)).id, pg_temp.upload_id(101), 'Same request returns same session');
select is((select count(*)::int from public.upload_sessions), 1, 'Idempotent reservation creates one row');
select is((public.workspace_storage_usage('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')->>'reserved_bytes')::bigint, 52428800::bigint, 'Reserve bucket maximum, not a trusted client size');
select throws_ok($$select pg_temp.reserve(101, 129)$$, '22023', 'UPLOAD_ID_CONFLICT', 'Key cannot be reused with changed metadata');
select throws_ok($$select pg_temp.complete(101)$$, 'P0001', 'UPLOAD_MISSING', 'Cannot confirm a missing object');
select throws_ok($$select private.finalize_verified_photo_upload(
  pg_temp.reserve(101), 'supabase', (pg_temp.reserve(101)).object_path, '128', 'image/png', null
)$$, '42501', null, 'Member cannot bypass storage verification by supplying metadata');
select throws_ok($$update public.upload_sessions set state = 'completed'$$, '42501', null, 'Session state cannot be forged');
select throws_ok($$update public.upload_sessions set storage_provider = 'r2' where id = pg_temp.upload_id(101)$$,
  '42501', null, 'A member cannot change the reserved provider');
select throws_ok($$insert into storage.objects(bucket_id,name) values ('gallery-originals','unreserved.png')$$, '42501', null, 'No upload without reservation');
select lives_ok($$insert into storage.objects(bucket_id,name,metadata)
select 'gallery-originals', object_path, '{"size":128,"mimetype":"image/png"}'::jsonb from public.upload_sessions where id = pg_temp.upload_id(101)$$, 'Storage accepts a reserved object');
select is(pg_temp.complete(101), pg_temp.upload_id(101), 'Matching object is confirmed');
select is(pg_temp.complete(101), pg_temp.upload_id(101), 'Repeated completion is idempotent');
select is((select count(*)::int from public.photos), 1, 'Completion creates exactly one photo');
select is((select storage_provider from public.photos where id = pg_temp.upload_id(101)),
  (select storage_provider from public.upload_sessions where id = pg_temp.upload_id(101)), 'Confirmed photo keeps the reserved provider');
select is((public.workspace_storage_usage('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')->>'used_bytes')::bigint, 128::bigint, 'Only measured photo bytes are charged after completion');
select is((public.workspace_storage_usage('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')->>'reserved_bytes')::bigint, 0::bigint, 'Completed session does not double charge quota');
select throws_ok($$select pg_temp.cancel(101)$$, 'P0001', 'UPLOAD_COMPLETED', 'Upload cancellation cannot delete a completed photo');
select is((pg_temp.reserve(108, 52428800)).byte_size, 52428800::bigint, 'Accepts an original at the 50 MiB limit');
select lives_ok($$select pg_temp.cancel(108)$$, 'Maximum-size reservation can be canceled');
select is(pg_temp.finish_cancel(108), true, 'Canceling the maximum-size reservation releases its quota');

reset role;
select throws_ok($$update public.photos set storage_provider = 'r2' where id = pg_temp.upload_id(101)$$,
  '23514', null, 'Inactive providers are rejected by the database');
update public.tenants set storage_limit_bytes = 52428800 + 128 where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
set local role authenticated;
select lives_ok($$select pg_temp.reserve(102)$$, 'Last available slot is reserved');
select throws_ok($$select pg_temp.reserve(103)$$, 'P0001', 'STORAGE_QUOTA_EXCEEDED', 'Quota includes pending reservations');
select is(pg_temp.finish_cancel(102), false, 'Cancellation requires intent');
select lives_ok($$select pg_temp.cancel(102)$$, 'Member can request cancellation');
select is(pg_temp.finish_cancel(102), true, 'Empty reservation can be released');
select is(pg_temp.finish_cancel(102), true, 'Repeated cancellation is safe');
select throws_ok($$select pg_temp.reserve(102)$$, 'P0001', 'UPLOAD_CLOSED', 'Canceled key cannot be reused');
select lives_ok($$select pg_temp.reserve(103)$$, 'Released slot can be reused with a new key');
reset role;
update public.upload_sessions set expires_at = now() - interval '1 minute' where id = pg_temp.upload_id(103);
set local role authenticated;
select throws_ok($$select pg_temp.complete(103)$$, 'P0001', 'UPLOAD_CLOSED', 'Expired reservation cannot be completed');
select throws_ok($$insert into storage.objects(bucket_id,name) select 'gallery-originals',object_path from public.upload_sessions where id = pg_temp.upload_id(103)$$, '42501', null, 'Late upload is blocked');
select lives_ok($$select pg_temp.reserve(104)$$, 'New reservation reaps expired empty slot');
select is((select state from public.upload_sessions where id = pg_temp.upload_id(103)), 'canceled', 'Expired empty session is retained as tombstone');
select lives_ok($$insert into storage.objects(bucket_id,name,metadata)
select 'gallery-originals', object_path, '{"size":129,"mimetype":"image/png"}'::jsonb from public.upload_sessions where id = pg_temp.upload_id(104)$$, 'Reserved capacity bounds even a mismatched upload');
select throws_ok($$select pg_temp.complete(104)$$, 'P0001', 'UPLOAD_MISMATCH', 'Server rejects a size mismatch');
reset role;
select throws_ok($$select private.finalize_verified_photo_upload(
  s, s.storage_provider, 'wrong/path.png', s.byte_size::text, s.content_type, null
) from public.upload_sessions s where s.id = pg_temp.upload_id(104)$$,
  'P0001', 'UPLOAD_MISMATCH', 'Finalization rejects the wrong object key');
select throws_ok($$select private.finalize_verified_photo_upload(
  s, 'r2', s.object_path, s.byte_size::text, s.content_type, null
) from public.upload_sessions s where s.id = pg_temp.upload_id(104)$$,
  'P0001', 'UPLOAD_MISMATCH', 'Finalization rejects metadata from the wrong provider');
update storage.objects set metadata = '{"size":128,"mimetype":"image/jpeg"}'::jsonb where bucket_id = 'gallery-originals' and name = (select object_path from public.upload_sessions where id = pg_temp.upload_id(104));
set local role authenticated;
select throws_ok($$select pg_temp.complete(104)$$, 'P0001', 'UPLOAD_MISMATCH', 'Server rejects a MIME mismatch');
select lives_ok($$select pg_temp.cancel(104)$$, 'Mismatched upload can be discarded');
select is(pg_temp.finish_cancel(104), false, 'Existing object prevents premature quota release');
select throws_ok($$select pg_temp.reserve(105)$$, 'P0001', 'STORAGE_QUOTA_EXCEEDED', 'Pending cleanup remains charged');

select set_config('request.jwt.claim.sub', 'ffffffff-1111-4111-8111-111111111111', true);
select is((select count(*)::int from public.upload_sessions), 0, 'Other workspace cannot read sessions');
select throws_ok($$select pg_temp.reserve(106)$$, '42501', null, 'Other user cannot reserve');
select throws_ok($$select pg_temp.complete(104)$$, '42501', null, 'Other user cannot complete');
select throws_ok($$select pg_temp.cancel(104)$$, '42501', null, 'Other user cannot cancel');
select throws_ok($$select pg_temp.finish_cancel(104)$$, '42501', null, 'Other user cannot release quota');
select throws_ok($$select public.workspace_storage_usage('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')$$, '42501', null, 'Usage is private to workspace');
select throws_ok($$select public.complete_photo_upload('ffffffff-ffff-4fff-8fff-ffffffffffff', 'ffffffff-0000-4000-8000-000000000001', pg_temp.upload_id(104))$$, 'P0001', 'UPLOAD_NOT_FOUND', 'Own workspace cannot complete another workspace session');
set local role anon;
select throws_ok($$select pg_temp.reserve(107)$$, '42501', null, 'Anonymous cannot reserve');
select throws_ok($$select pg_temp.cancel(104)$$, '42501', null, 'Anonymous cannot cancel');
select throws_ok($$select * from public.upload_sessions$$, '42501', null, 'Anonymous cannot list sessions');
reset role;
select is((select state from public.upload_sessions where id = pg_temp.upload_id(104)), 'canceling', 'Unauthorized calls leave cleanup state intact');

reset role;
update public.upload_sessions set created_at = now() - interval '91 days'
where id in (pg_temp.upload_id(101), pg_temp.upload_id(102), pg_temp.upload_id(103), pg_temp.upload_id(108), pg_temp.upload_id(104));
insert into public.upload_sessions(id, tenant_id, gallery_id, object_path, original_filename, content_type,
  byte_size, state, created_at, created_by)
values
  (pg_temp.upload_id(110), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-0000-4000-8000-000000000001',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/eeeeeeee-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000110.png',
    'cancelled-with-object.png', 'image/png', 128, 'canceled', now() - interval '91 days', 'eeeeeeee-1111-4111-8111-111111111111'),
  (pg_temp.upload_id(111), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-0000-4000-8000-000000000001',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/eeeeeeee-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000111.png',
    'old-reservation.png', 'image/png', 128, 'reserved', now() - interval '91 days', 'eeeeeeee-1111-4111-8111-111111111111'),
  (pg_temp.upload_id(112), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-0000-4000-8000-000000000001',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/eeeeeeee-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000112.png',
    'recent-tombstone.png', 'image/png', 128, 'canceled', now() - interval '10 days', 'eeeeeeee-1111-4111-8111-111111111111'),
  ('ffffffff-0000-4000-8000-000000000113', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'ffffffff-0000-4000-8000-000000000001',
    'ffffffff-ffff-4fff-8fff-ffffffffffff/ffffffff-0000-4000-8000-000000000001/ffffffff-0000-4000-8000-000000000113.png',
    'other-workspace.png', 'image/png', 128, 'canceled', now() - interval '91 days', 'ffffffff-1111-4111-8111-111111111111');
insert into storage.objects(bucket_id, name, metadata)
values ('gallery-originals',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/eeeeeeee-0000-4000-8000-000000000001/eeeeeeee-0000-4000-8000-000000000110.png',
  '{"size":128,"mimetype":"image/png"}'::jsonb);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok($$select public.prune_upload_sessions()$$, '42501', null, 'Members cannot invoke upload-session retention');
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok($$select public.prune_upload_sessions(29)$$, '22023', 'UPLOAD_RETENTION_INVALID', 'Retention cannot be shorter than 30 days');
select throws_ok($$select public.prune_upload_sessions(90, null, 0)$$, '22023', 'UPLOAD_RETENTION_BATCH_INVALID', 'Batch size is bounded');
select is(public.prune_upload_sessions(90, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 1), 1, 'Pruning is tenant-scoped and deletes only one row per batch');
select is(public.prune_upload_sessions(90, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 100), 3, 'Old completed and canceled tombstones are pruned in a later batch');
select is((select count(*)::int from public.photos where id = pg_temp.upload_id(101)), 1, 'Pruning a completed session preserves its photo');
select is((select count(*)::int from public.upload_sessions where id = pg_temp.upload_id(110)), 1, 'Canceled session with an unreferenced object is retained');
select is((select count(*)::int from public.upload_sessions where id = pg_temp.upload_id(111)), 1, 'An old reservation is retained for reconciliation');
select is((select count(*)::int from public.upload_sessions where id = pg_temp.upload_id(104)), 1, 'A canceling session is retained for reconciliation');
select is((select count(*)::int from public.upload_sessions where id = pg_temp.upload_id(112)), 1, 'Recent tombstones remain available for retries');
select is((select count(*)::int from public.upload_sessions where id = 'ffffffff-0000-4000-8000-000000000113'), 1, 'Tenant-scoped pruning preserves other workspaces');
select is(public.prune_upload_sessions(90, null, 100), 1, 'An unscoped run prunes eligible tombstones across workspaces');
select is((select count(*)::int from public.upload_sessions where id = 'ffffffff-0000-4000-8000-000000000113'), 0, 'Unscoped pruning removes the eligible other-workspace tombstone');

select * from finish();
rollback;

begin;
select no_plan();

select has_column('public', 'upload_sessions', 'r2_multipart_state', 'Multipart operation state is persisted');
select has_column('public', 'upload_sessions', 'r2_multipart_upload_id', 'Provider upload ID is persisted');
select has_column('public', 'upload_sessions', 'r2_multipart_started_at', 'Multipart start intent is timestamped');
select has_column('public', 'upload_sessions', 'r2_multipart_claimed_at', 'Completion claims are timestamped');

select ok(not has_function_privilege('authenticated', 'public.begin_r2_multipart_upload(uuid,uuid,uuid,uuid)', 'EXECUTE'),
  'Browser sessions cannot start privileged multipart operations');
select ok(not has_function_privilege('authenticated', 'public.claim_r2_multipart_completion(uuid,uuid,uuid,uuid)', 'EXECUTE'),
  'Browser sessions cannot claim multipart completion');

alter table public.upload_sessions drop constraint upload_sessions_storage_provider_check;
alter table public.photos drop constraint photos_storage_provider_check;

insert into auth.users (id, instance_id, aud, role, email) values
  ('35353535-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2-multipart-owner@quadrics.test');
insert into public.tenants (id, slug, name, created_by) values
  ('35353535-0000-4000-8000-000000000003', 'r2-multipart-tests', 'R2 multipart', '35353535-0000-4000-8000-000000000001');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000001', 'owner');
insert into public.galleries (id, tenant_id, title, slug) values
  ('35353535-0000-4000-8000-000000000004', '35353535-0000-4000-8000-000000000003', 'Multipart', 'multipart');
insert into public.upload_sessions (
  id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, storage_provider
) values
  ('35353535-0000-4000-8000-000000000005', '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004',
   '35353535-0000-4000-8000-000000000003/35353535-0000-4000-8000-000000000004/35353535-0000-4000-8000-000000000005.png',
   'complete.png', 'image/png', 128, '35353535-0000-4000-8000-000000000001', 'r2'),
  ('35353535-0000-4000-8000-000000000006', '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004',
   '35353535-0000-4000-8000-000000000003/35353535-0000-4000-8000-000000000004/35353535-0000-4000-8000-000000000006.png',
   'cancel.png', 'image/png', 128, '35353535-0000-4000-8000-000000000001', 'r2'),
  ('35353535-0000-4000-8000-000000000007', '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004',
   '35353535-0000-4000-8000-000000000003/35353535-0000-4000-8000-000000000004/35353535-0000-4000-8000-000000000007.png',
   'expire.png', 'image/png', 128, '35353535-0000-4000-8000-000000000001', 'r2'),
  ('35353535-0000-4000-8000-000000000008', '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004',
   '35353535-0000-4000-8000-000000000003/35353535-0000-4000-8000-000000000004/35353535-0000-4000-8000-000000000008.png',
   'direct.png', 'image/png', 128, '35353535-0000-4000-8000-000000000001', 'r2');

create function pg_temp.begin_multipart(p_upload_id uuid)
returns public.upload_sessions language sql as $$
  select public.begin_r2_multipart_upload('35353535-0000-4000-8000-000000000001',
    '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004', p_upload_id);
$$;
create function pg_temp.record_multipart(p_upload_id uuid, p_provider_id text)
returns public.upload_sessions language sql as $$
  select public.record_r2_multipart_upload_id('35353535-0000-4000-8000-000000000001',
    '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004', p_upload_id, p_provider_id);
$$;
create function pg_temp.claim_multipart(p_upload_id uuid)
returns public.upload_sessions language sql as $$
  select public.claim_r2_multipart_completion('35353535-0000-4000-8000-000000000001',
    '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004', p_upload_id);
$$;
create function pg_temp.begin_multipart_cancel(p_upload_id uuid)
returns public.upload_sessions language sql as $$
  select public.begin_r2_multipart_cancellation('35353535-0000-4000-8000-000000000001',
    '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004', p_upload_id);
$$;
create function pg_temp.finish_multipart_cancel(p_upload_id uuid, p_closed boolean, p_absent boolean)
returns boolean language sql as $$
  select public.finish_r2_multipart_cancellation('35353535-0000-4000-8000-000000000001',
    '35353535-0000-4000-8000-000000000003', '35353535-0000-4000-8000-000000000004',
    p_upload_id, p_closed, p_absent);
$$;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is((pg_temp.begin_multipart('35353535-0000-4000-8000-000000000005')).r2_multipart_state,
  'starting', 'Intent is persisted before the provider creates a multipart upload');
select ok((select r2_multipart_started_at is not null from public.upload_sessions
  where id = '35353535-0000-4000-8000-000000000005'), 'Intent records its start time');
select throws_ok($$select pg_temp.begin_multipart('35353535-0000-4000-8000-000000000005')$$,
  'P0001', 'R2_MULTIPART_ALREADY_STARTED', 'A second caller cannot create another provider upload');
select throws_ok($$select pg_temp.record_multipart('35353535-0000-4000-8000-000000000005', repeat('x', 1025))$$,
  '22023', 'R2_MULTIPART_ID_INVALID', 'Provider upload IDs have a bounded printable format');
select is((pg_temp.record_multipart('35353535-0000-4000-8000-000000000005', 'provider-upload-5')).r2_multipart_state,
  'started', 'The provider ID is persisted before any part can be signed');
select throws_ok($$select pg_temp.record_multipart('35353535-0000-4000-8000-000000000005', 'different-upload')$$,
  'P0001', 'R2_MULTIPART_ID_CONFLICT', 'The persisted provider ID cannot be replaced');
select throws_ok($$select public.complete_r2_photo_upload(
  '35353535-0000-4000-8000-000000000001', '35353535-0000-4000-8000-000000000003',
  '35353535-0000-4000-8000-000000000004', '35353535-0000-4000-8000-000000000005',
  '35353535-0000-4000-8000-000000000003/35353535-0000-4000-8000-000000000004/35353535-0000-4000-8000-000000000005.png',
  128, 'image/png', '"etag-5"')$$, 'P0001', 'R2_MULTIPART_NOT_CLAIMED',
  'A multipart upload cannot be finalized without an exclusive completion claim');
select is((pg_temp.claim_multipart('35353535-0000-4000-8000-000000000005')).r2_multipart_state,
  'completing', 'Completion is claimed before contacting the provider');
select ok((select r2_multipart_claimed_at is not null from public.upload_sessions
  where id = '35353535-0000-4000-8000-000000000005'), 'The completion claim is timestamped for recovery');
select throws_ok($$select pg_temp.claim_multipart('35353535-0000-4000-8000-000000000005')$$,
  'P0001', 'R2_MULTIPART_OPERATION_IN_PROGRESS', 'Concurrent completion is rejected');
select throws_ok($$select pg_temp.begin_multipart_cancel('35353535-0000-4000-8000-000000000005')$$,
  'P0001', 'R2_MULTIPART_OPERATION_IN_PROGRESS', 'Cancellation cannot race an active completion');
select is(public.complete_r2_photo_upload(
  '35353535-0000-4000-8000-000000000001', '35353535-0000-4000-8000-000000000003',
  '35353535-0000-4000-8000-000000000004', '35353535-0000-4000-8000-000000000005',
  '35353535-0000-4000-8000-000000000003/35353535-0000-4000-8000-000000000004/35353535-0000-4000-8000-000000000005.png',
  128, 'image/png', '"etag-5"'), '35353535-0000-4000-8000-000000000005'::uuid,
  'Only a claimed, verified upload becomes a photo');
select is((select r2_multipart_state from public.upload_sessions
  where id = '35353535-0000-4000-8000-000000000005'), null::text,
  'Finalization clears transient multipart state');

select is((pg_temp.begin_multipart('35353535-0000-4000-8000-000000000006')).r2_multipart_state,
  'starting', 'A second reservation can start an independent multipart transfer');
select is((pg_temp.record_multipart('35353535-0000-4000-8000-000000000006', 'provider-upload-6')).r2_multipart_state,
  'started', 'The second provider ID is persisted');
select is((pg_temp.begin_multipart_cancel('35353535-0000-4000-8000-000000000006')).r2_multipart_state,
  'canceling', 'Cancellation keeps the reservation while the provider upload is being closed');
select is(pg_temp.finish_multipart_cancel('35353535-0000-4000-8000-000000000006', false, true), false,
  'Quota is not released until the provider confirms the multipart upload is closed');
select is(pg_temp.finish_multipart_cancel('35353535-0000-4000-8000-000000000006', true, false), false,
  'Quota is not released while the completed object still exists');
select is(pg_temp.finish_multipart_cancel('35353535-0000-4000-8000-000000000006', true, true), true,
  'Cancellation releases quota only after both absence checks pass');
select is((select state from public.upload_sessions where id = '35353535-0000-4000-8000-000000000006'),
  'canceled', 'Verified cancellation closes the reservation');
select is((select r2_multipart_upload_id from public.upload_sessions where id = '35353535-0000-4000-8000-000000000006'),
  null::text, 'Verified cancellation clears the provider upload ID');

select is((pg_temp.begin_multipart('35353535-0000-4000-8000-000000000007')).r2_multipart_state,
  'starting', 'A pending initiation intent is retained for expiry recovery');
select throws_ok($$select pg_temp.begin_multipart_cancel('35353535-0000-4000-8000-000000000008')$$,
  'P0001', 'R2_MULTIPART_NOT_READY', 'Multipart cancellation cannot claim a simple PUT reservation');
update public.upload_sessions set state = 'canceled' where id = '35353535-0000-4000-8000-000000000008';
update public.upload_sessions set expires_at = clock_timestamp() - interval '1 minute'
  where id = '35353535-0000-4000-8000-000000000007';
reset role;
select private.expire_upload_reservations('35353535-0000-4000-8000-000000000003');
set local role service_role;
select is((select state from public.upload_sessions where id = '35353535-0000-4000-8000-000000000007'),
  'canceling', 'Expiry moves an unresolved initiation into cancellation without freeing quota');
select throws_ok($$delete from public.galleries where id = '35353535-0000-4000-8000-000000000004'$$,
  '55000', 'R2_UPLOAD_IN_PROGRESS', 'Gallery deletion is blocked while a multipart result is unresolved');
select throws_ok($$delete from public.tenants where id = '35353535-0000-4000-8000-000000000003'$$,
  '55000', 'R2_UPLOAD_IN_PROGRESS', 'Workspace deletion is blocked while a multipart result is unresolved');
select is(pg_temp.finish_multipart_cancel('35353535-0000-4000-8000-000000000007', true, true), true,
  'A start with no recorded ID can be released only after the server verifies no upload or object remains');
delete from public.galleries where id = '35353535-0000-4000-8000-000000000004';
delete from public.tenants where id = '35353535-0000-4000-8000-000000000003';
select ok(not exists (select 1 from public.tenants where id = '35353535-0000-4000-8000-000000000003'),
  'Gallery and workspace deletion work after all multipart operations are resolved');

select * from finish();
rollback;

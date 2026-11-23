begin;
select no_plan();
insert into auth.users (id, instance_id, aud, role, email) values
('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'processing-a@cartlio.test'),
('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'processing-b@cartlio.test');
insert into public.tenants (id, slug, name, created_by) values
('11111111-1111-4111-8111-111111111111', 'processing-a', 'Processing A', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
('22222222-2222-4222-8222-222222222222', 'processing-b', 'Processing B', '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.tenant_members (tenant_id, user_id, role) values
('11111111-1111-4111-8111-111111111111', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
('22222222-2222-4222-8222-222222222222', '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'owner');
insert into public.galleries (id, tenant_id, title, slug) values
('11111111-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Processing A', 'photos'),
('22222222-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Processing B', 'photos');
insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by) values
('11111111-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111/11111111-0000-4000-8000-000000000001/11111111-0000-4000-8000-000000000101.png', 'photo.png', 'image/png', 128, '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok($$select public.claim_photo_processing()$$, '42501', null, 'Member cannot claim processing work');
select throws_ok($$select public.finish_photo_processing('11111111-0000-4000-8000-000000000101', gen_random_uuid(), 'ready', 2, 2)$$, '42501', null, 'Member cannot mark an image ready');
select throws_ok($$update public.photos set processing_status = 'ready'$$, '42501', null, 'Member cannot forge ready state');
select throws_ok($$insert into storage.objects(bucket_id,name) values ('gallery-previews', 'unreserved.webp')$$, '42501', null, 'Member cannot upload a preview');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('test.processing_token', (public.claim_photo_processing('11111111-1111-4111-8111-111111111111')).processing_token::text, true);
select is((select processing_status from public.photos where id = '11111111-0000-4000-8000-000000000101'), 'processing', 'Claim persists processing state');
select is((select processing_attempts from public.photos where id = '11111111-0000-4000-8000-000000000101'), 1, 'Claim counts attempts');
select is((public.claim_photo_processing('11111111-1111-4111-8111-111111111111')).id, null::uuid, 'Active lease prevents a second claim');
select throws_ok($$select public.finish_photo_processing('11111111-0000-4000-8000-000000000101', current_setting('test.processing_token')::uuid, 'ready', 2, 2)$$, 'P0001', 'PROCESSING_DERIVATIVES_MISSING', 'Ready requires both derived objects');
select is(public.finish_photo_processing('11111111-0000-4000-8000-000000000101', gen_random_uuid(), 'invalid'), false, 'Wrong token cannot finish work');

reset role;
insert into storage.objects(bucket_id,name,metadata) values
('gallery-previews', '11111111-1111-4111-8111-111111111111/11111111-0000-4000-8000-000000000001/11111111-0000-4000-8000-000000000101.webp', '{"size":50,"mimetype":"image/webp"}'::jsonb),
('gallery-thumbnails', '11111111-1111-4111-8111-111111111111/11111111-0000-4000-8000-000000000001/11111111-0000-4000-8000-000000000101.webp', '{"size":30,"mimetype":"image/webp"}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select count(*)::int from storage.objects where bucket_id = 'gallery-previews'), 0, 'Derivatives remain hidden during processing');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.finish_photo_processing('11111111-0000-4000-8000-000000000101', current_setting('test.processing_token')::uuid, 'ready', 2, 2), true, 'Worker marks a rendered image ready');
select is(public.finish_photo_processing('11111111-0000-4000-8000-000000000101', current_setting('test.processing_token')::uuid, 'invalid'), false, 'Old token cannot change a ready image');
reset role;
insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by,
  processing_status, processing_attempts, processing_started_at, processing_token) values
('11111111-0000-4000-8000-000000000102', '11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001',
 '11111111-1111-4111-8111-111111111111/11111111-0000-4000-8000-000000000001/11111111-0000-4000-8000-000000000102.png',
 'stale.png', 'image/png', 128, '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'processing', 5, now() - interval '16 minutes', gen_random_uuid());
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is((public.claim_photo_processing('11111111-1111-4111-8111-111111111111')).id, null::uuid, 'No work is claimable when retries are exhausted');
select is((select processing_status from public.photos where id = '11111111-0000-4000-8000-000000000102'), 'failed', 'Expired final lease becomes a visible failure');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.retry_failed_photo_processing('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000102'), true, 'Workspace member can retry an exhausted processing task');
select is((select processing_status from public.photos where id = '11111111-0000-4000-8000-000000000102'), 'pending', 'Retry returns the photo to the worker queue');
select is((select processing_attempts from public.photos where id = '11111111-0000-4000-8000-000000000102'), 0, 'Retry resets the attempt limit');
select set_config('request.jwt.claim.sub', '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select throws_ok($$select public.retry_failed_photo_processing('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000102')$$, '42501', null, 'Another workspace member cannot retry processing');
select set_config('request.jwt.claim.sub', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.retry_failed_photo_processing('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000101'), false, 'Only failed active photos can be retried');
select is((select count(*)::int from storage.objects where bucket_id in ('gallery-previews','gallery-thumbnails')), 2, 'Workspace member may read ready derivatives');
select set_config('request.jwt.claim.sub', '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is((select count(*)::int from storage.objects where bucket_id in ('gallery-previews','gallery-thumbnails')), 0, 'Other workspace cannot read derivatives');
select set_config('request.jwt.claim.sub', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.finish_photo_deletion('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000101'), false, 'Deletion requires recorded intent');
select is(public.begin_photo_deletion('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000101') is not null, true, 'Member records deletion intent');
select is((select count(*)::int from storage.objects where bucket_id in ('gallery-previews','gallery-thumbnails')), 2, 'Member can still locate derivatives for cleanup');
select is(public.finish_photo_deletion('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000101'), false, 'Derivatives prevent premature metadata deletion');
select throws_ok($$select public.finish_photo_deletion_worker('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000101')$$, '42501', null, 'Members cannot run the privileged deletion worker');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.finish_photo_deletion_worker('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000101'), false, 'Worker refuses to drop metadata while an object remains');
reset role;
insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, deletion_requested_at) values
('11111111-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001',
 '11111111-1111-4111-8111-111111111111/11111111-0000-4000-8000-000000000001/11111111-0000-4000-8000-000000000103.png', 'removed.png', 'image/png', 128, '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now());
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.finish_photo_deletion_worker('11111111-1111-4111-8111-111111111111', '11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000103'), true, 'Worker completes deletion when no objects remain');
select is((select count(*)::int from public.photos where id = '11111111-0000-4000-8000-000000000103'), 0, 'Worker removes the photo metadata');
select * from finish();
rollback;

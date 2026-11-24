begin;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email) values
('77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rotate-owner@cartlio.test'),
('88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rotate-outsider@cartlio.test');
insert into public.tenants (id, slug, name, created_by) values
('77777777-7777-4777-8777-777777777777', 'rotate-owner', 'Rotate owner', '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
('88888888-8888-4888-8888-888888888888', 'rotate-outsider', 'Rotate outsider', '88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.tenant_members (tenant_id, user_id, role) values
('77777777-7777-4777-8777-777777777777', '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
('88888888-8888-4888-8888-888888888888', '88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'owner');
insert into public.galleries (id, tenant_id, title, slug, status) values
('77777777-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', 'Rotation gallery', 'rotation', 'published');
insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status) values
('77777777-0000-4000-8000-000000000101', '77777777-7777-4777-8777-777777777777', '77777777-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777/77777777-0000-4000-8000-000000000001/77777777-0000-4000-8000-000000000101.png', 'rotation-photo.png', 'image/png', 128, '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ready');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('test.old_token', public.create_gallery_share(
  '77777777-7777-4777-8777-777777777777', '77777777-0000-4000-8000-000000000001', now() + interval '7 days', 10, 'selection', '12345678'), true);
reset role;
select set_config('test.share_id', (select id::text from public.gallery_shares
  where token_hash = extensions.digest(current_setting('test.old_token'), 'sha256')), true);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('test.old_access', public.create_gallery_pin_session(
  current_setting('test.old_token'), '12345678', repeat('a', 64)), true);
reset role;

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.set_gallery_selection(current_setting('test.old_token'),
  '77777777-0000-4000-8000-000000000101', true, current_setting('test.old_access')), 1,
  'Client with a PIN session may select a photo before rotation');
select is(public.submit_gallery_selection(current_setting('test.old_token'), 'Cliente da galeria', current_setting('test.old_access')), true,
  'Client may submit a selection before rotation');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.request_gallery_selection_revision('77777777-7777-4777-8777-777777777777',
  '77777777-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, 'Escolha a foto da recepção.'), true,
  'Owner may request changes before rotating the access token');
select throws_ok($$select public.rotate_gallery_share('77777777-7777-4777-8777-777777777777',
  '77777777-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, now() + interval '10 minutes')$$,
  '22023', 'SHARE_EXPIRY_INVALID', 'Rotation requires a valid new expiration');
select set_config('request.jwt.claim.sub', '88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select throws_ok($$select public.rotate_gallery_share('77777777-7777-4777-8777-777777777777',
  '77777777-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, now() + interval '14 days')$$,
  '42501', 'SHARE_ROTATION_DENIED', 'Another workspace cannot rotate the link');
select set_config('request.jwt.claim.sub', '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('test.new_token', public.rotate_gallery_share('77777777-7777-4777-8777-777777777777',
  '77777777-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, now() + interval '14 days'), true);
select ok(current_setting('test.new_token') ~ '^[0-9a-f]{64}$' and current_setting('test.new_token') <> current_setting('test.old_token'),
  'Rotation returns a new 256-bit bearer token');
select is((select count(*)::integer from public.gallery_shares where id = current_setting('test.share_id')::uuid), 1,
  'Rotation preserves the share record');
select is((select last_rotated_at is not null and expires_at > now() + interval '13 days' and pin_enabled
  from public.gallery_shares where id = current_setting('test.share_id')::uuid), true,
  'Rotation updates expiry, records its timestamp, and preserves PIN protection');
select is((select submitted_at is null and revision_requested_at is not null and revision_message = 'Escolha a foto da recepção.'
  from public.gallery_shares where id = current_setting('test.share_id')::uuid), true,
  'Rotation preserves the open revision request');
select is((select count(*)::integer from public.gallery_selection_revisions where share_id = current_setting('test.share_id')::uuid), 1,
  'Rotation preserves the selection history');
select is((select count(*)::integer from public.gallery_selection_items where share_id = current_setting('test.share_id')::uuid), 1,
  'Rotation preserves the client selection');
reset role;

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_shared_gallery(current_setting('test.old_token'), current_setting('test.old_access')), null::jsonb,
  'Old token becomes unusable immediately after rotation');
select is((public.get_shared_gallery(current_setting('test.new_token'), current_setting('test.old_access'))->>'pin_required')::boolean, true,
  'Existing PIN sessions cannot be carried into the rotated link');
select throws_ok($$select public.authorize_shared_photo_image(current_setting('test.new_token'), '77777777-0000-4000-8000-000000000101', current_setting('test.old_access'), repeat('a', 64))$$,
  '42501', null, 'Visitors cannot call image authorization directly');
reset role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.authorize_shared_photo_image(current_setting('test.new_token'), '77777777-0000-4000-8000-000000000101', current_setting('test.old_access'), repeat('a', 64)), null::jsonb,
  'Old PIN session cannot resolve images using the new token');
select set_config('test.new_access', public.create_gallery_pin_session(
  current_setting('test.new_token'), '12345678', repeat('a', 64)), true);
reset role;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_shared_gallery(current_setting('test.new_token'), current_setting('test.new_access'))->>'revision_message',
  'Escolha a foto da recepção.', 'New token keeps the existing PIN and revision flow');
select is((public.get_shared_gallery(current_setting('test.new_token'), current_setting('test.new_access'))->>'selected_count')::integer, 1,
  'New token retains the existing customer selection');

reset role;
update public.photos set processing_status = 'failed'
  where id = '77777777-0000-4000-8000-000000000101';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select throws_ok($$select public.rotate_gallery_share('77777777-7777-4777-8777-777777777777',
  '77777777-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, now() + interval '7 days')$$,
  '22023', 'SHARE_NO_READY_PHOTOS', 'Links without ready photos cannot be rotated');
reset role;
update public.photos set processing_status = 'ready'
  where id = '77777777-0000-4000-8000-000000000101';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.revoke_gallery_share('77777777-7777-4777-8777-777777777777',
  '77777777-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid), true,
  'Owner may revoke a rotated link');
select throws_ok($$select public.rotate_gallery_share('77777777-7777-4777-8777-777777777777',
  '77777777-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, now() + interval '7 days')$$,
  '42501', 'SHARE_ROTATION_DENIED', 'Revoked links cannot be revived by rotation');

select * from finish();
rollback;

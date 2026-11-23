begin;
select no_plan();

-- Pruning is global. Isolate this transaction from rate-limit records left by local use.
delete from private.gallery_share_image_rate_limits;
delete from private.gallery_share_selection_rate_limits;

insert into auth.users (id, instance_id, aud, role, email) values
('55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pin-owner@cartlio.test');
insert into public.tenants (id, slug, name, created_by) values
('55555555-5555-4555-8555-555555555555', 'pin-workspace', 'PIN Studio', '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
insert into public.tenant_members (tenant_id, user_id, role) values
('55555555-5555-4555-8555-555555555555', '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner');
insert into public.galleries (id, tenant_id, title, slug, status) values
('55555555-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', 'Protected gallery', 'protected-gallery', 'published');
insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status) values
('55555555-0000-4000-8000-000000000101', '55555555-5555-4555-8555-555555555555', '55555555-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555/55555555-0000-4000-8000-000000000001/55555555-0000-4000-8000-000000000101.png', 'pin-photo.png', 'image/png', 128, '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ready');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('test.pin_selection_token', public.create_gallery_share(
  '55555555-5555-4555-8555-555555555555', '55555555-0000-4000-8000-000000000001', now() + interval '7 days', 10, 'selection', '12345678'), true);
select public.set_tenant_brand_logo('55555555-5555-4555-8555-555555555555',
  '55555555-5555-4555-8555-555555555555/88888888-8888-4888-8888-888888888888.webp');
reset role;
select set_config('test.pin_selection_share', (select id::text from public.gallery_shares
  where token_hash = extensions.digest(current_setting('test.pin_selection_token'), 'sha256')), true);
select is((select pin_enabled from public.gallery_shares where id = current_setting('test.pin_selection_share')::uuid), true, 'Share metadata indicates PIN protection');
select isnt((select pin_hash from public.gallery_shares where id = current_setting('test.pin_selection_share')::uuid), '12345678', 'PIN is stored as a slow hash');
set local role authenticated;
select throws_ok($$select pin_hash from public.gallery_shares$$, '42501', null, 'Members cannot read PIN hashes');

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select * from private.gallery_share_pin_attempts$$, '42501', null, 'Anonymous clients cannot inspect rate-limit records');
select throws_ok($$select * from private.gallery_share_image_rate_limits$$, '42501', null, 'Anonymous clients cannot inspect image-rate records');
select throws_ok($$select * from private.gallery_share_selection_rate_limits$$, '42501', null, 'Anonymous clients cannot inspect selection rate-limit records');
select throws_ok($$select public.prune_gallery_share_image_rate_limits(100)$$, '42501', null, 'Anonymous clients cannot purge image-rate records');
select is((public.get_shared_gallery(current_setting('test.pin_selection_token'))->>'pin_required')::boolean, true, 'Gallery details remain hidden before unlock');
select is(public.get_shared_brand_logo_status(current_setting('test.pin_selection_token')), false, 'Logo remains unavailable before PIN unlock');
select is((public.get_shared_gallery_photo_page(current_setting('test.pin_selection_token'), null, 0, 60, null, false)->>'pin_required')::boolean, true, 'Photo pages remain hidden before PIN authorization');
select throws_ok($$select public.authorize_shared_photo_image(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', null, repeat('a', 64))$$,
  '42501', null, 'Anonymous clients cannot resolve image paths directly');
select throws_ok($$select public.authorize_shared_brand_logo(current_setting('test.pin_selection_token'), null, repeat('a', 64))$$,
  '42501', null, 'Anonymous clients cannot resolve logo paths directly');
select is(public.set_gallery_selection(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', true), -1, 'Selection writes require an unlock session');
select is(public.clear_gallery_selection(current_setting('test.pin_selection_token')), -1, 'Clearing choices requires an unlock session');
select throws_ok($$select public.set_gallery_selection_photo_note(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', 'note without session')$$,
  '42501', 'PHOTO_NOTE_DENIED', 'Photo notes require an unlock session');
select is(public.submit_gallery_selection(current_setting('test.pin_selection_token'), 'Cliente'), false, 'Selection submission requires an unlock session');
select throws_ok($$select public.create_gallery_pin_session(current_setting('test.pin_selection_token'), '12345678', repeat('a', 64))$$,
  '42501', null, 'Anonymous clients cannot call the PIN verifier directly');
reset role;
select ok(not exists (select 1 from private.gallery_share_selection_rate_limits where share_id = current_setting('test.pin_selection_share')::uuid), 'Denied PIN writes do not consume the selection allowance');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.create_gallery_pin_session(current_setting('test.pin_selection_token'), '87654321', repeat('a', 64)), null::text, 'Incorrect PIN is denied');
select set_config('test.pin_selection_access', public.create_gallery_pin_session(current_setting('test.pin_selection_token'), '12345678', repeat('a', 64)), true);
select is(char_length(current_setting('test.pin_selection_access')), 64, 'Correct PIN creates a high-entropy temporary session');
reset role;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_shared_gallery(current_setting('test.pin_selection_token'), current_setting('test.pin_selection_access'))->>'title', 'Protected gallery', 'Valid session opens the gallery');
select is(public.get_shared_brand_logo_status(current_setting('test.pin_selection_token'), current_setting('test.pin_selection_access')), true, 'Valid PIN session can see the brand logo');
select is((public.get_shared_gallery_photo_page(current_setting('test.pin_selection_token'), current_setting('test.pin_selection_access'), 0, 60, null, false)->'photos'->0->>'name'), 'pin-photo.png', 'Valid PIN session can request its authorized photo page');
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.authorize_shared_photo_image(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', current_setting('test.pin_selection_access'), repeat('a', 64))->>'path', '55555555-5555-4555-8555-555555555555/55555555-0000-4000-8000-000000000001/55555555-0000-4000-8000-000000000101.webp', 'Valid session resolves only its gallery image');
select is(public.authorize_shared_brand_logo(current_setting('test.pin_selection_token'), current_setting('test.pin_selection_access'), repeat('d', 64))->>'path',
  '55555555-5555-4555-8555-555555555555/88888888-8888-4888-8888-888888888888.webp', 'Valid PIN session resolves only its workspace logo');
reset role;
update private.gallery_share_image_rate_limits set request_count = 1800
  where share_id = (select id from public.gallery_shares where token_hash = extensions.digest(current_setting('test.pin_selection_token'), 'sha256'))
    and client_fingerprint = decode(repeat('a', 64), 'hex');
set local role service_role;
select is((public.authorize_shared_photo_image(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', current_setting('test.pin_selection_access'), repeat('a', 64))->>'rate_limited')::boolean, true, 'Image requests are limited after 1800 per minute for one link and client');
select ok(((public.authorize_shared_photo_image(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', current_setting('test.pin_selection_access'), repeat('a', 64))->>'retry_after')::integer between 1 and 60), 'Rate-limit response includes a bounded retry delay');
select is((public.authorize_shared_photo_image(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', current_setting('test.pin_selection_access'), repeat('c', 64))->>'rate_limited')::boolean, false, 'A separate client keeps its own image allowance');
reset role;
update private.gallery_share_image_rate_limits set window_started_at = clock_timestamp() - interval '61 seconds', request_count = 1801
  where share_id = (select id from public.gallery_shares where token_hash = extensions.digest(current_setting('test.pin_selection_token'), 'sha256'))
    and client_fingerprint = decode(repeat('a', 64), 'hex');
set local role service_role;
select is((public.authorize_shared_photo_image(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', current_setting('test.pin_selection_access'), repeat('a', 64))->>'rate_limited')::boolean, false, 'Image allowance resets after its minute window');
reset role;
select is((select request_count from private.gallery_share_image_rate_limits
  where share_id = (select id from public.gallery_shares where token_hash = extensions.digest(current_setting('test.pin_selection_token'), 'sha256'))
    and client_fingerprint = decode(repeat('a', 64), 'hex')), 1, 'Reset begins a new request window at one');
update private.gallery_share_image_rate_limits set updated_at = clock_timestamp() - interval '25 hours'
  where client_fingerprint = decode(repeat('a', 64), 'hex');
insert into private.gallery_share_selection_rate_limits(share_id, window_started_at, request_count, updated_at)
values (current_setting('test.pin_selection_share')::uuid, clock_timestamp() - interval '25 hours', 1, clock_timestamp() - interval '25 hours');
set local role service_role;
select throws_ok($$select public.prune_gallery_share_image_rate_limits(0)$$, '22023', 'SHARE_IMAGE_RATE_LIMIT_BATCH_INVALID', 'Rate-limit cleanup validates its batch size');
select is(public.prune_gallery_share_image_rate_limits(1000), 2, 'Cleanup removes idle image and selection rate-limit state');
select is(public.prune_gallery_share_image_rate_limits(1000), 0, 'Image-rate cleanup is idempotent');
reset role;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.set_gallery_selection(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', true, current_setting('test.pin_selection_access')), 1, 'Valid session can save a selection');
select is(public.set_gallery_selection_photo_note(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', 'Protected note', current_setting('test.pin_selection_access')), 'Protected note', 'Valid PIN session can save a photo note');
select is(public.clear_gallery_selection(current_setting('test.pin_selection_token'), current_setting('test.pin_selection_access')), 1, 'Valid PIN session can clear its selection');
select is((public.get_shared_gallery(current_setting('test.pin_selection_token'), current_setting('test.pin_selection_access'))->>'selected_count')::integer, 0, 'Clearing with PIN resets the selection count');
select is(public.set_gallery_selection(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', true, current_setting('test.pin_selection_access')), 1, 'Valid PIN session can start a fresh selection');
select is(public.set_gallery_selection_photo_note(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', 'Protected note', current_setting('test.pin_selection_access')), 'Protected note', 'Valid PIN session can add a note to its fresh selection');
select is((select item->>'client_note' from jsonb_array_elements(public.get_shared_gallery(current_setting('test.pin_selection_token'), current_setting('test.pin_selection_access'))->'photos') as items(item)
  where item->>'id' = '55555555-0000-4000-8000-000000000101'), 'Protected note', 'PIN-protected gallery reveals the note after unlock');
reset role;
update private.gallery_share_selection_rate_limits set window_started_at = clock_timestamp(), request_count = 300, updated_at = clock_timestamp()
  where share_id = current_setting('test.pin_selection_share')::uuid;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select public.set_gallery_selection_photo_note(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', 'Blocked note', current_setting('test.pin_selection_access'))$$,
  'PT429', 'SELECTION_RATE_LIMITED', 'PIN-protected selection writes share the per-link rate limit');
reset role;
update private.gallery_share_selection_rate_limits set window_started_at = clock_timestamp() - interval '61 seconds', request_count = 300
  where share_id = current_setting('test.pin_selection_share')::uuid;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.set_gallery_selection_photo_note(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', 'Protected note', current_setting('test.pin_selection_access')), 'Protected note', 'PIN-protected writes resume when the limit window expires');
select is(public.submit_gallery_selection(current_setting('test.pin_selection_token'), 'Cliente PIN', current_setting('test.pin_selection_access')), true, 'Valid session can submit the selection');
select throws_ok($$select public.set_gallery_selection_photo_note(current_setting('test.pin_selection_token'), '55555555-0000-4000-8000-000000000101', 'late note', current_setting('test.pin_selection_access'))$$,
  '42501', 'SELECTION_SUBMITTED', 'PIN session cannot edit a submitted note');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('test.pin_delivery_token', public.create_gallery_share(
  '55555555-5555-4555-8555-555555555555', '55555555-0000-4000-8000-000000000001', now() + interval '7 days', null, 'delivery', '12345678'), true);

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is((public.get_shared_gallery(current_setting('test.pin_delivery_token'), current_setting('test.pin_selection_access'))->>'pin_required')::boolean, true, 'PIN session cannot be reused across links');
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('test.pin_delivery_access', public.create_gallery_pin_session(current_setting('test.pin_delivery_token'), '12345678', repeat('a', 64)), true);
reset role;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select public.set_gallery_selection_photo_note(current_setting('test.pin_delivery_token'), '55555555-0000-4000-8000-000000000101', 'delivery note', current_setting('test.pin_delivery_access'))$$,
  '42501', 'SELECTION_MODE_DISABLED', 'Delivery links do not accept client selection notes');
select throws_ok($$select public.clear_gallery_selection(current_setting('test.pin_delivery_token'), current_setting('test.pin_delivery_access'))$$,
  '42501', 'SELECTION_MODE_DISABLED', 'Delivery links do not accept selection clearing');
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.authorize_gallery_download(current_setting('test.pin_delivery_token'), '55555555-0000-4000-8000-000000000101', null), null::jsonb, 'Download authorization requires the link session');
select is(public.authorize_gallery_download_bundle(current_setting('test.pin_delivery_token'), null), null::jsonb, 'Bundle authorization requires the link session');
select is(public.authorize_gallery_download_bundle(current_setting('test.pin_delivery_token'), current_setting('test.pin_delivery_access'))->>'count', '1', 'Valid session can authorize an original bundle');
select is(public.authorize_gallery_download(current_setting('test.pin_delivery_token'), '55555555-0000-4000-8000-000000000101', current_setting('test.pin_delivery_access'))->>'filename', 'pin-photo.png', 'Valid session can authorize an original download');

reset role;
select set_config('test.locked_pin_token', public.create_gallery_share(
  '55555555-5555-4555-8555-555555555555', '55555555-0000-4000-8000-000000000001', now() + interval '7 days', 10, 'selection', '12345678'), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.create_gallery_pin_session(current_setting('test.locked_pin_token'), '00000000', repeat('b', 64)), null::text, 'First incorrect PIN from this client is denied');
select is(public.create_gallery_pin_session(current_setting('test.locked_pin_token'), '00000000', repeat('b', 64)), null::text, 'Second incorrect PIN from this client is denied');
select is(public.create_gallery_pin_session(current_setting('test.locked_pin_token'), '00000000', repeat('b', 64)), null::text, 'Third incorrect PIN from this client is denied');
select is(public.create_gallery_pin_session(current_setting('test.locked_pin_token'), '00000000', repeat('b', 64)), null::text, 'Fourth incorrect PIN from this client is denied');
select is(public.create_gallery_pin_session(current_setting('test.locked_pin_token'), '00000000', repeat('b', 64)), null::text, 'Fifth incorrect PIN from this client is denied');
select is(public.create_gallery_pin_session(current_setting('test.locked_pin_token'), '12345678', repeat('b', 64)), 'PIN_RATE_LIMITED', 'Further attempts from this client are rate limited');
select ok(public.create_gallery_pin_session(current_setting('test.locked_pin_token'), '12345678', repeat('c', 64)) ~ '^[0-9a-f]{64}$', 'Another client can still unlock the shared gallery');
reset role;
select ok((select locked_until > clock_timestamp() from private.gallery_share_pin_attempts
  where share_id = (select id from public.gallery_shares
    where token_hash = extensions.digest(current_setting('test.locked_pin_token'), 'sha256'))
    and client_fingerprint = decode(repeat('b', 64), 'hex')), 'Five failures lock only the requesting client for one hour');

select * from finish();
rollback;

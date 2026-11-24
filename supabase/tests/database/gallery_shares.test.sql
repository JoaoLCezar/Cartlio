begin;
select no_plan();
insert into auth.users (id, instance_id, aud, role, email) values
('33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'shares-a@cartlio.test'),
('44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'shares-b@cartlio.test');
insert into public.tenants (id, slug, name, created_by) values
('33333333-3333-4333-8333-333333333333', 'shares-a', 'Shares A', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
('44444444-4444-4444-8444-444444444444', 'shares-b', 'Shares B', '44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.tenant_members (tenant_id, user_id, role) values
('33333333-3333-4333-8333-333333333333', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
('44444444-4444-4444-8444-444444444444', '44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'owner');
insert into public.galleries (id, tenant_id, title, slug, status) values
('33333333-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'Shared gallery', 'shared', 'published'),
('33333333-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333', 'Other gallery', 'other', 'published'),
('33333333-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333', 'Unprocessed gallery', 'unprocessed', 'published');
insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status) values
('33333333-0000-4000-8000-000000000101', '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333/33333333-0000-4000-8000-000000000001/33333333-0000-4000-8000-000000000101.png', 'ready.png', 'image/png', 128, '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ready'),
('33333333-0000-4000-8000-000000000102', '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333/33333333-0000-4000-8000-000000000001/33333333-0000-4000-8000-000000000102.png', 'pending.png', 'image/png', 128, '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pending'),
('33333333-0000-4000-8000-000000000103', '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333/33333333-0000-4000-8000-000000000002/33333333-0000-4000-8000-000000000103.png', 'other.png', 'image/png', 128, '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ready'),
('33333333-0000-4000-8000-000000000104', '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333/33333333-0000-4000-8000-000000000001/33333333-0000-4000-8000-000000000104.png', 'extra.png', 'image/png', 128, '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ready'),
('33333333-0000-4000-8000-000000000105', '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333/33333333-0000-4000-8000-000000000003/33333333-0000-4000-8000-000000000105.png', 'unprocessed.png', 'image/png', 128, '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pending');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select throws_ok($$select public.create_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', now() + interval '10 minutes')$$, '22023', 'SHARE_EXPIRY_INVALID', 'Links need at least one hour');
select throws_ok($$select public.create_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', now() + interval '31 days')$$, '22023', 'SHARE_EXPIRY_INVALID', 'Links cannot exceed 30 days');
select throws_ok($$select public.create_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000003', now() + interval '7 days')$$, '22023', 'SHARE_NO_READY_PHOTOS', 'A gallery with pending-only photos cannot be shared');
select set_config('test.share_token', public.create_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', now() + interval '7 days', 1), true);
select is(public.set_gallery_cover_photo('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000104'), true, 'Owner can choose a ready photo as the gallery cover');
select throws_ok($$select public.set_gallery_cover_photo('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000102')$$, '22023', 'GALLERY_COVER_PHOTO_INVALID', 'Pending photos cannot become the cover');
select throws_ok($$select public.set_gallery_cover_photo('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', '33333333-0000-4000-8000-000000000103')$$, '22023', 'GALLERY_COVER_PHOTO_INVALID', 'A photo from another gallery cannot become the cover');
reset role;
select set_config('test.share_id', (select id::text from public.gallery_shares where token_hash = extensions.digest(current_setting('test.share_token'), 'sha256')), true);
set local role authenticated;
select is(char_length(current_setting('test.share_token')), 64, 'Token has 256 bits represented as hex');
select throws_ok($$select token_hash from public.gallery_shares$$, '42501', null, 'Members cannot read token hashes');
select is((select count(*)::int from public.gallery_shares), 1, 'Member may list link metadata');
select set_config('request.jwt.claim.sub', '44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is((select count(*)::int from public.gallery_shares), 0, 'Other workspace cannot list links');
select throws_ok($$select public.create_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', now() + interval '7 days')$$, '42501', null, 'Other workspace cannot create links');
select throws_ok($$select public.revoke_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid)$$, '42501', null, 'Other workspace cannot revoke links');

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is((public.get_shared_gallery(current_setting('test.share_token'))->>'title'), 'Shared gallery', 'Anonymous bearer may read only gallery presentation');
select is(public.get_shared_gallery(current_setting('test.share_token'))->>'brand_name', 'Quadrics', 'Private workspace name is not exposed by default');
select is(public.get_shared_gallery(current_setting('test.share_token'))->>'cover_photo_id', '33333333-0000-4000-8000-000000000104', 'Public gallery uses the photographer-selected cover');
select is(jsonb_array_length(public.get_shared_gallery(current_setting('test.share_token'))->'photos'), 2, 'Only ready photos appear');
select is((public.get_shared_gallery(current_setting('test.share_token'))->>'photo_count')::integer, 2, 'Gallery summary reports the total number of ready photos');
select is(jsonb_array_length(public.get_shared_gallery_photo_page(current_setting('test.share_token'), null, 0, 60, null, false)->'photos'), 2, 'Photo page returns the ready photos in the requested range');
select is((public.get_shared_gallery_photo_page(current_setting('test.share_token'), null, 0, 60, 'RÉADY', false)->'photos'->0->>'name'), 'ready.png', 'Server search ignores filename accents');
select is(public.get_shared_gallery_photo_page('deadbeef', null, 0, 60, null, false), null::jsonb, 'Photo pages reject malformed or unknown share tokens');
select is(jsonb_array_length(public.get_shared_gallery_photo_page(current_setting('test.share_token'), null, 0, 60, 'ready%', false)->'photos'), 0, 'Photo search treats percent as a literal character');
select is(jsonb_array_length(public.get_shared_gallery_photo_page(current_setting('test.share_token'), null, 0, 60, 'ready_.png', false)->'photos'), 0, 'Photo search treats underscore as a literal character');
select throws_ok($$select public.get_shared_gallery_photo_page(current_setting('test.share_token'), null, -1, 60, null, false)$$, '22023', 'PHOTO_PAGE_INVALID', 'Photo page rejects a negative offset');
select throws_ok($$select public.get_shared_gallery_photo_page(current_setting('test.share_token'), null, 0, 61, null, false)$$, '22023', 'PHOTO_PAGE_INVALID', 'Photo page caps each batch at 60 photos');
select is((public.get_shared_gallery(current_setting('test.share_token'))->>'selection_limit')::integer, 1, 'Public link exposes its selection limit');
select is(public.get_shared_gallery(current_setting('test.share_token'))->>'share_mode', 'selection', 'Legacy links remain in selection mode');
select throws_ok($$select public.authorize_shared_photo_image(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', null, repeat('a', 64))$$,
  '42501', null, 'Anonymous clients cannot resolve image paths outside the server route');
select is(public.get_shared_gallery('deadbeef'), null::jsonb, 'Malformed token reveals nothing');
select throws_ok($$select * from public.gallery_shares$$, '42501', null, 'Anonymous cannot inspect links');
select throws_ok($$insert into public.gallery_selection_items(share_id,photo_id,original_filename) values (gen_random_uuid(),gen_random_uuid(),'forged.png')$$, '42501', null, 'Anonymous cannot write selection rows directly');
select throws_ok($$select * from public.gallery_selection_revisions$$, '42501', null, 'Anonymous cannot inspect selection revision history');
select throws_ok($$insert into public.gallery_selection_revisions(share_id, revision_number, submitted_at, submitted_name, revision_message)
  values (gen_random_uuid(), 1, now(), 'Cliente', 'Revisar')$$, '42501', null, 'Anonymous cannot forge selection revision history');
select is(public.submit_gallery_selection(current_setting('test.share_token'), 'Client'), false, 'Empty selection cannot be submitted');
select throws_ok($$select public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000102', true)$$, '42501', 'PHOTO_NOT_SELECTABLE', 'Pending photo cannot be selected');
select throws_ok($$select public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000103', true)$$, '42501', 'PHOTO_NOT_SELECTABLE', 'Other gallery photo cannot be selected');
select is(public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', true), 1, 'Ready photo can be selected');
select is(public.set_gallery_selection_photo_note(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', '  Remove the reflection.  '), 'Remove the reflection.', 'Client can save a trimmed note on a selected photo');
select is((select item->>'client_note' from jsonb_array_elements(public.get_shared_gallery(current_setting('test.share_token'))->'photos') as items(item)
  where item->>'id' = '33333333-0000-4000-8000-000000000101'), 'Remove the reflection.', 'Authorized link can read its photo note');
select is((select item->>'client_note' from jsonb_array_elements(public.get_shared_gallery_photo_page(current_setting('test.share_token'), null, 0, 60, null, true)->'photos') as items(item)
  where item->>'id' = '33333333-0000-4000-8000-000000000101'), 'Remove the reflection.', 'Selected photo pages include the client note');
select is(public.set_gallery_selection_photo_note(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', '   '), null::text, 'An empty note removes the existing note');
select throws_ok($$select public.set_gallery_selection_photo_note(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', repeat('x', 501))$$, '22023', 'PHOTO_NOTE_INVALID', 'Photo notes are limited to 500 characters');
select throws_ok($$select public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000104', true)$$, '22023', 'SELECTION_LIMIT', 'Selection cannot exceed the link limit');
select is(public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', true), 1, 'Repeated selection is idempotent');
select is((public.get_shared_gallery(current_setting('test.share_token'))->>'selected_count')::integer, 1, 'Visitor sees persisted count');
select is(public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', false), 0, 'Visitor may remove a draft choice');
select is((select item->>'client_note' from jsonb_array_elements(public.get_shared_gallery(current_setting('test.share_token'))->'photos') as items(item)
  where item->>'id' = '33333333-0000-4000-8000-000000000101'), null::text, 'Removing a photo also removes its note');
select is(public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', true), 1, 'Visitor may choose again');
select is(public.set_gallery_selection_photo_note(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', 'Remove the reflection.'), 'Remove the reflection.', 'Client may add a note again before submission');
select is(public.clear_gallery_selection(current_setting('test.share_token')), 1, 'Client may clear all draft choices at once');
select is((public.get_shared_gallery(current_setting('test.share_token'))->>'selected_count')::integer, 0, 'Clearing choices resets the selected count');
select is((select item->>'client_note' from jsonb_array_elements(public.get_shared_gallery(current_setting('test.share_token'))->'photos') as items(item)
  where item->>'id' = '33333333-0000-4000-8000-000000000101'), null::text, 'Clearing choices also removes their notes');
select is(public.clear_gallery_selection(current_setting('test.share_token')), 0, 'Clearing an empty draft is idempotent');
select is(public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', true), 1, 'Client can start a fresh selection after clearing');
select is(public.set_gallery_selection_photo_note(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', 'Remove the reflection.'), 'Remove the reflection.', 'Client can add a note to the fresh selection');
reset role;
insert into private.gallery_share_selection_rate_limits(share_id, window_started_at, request_count, updated_at)
values (current_setting('test.share_id')::uuid, clock_timestamp(), 300, clock_timestamp())
on conflict (share_id) do update set window_started_at = excluded.window_started_at, request_count = excluded.request_count, updated_at = excluded.updated_at;
select ok(private.consume_gallery_selection_write_limit(current_setting('test.share_id')::uuid) between 1 and 60, 'Rate limiter reports a bounded wait after 300 writes');
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select public.clear_gallery_selection(current_setting('test.share_token'))$$, 'PT429', 'SELECTION_RATE_LIMITED', 'Database blocks writes above the per-link limit');
reset role;
update private.gallery_share_selection_rate_limits set window_started_at = clock_timestamp() - interval '61 seconds', request_count = 300
  where share_id = current_setting('test.share_id')::uuid;
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.clear_gallery_selection(current_setting('test.share_token')), 1, 'Write allowance resets after its one-minute window');
select is(public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', true), 1, 'Client can start a fresh selection after rate-limit recovery');
select is(public.set_gallery_selection_photo_note(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', 'Remove the reflection.'), 'Remove the reflection.', 'Client can restore a note after rate-limit recovery');
select is(jsonb_array_length(public.get_shared_gallery_photo_page(current_setting('test.share_token'), null, 0, 60, null, true)->'photos'), 1, 'Selected-only photo pages include the visitor choices');
select is((public.get_shared_gallery(current_setting('test.share_token'))->'selected_photo_ids'->>0), '33333333-0000-4000-8000-000000000101', 'Gallery summary returns the selected photo ids for filter counts');
select throws_ok($$select public.submit_gallery_selection(current_setting('test.share_token'), ' ')$$, '22023', 'CLIENT_NAME_INVALID', 'Submission needs a name');
select is(public.submit_gallery_selection(current_setting('test.share_token'), 'Cliente A'), true, 'Visitor confirms and submits selection');
select is(public.submit_gallery_selection(current_setting('test.share_token'), 'Cliente A'), true, 'Submission can be retried safely');
select throws_ok($$select public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', false)$$, '42501', 'SELECTION_SUBMITTED', 'Submitted selection is immutable');
select throws_ok($$select public.set_gallery_selection_photo_note(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', 'late edit')$$, '42501', 'SELECTION_SUBMITTED', 'Submitted photo notes are immutable');
select throws_ok($$select public.clear_gallery_selection(current_setting('test.share_token'))$$, '42501', 'SELECTION_SUBMITTED', 'Submitted selection cannot be cleared');
select is((public.get_shared_gallery(current_setting('test.share_token'))->>'submitted_at') is not null, true, 'Visitor sees submission confirmation');
reset role;
select is((select original_filename from public.gallery_selection_items where share_id = (select id from public.gallery_shares where token_hash = extensions.digest(current_setting('test.share_token'), 'sha256'))), 'ready.png', 'Selection keeps filename snapshot');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is((select count(*)::integer from public.gallery_selection_items), 1, 'Workspace owner sees submitted selection');
select set_config('request.jwt.claim.sub', '44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select is((select count(*)::integer from public.gallery_selection_items), 0, 'Other workspace cannot see selection');
select throws_ok($$select public.set_gallery_share_downloads('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, true)$$, '42501', 'DOWNLOAD_PERMISSION_DENIED', 'Other workspace cannot enable downloads');
select throws_ok($$select public.request_gallery_selection_revision('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, 'Escolha novamente')$$, '42501', 'SELECTION_REVISION_DENIED', 'Other workspace cannot request selection changes');
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is((select downloads_enabled from public.gallery_shares where id = current_setting('test.share_id')::uuid), false, 'Downloads start disabled');
select throws_ok($$select public.request_gallery_selection_revision('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, ' ')$$, '22023', 'SELECTION_REVISION_MESSAGE_INVALID', 'Revision request requires a useful client message');
select is(public.request_gallery_selection_revision('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, 'Revise as fotos da cerimônia.'), true, 'Owner can request a revision of a submitted selection');
select is((select submitted_at is null and submitted_name is null and revision_requested_at is not null and revision_message = 'Revise as fotos da cerimônia.' and not downloads_enabled from public.gallery_shares where id = current_setting('test.share_id')::uuid), true, 'Revision reopens the selection and pauses downloads');
select throws_ok($$select public.request_gallery_selection_revision('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, 'Outro ajuste')$$, '42501', 'SELECTION_NOT_SUBMITTED', 'A second revision request waits for the client to resubmit');
select is((select count(*)::integer from public.gallery_selection_revisions where share_id = current_setting('test.share_id')::uuid), 1, 'Submitted version is kept in revision history');
select is((select original_filename from public.gallery_selection_revision_items where revision_id = (select id from public.gallery_selection_revisions where share_id = current_setting('test.share_id')::uuid)), 'ready.png', 'Revision history snapshots the submitted filenames');
select is((select client_note from public.gallery_selection_revision_items where revision_id = (select id from public.gallery_selection_revisions where share_id = current_setting('test.share_id')::uuid)), 'Remove the reflection.', 'Revision history snapshots the submitted photo note');
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_shared_gallery(current_setting('test.share_token'))->>'revision_message', 'Revise as fotos da cerimônia.', 'Client can read the photographer revision note');
select is(public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', false), 0, 'Client can revise the preserved draft');
select is(public.set_gallery_selection(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', true), 1, 'Client may keep a previous choice');
select is(public.set_gallery_selection_photo_note(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', 'New note.'), 'New note.', 'Client can update a note during revision');
select is(public.submit_gallery_selection(current_setting('test.share_token'), 'Cliente A revisou'), true, 'Client can submit the revised selection');
select is(public.get_shared_gallery(current_setting('test.share_token'))->>'revision_message', null, 'Resubmission removes the old revision note from the client view');
reset role;
select is((select submitted_name from public.gallery_shares where id = current_setting('test.share_id')::uuid), 'Cliente A revisou', 'Photographer sees the new submission');
select is((select client_note from public.gallery_selection_revision_items where revision_id = (select id from public.gallery_selection_revisions where share_id = current_setting('test.share_id')::uuid)), 'Remove the reflection.', 'Revision snapshot remains unchanged after the client updates the note');
select is((select revision_message from public.gallery_selection_revisions where share_id = current_setting('test.share_id')::uuid), 'Revise as fotos da cerimônia.', 'History retains the revision note after resubmission');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.set_gallery_share_downloads('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, true), true, 'Owner explicitly enables downloads');
select is((public.get_shared_gallery(current_setting('test.share_token'))->>'downloads_enabled')::boolean, true, 'Public view reflects download permission');
select is(public.set_gallery_cover_photo('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', null), true, 'Owner can return the gallery to automatic cover selection');
select is(public.get_shared_gallery(current_setting('test.share_token'))->>'cover_photo_id', public.get_shared_gallery(current_setting('test.share_token'))->'photos'->0->>'id', 'Automatic cover follows the first ready photo in gallery order');
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select public.authorize_gallery_download(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101')$$, '42501', null, 'Visitor cannot call privileged download authorization directly');
select throws_ok($$select public.authorize_gallery_download_bundle(current_setting('test.share_token'))$$, '42501', null, 'Visitor cannot call privileged bundle authorization directly');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok($$select public.authorize_gallery_download_bundle(current_setting('test.share_token'), null, 127)$$, '54000', 'DOWNLOAD_BUNDLE_TOO_LARGE', 'Oversized bundle is rejected before recording emissions');
select is(public.authorize_gallery_download(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101')->>'filename', 'ready.png', 'Server authorization returns only a selected original');
select is(public.authorize_gallery_download(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101')->>'path', '33333333-3333-4333-8333-333333333333/33333333-0000-4000-8000-000000000001/33333333-0000-4000-8000-000000000101.png', 'Server authorization resolves the registered original path');
select set_config('test.selection_bundle', public.authorize_gallery_download_bundle(current_setting('test.share_token'))::text, true);
select is(jsonb_array_length(current_setting('test.selection_bundle')::jsonb->'files'), 1, 'Selection ZIP includes only the submitted photo');
select is(current_setting('test.selection_bundle')::jsonb->'files'->0->>'filename', 'ready.png', 'Selection ZIP uses the registered original filename');
select ok((current_setting('test.selection_bundle')::jsonb->>'download_batch_id') ~ '^[0-9a-f-]{36}$', 'Selection ZIP receives a reconciliation batch id');
select throws_ok($$select public.authorize_gallery_download(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101')$$, '54000', 'DOWNLOAD_LIMIT_REACHED', 'Fourth download grant is rate limited');
select is(public.release_interrupted_gallery_download_bundle(
  current_setting('test.share_token'), (current_setting('test.selection_bundle')::jsonb->>'download_batch_id')::uuid, 0),
  1, 'An interrupted ZIP releases its unfinished photo emission');
select is(public.release_interrupted_gallery_download_bundle(
  current_setting('test.share_token'), (current_setting('test.selection_bundle')::jsonb->>'download_batch_id')::uuid, 0),
  0, 'Reconciliation is safe to retry');
select is(public.authorize_gallery_download(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101')->>'filename',
  'ready.png', 'A failed ZIP attempt no longer blocks a successful retry');
select throws_ok($$select public.release_interrupted_gallery_download_bundle(current_setting('test.share_token'), gen_random_uuid(), 501)$$,
  '22023', 'DOWNLOAD_BUNDLE_PROGRESS_INVALID', 'Reconciliation rejects progress outside the bundle limit');
reset role;
select is((select count(*)::integer from public.gallery_download_events where share_id = current_setting('test.share_id')::uuid), 4, 'Owner can audit successful and interrupted download grants');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is((select download_count from public.gallery_download_audit_counts(
  '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001')
  where share_id = current_setting('test.share_id')::uuid and photo_id = '33333333-0000-4000-8000-000000000101'),
  3, 'Download audit excludes unfinished photo emissions');
select set_config('request.jwt.claim.sub', '44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select throws_ok($$select * from public.gallery_download_audit_counts(
  '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001')$$,
  '42501', 'DOWNLOAD_AUDIT_DENIED', 'Other workspace cannot read download aggregates');
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.set_gallery_share_downloads('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', current_setting('test.share_id')::uuid, false), true, 'Owner can disable downloads');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.authorize_gallery_download(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101'), null::jsonb, 'Disabled download permission denies new grants');

reset role;
update public.gallery_download_events set created_at = now() - interval '91 days'
  where id in (select id from public.gallery_download_events where share_id = current_setting('test.share_id')::uuid order by id limit 2);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok($$select public.prune_gallery_download_events(90)$$, '42501', null, 'Workspace member cannot purge audit history');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok($$select public.prune_gallery_download_events(29)$$, '22023', 'DOWNLOAD_RETENTION_INVALID', 'Retention cannot be shorter than 30 days');
select is(public.prune_gallery_download_events(90), 2, 'Purge removes only events older than the retention window');
select is((select count(*)::integer from public.gallery_download_events where share_id = current_setting('test.share_id')::uuid), 2, 'Recent audit events retain both successful and reverted outcomes');
select is(public.prune_gallery_download_events(90), 0, 'Purge is idempotent');
reset role;
update public.gallery_shares set expires_at = now() - interval '1 minute';
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_shared_gallery(current_setting('test.share_token')), null::jsonb, 'Expired link stops opening gallery');
select throws_ok($$select public.authorize_shared_photo_image(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', null, repeat('a', 64))$$,
  '42501', null, 'Visitors cannot call image authorization directly');
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.authorize_shared_photo_image(current_setting('test.share_token'), '33333333-0000-4000-8000-000000000101', null, repeat('a', 64)), null::jsonb, 'Expired link stops image access');
reset role;
update public.gallery_shares set expires_at = now() + interval '7 days';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is(public.revoke_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', (select id from public.gallery_shares limit 1)), true, 'Member revokes link');
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_shared_gallery(current_setting('test.share_token')), null::jsonb, 'Revoked link stops opening gallery');
reset role;
update public.gallery_shares set revoked_at = null;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
update public.galleries set status = 'draft' where id = '33333333-0000-4000-8000-000000000001';
select is((select count(*)::int from public.gallery_shares where revoked_at is not null), 1, 'Unpublishing permanently revokes links');
select throws_ok($$select public.create_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', now() + interval '7 days')$$, '42501', null, 'Draft gallery cannot create links');
update public.galleries set status = 'published' where id = '33333333-0000-4000-8000-000000000001';
select is((select count(*)::int from public.gallery_shares where revoked_at is not null), 1, 'Republishing does not revive old links');
select set_config('test.stale_token', public.create_gallery_share('33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', now() + interval '7 days'), true);
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.set_gallery_selection(current_setting('test.stale_token'), '33333333-0000-4000-8000-000000000101', true), 1, 'Second link may draft a choice');
reset role;
delete from public.photos where id = '33333333-0000-4000-8000-000000000101';
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.submit_gallery_selection(current_setting('test.stale_token'), 'Cliente B'), false, 'Deleted draft photo does not produce an empty submission');
select is((public.get_shared_gallery(current_setting('test.stale_token'))->>'selected_count')::integer, 0, 'Stale draft choice is removed');
reset role;
select is((select original_filename from public.gallery_selection_items where share_id = (select id from public.gallery_shares where token_hash = extensions.digest(current_setting('test.share_token'), 'sha256'))), 'ready.png', 'Submitted selection keeps its filename after photo deletion');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('test.delivery_token', public.create_gallery_share(
  '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001', now() + interval '7 days', null, 'delivery'), true);
reset role;
select set_config('test.delivery_share_id', (select id::text from public.gallery_shares where token_hash = extensions.digest(current_setting('test.delivery_token'), 'sha256')), true);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select throws_ok($$select public.request_gallery_selection_revision(
  '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001',
  current_setting('test.delivery_share_id')::uuid, 'Revisar')$$,
  '42501', 'SELECTION_MODE_DISABLED', 'Delivery link cannot request a photo selection revision');
reset role;
select is((select share_mode from public.gallery_shares where token_hash = extensions.digest(current_setting('test.delivery_token'), 'sha256')), 'delivery', 'New link stores delivery mode');
select is((select downloads_enabled from public.gallery_shares where token_hash = extensions.digest(current_setting('test.delivery_token'), 'sha256')), true, 'Delivery mode enables original downloads by default');
select is((select selection_limit from public.gallery_shares where token_hash = extensions.digest(current_setting('test.delivery_token'), 'sha256')), 500, 'Delivery mode does not require a selection limit');
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select is(public.get_shared_gallery(current_setting('test.delivery_token'))->>'share_mode', 'delivery', 'Public link response exposes delivery mode');
select throws_ok($$select public.set_gallery_selection(current_setting('test.delivery_token'), '33333333-0000-4000-8000-000000000104', true)$$, '42501', 'SELECTION_MODE_DISABLED', 'Delivery link cannot accept selections');
select throws_ok($$select public.submit_gallery_selection(current_setting('test.delivery_token'), 'Cliente C')$$, '42501', 'SELECTION_MODE_DISABLED', 'Delivery link cannot submit selections');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('test.delivery_bundle', public.authorize_gallery_download_bundle(current_setting('test.delivery_token'))::text, true);
select is(jsonb_array_length(current_setting('test.delivery_bundle')::jsonb->'files'), 1, 'Delivery ZIP includes every ready original');
select is(current_setting('test.delivery_bundle')::jsonb->'files'->0->>'filename', 'extra.png', 'Delivery ZIP resolves the ready original');
select is(public.authorize_gallery_download(current_setting('test.delivery_token'), '33333333-0000-4000-8000-000000000104')->>'filename', 'extra.png', 'Delivery link can authorize an original without a selection');
select lives_ok($$select public.authorize_gallery_download(current_setting('test.delivery_token'), '33333333-0000-4000-8000-000000000104')$$, 'Delivery link permits further grants within its limit');
select throws_ok($$select public.authorize_gallery_download(current_setting('test.delivery_token'), '33333333-0000-4000-8000-000000000104')$$, '54000', 'DOWNLOAD_LIMIT_REACHED', 'Delivery links keep the per-photo download limit');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select is((select download_count from public.gallery_download_audit_counts(
  '33333333-3333-4333-8333-333333333333', '33333333-0000-4000-8000-000000000001')
  where share_id = current_setting('test.delivery_share_id')::uuid and photo_id = '33333333-0000-4000-8000-000000000104'),
  3, 'Download audit aggregates delivery grants across the gallery');
select * from finish();
rollback;

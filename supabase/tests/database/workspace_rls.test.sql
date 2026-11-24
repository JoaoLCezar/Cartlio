begin;

select plan(34);

-- Dados apenas nesta transação; rollback evita usuários de teste persistentes.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@cartlio.test', '', now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@cartlio.test', '', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select public.create_workspace('Fotógrafo A', 'fotografo-a-test');

select is((select count(*)::int from public.tenants), 1, 'A vê seu workspace');
select is((select count(*)::int from public.tenant_members), 1, 'A vê sua associação');
select throws_ok(
  $$ insert into public.tenant_members (tenant_id, user_id, role)
     select id, '22222222-2222-4222-8222-222222222222', 'owner' from public.tenants $$,
  '42501', 'permission denied for table tenant_members',
  'Membro não consegue se conceder papel de owner'
);
select throws_ok(
  $$ insert into public.tenants (slug, name, created_by)
     values ('injetado-test', 'Injetado', '22222222-2222-4222-8222-222222222222') $$,
  '42501', 'permission denied for table tenants',
  'Usuário não consegue forjar o criador diretamente'
);

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select public.create_workspace('Fotógrafo B', 'fotografo-b-test');

reset role;
select set_config('test.workspace_a_id', (select id::text from public.tenants where slug = 'fotografo-a-test'), true);
insert into public.galleries(id, tenant_id, title, slug, status)
select '77777777-0000-4000-8000-000000000001', id, 'Ops A', 'ops-a', 'draft'
from public.tenants where slug = 'fotografo-a-test';
insert into public.galleries(id, tenant_id, title, slug, status)
select '88888888-0000-4000-8000-000000000001', id, 'Ops B', 'ops-b', 'draft'
from public.tenants where slug = 'fotografo-b-test';
insert into public.photos(id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status, deletion_requested_at)
select x.photo_id, t.id, g.id, t.id::text || '/' || g.id::text || '/' || x.photo_id::text || '.png', x.filename,
  'image/png', 128, t.created_by, x.processing_status, x.deletion_requested_at
from (values
  ('77777777-0000-4000-8000-000000000101'::uuid, 'pending.png', 'pending', null::timestamptz),
  ('77777777-0000-4000-8000-000000000102'::uuid, 'processing.png', 'processing', null::timestamptz),
  ('77777777-0000-4000-8000-000000000103'::uuid, 'failed.png', 'failed', null::timestamptz),
  ('77777777-0000-4000-8000-000000000104'::uuid, 'deleting.png', 'ready', now())
) as x(photo_id, filename, processing_status, deletion_requested_at)
join public.tenants t on t.slug = 'fotografo-a-test'
join public.galleries g on g.id = '77777777-0000-4000-8000-000000000001';
with photo as (select gen_random_uuid() as id)
insert into public.photos(id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status)
select photo.id, t.id, g.id, t.id::text || '/' || g.id::text || '/' || photo.id::text || '.png', 'other-failed.png',
  'image/png', 128, t.created_by, 'failed'
from photo cross join public.tenants t join public.galleries g on g.id = '88888888-0000-4000-8000-000000000001' and g.tenant_id = t.id;
insert into public.photos(id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status)
select x.photo_id, t.id, g.id, t.id::text || '/' || g.id::text || '/' || x.photo_id::text || '.png', x.filename,
  'image/png', 128, t.created_by, 'ready'
from (values
  ('77777777-0000-4000-8000-000000000105'::uuid, 'selected-a.png'),
  ('88888888-0000-4000-8000-000000000105'::uuid, 'selected-b.png')
) as x(photo_id, filename)
join public.tenants t on t.slug = case when x.photo_id::text like '7777%' then 'fotografo-a-test' else 'fotografo-b-test' end
join public.galleries g on g.tenant_id = t.id and g.id = case when x.photo_id::text like '7777%' then '77777777-0000-4000-8000-000000000001'::uuid else '88888888-0000-4000-8000-000000000001'::uuid end;
insert into public.gallery_shares(id, tenant_id, gallery_id, token_hash, expires_at, created_by, submitted_at, submitted_name)
select x.share_id, t.id, g.id, extensions.digest(x.share_id::text, 'sha256'), now() + interval '2 days', t.created_by,
  x.submitted_at, x.submitted_name
from (values
  ('77777777-0000-4000-8000-000000000301'::uuid, 'fotografo-a-test', '77777777-0000-4000-8000-000000000001'::uuid, '2026-10-26 10:00:00+00'::timestamptz, 'Cliente A'),
  ('88888888-0000-4000-8000-000000000301'::uuid, 'fotografo-b-test', '88888888-0000-4000-8000-000000000001'::uuid, '2026-10-26 11:00:00+00'::timestamptz, 'Cliente B')
) as x(share_id, tenant_slug, gallery_id, submitted_at, submitted_name)
join public.tenants t on t.slug = x.tenant_slug
join public.galleries g on g.tenant_id = t.id and g.id = x.gallery_id;
insert into public.gallery_selection_items(share_id, photo_id, original_filename)
values
  ('77777777-0000-4000-8000-000000000301', '77777777-0000-4000-8000-000000000105', 'selected-a.png'),
  ('88888888-0000-4000-8000-000000000301', '88888888-0000-4000-8000-000000000105', 'selected-b.png');
insert into public.upload_sessions(id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, state, expires_at, created_by)
select x.upload_id, t.id, g.id, t.id::text || '/' || g.id::text || '/' || x.upload_id::text || '.png', x.filename,
  'image/png', 128, x.state, x.expires_at, t.created_by
from (values
  ('77777777-0000-4000-8000-000000000201'::uuid, 'expired.png', 'reserved', now() - interval '1 minute'),
  ('77777777-0000-4000-8000-000000000202'::uuid, 'canceling.png', 'canceling', now() + interval '1 hour')
) as x(upload_id, filename, state, expires_at)
join public.tenants t on t.slug = 'fotografo-a-test'
join public.galleries g on g.id = '77777777-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);

select is((select count(*)::int from public.tenants), 1, 'B vê apenas seu workspace');
select is((select count(*)::int from public.tenant_members), 1, 'B vê apenas sua associação');
select is((select count(*)::int from public.tenants where slug = 'fotografo-a-test'), 0, 'B não lê A');
select is((select private.is_tenant_owner(id) from public.tenants where slug = 'fotografo-b-test'), true, 'B é owner de B');

reset role;
select is((select count(*)::int from public.tenants where slug in ('fotografo-a-test', 'fotografo-b-test')), 2, 'Administrador vê ambos os workspaces de teste');
set local role anon;
select throws_ok(
  $$ select * from public.tenants $$,
  '42501', 'permission denied for table tenants',
  'Visitante anônimo não acessa workspaces'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select is(public.workspace_operations((select id from public.tenants where slug = 'fotografo-a-test')),
  jsonb_build_object(
    'uploads_pending', 2, 'uploads_expired', 1, 'uploads_canceling', 1,
    'photos_pending', 1, 'photos_processing', 1, 'photos_failed', 1, 'photos_deleting', 1,
    'selections_received', 1,
    'selection_inbox', jsonb_build_array(jsonb_build_object(
      'share_id', '77777777-0000-4000-8000-000000000301',
      'gallery_id', '77777777-0000-4000-8000-000000000001',
      'gallery_title', 'Ops A',
      'submitted_at', (select submitted_at from public.gallery_shares where id = '77777777-0000-4000-8000-000000000301'),
      'submitted_name', 'Cliente A', 'selected_count', 1
    )),
    'galleries', jsonb_build_array(jsonb_build_object(
      'id', '77777777-0000-4000-8000-000000000001', 'title', 'Ops A',
      'uploads_pending', 2, 'uploads_expired', 1, 'uploads_canceling', 1,
      'photos_pending', 1, 'photos_processing', 1, 'photos_failed', 1, 'photos_deleting', 1
    ))
  ), 'Workspace owner sees operational counts grouped only for their workspace');
select ok(not (public.workspace_operations((select id from public.tenants where slug = 'fotografo-a-test'))->'selection_inbox'
  @> jsonb_build_array(jsonb_build_object('submitted_name', 'Cliente B'))),
  'Selection inbox never leaks another workspace client names');
select is(public.set_gallery_selection_reviewed(
  (select id from public.tenants where slug = 'fotografo-a-test'),
  '77777777-0000-4000-8000-000000000001', '77777777-0000-4000-8000-000000000301', true
), true, 'Photographer can mark a submitted selection reviewed');
select is((public.workspace_operations((select id from public.tenants where slug = 'fotografo-a-test'))->>'selections_received')::integer,
  0, 'Reviewed selections leave the dashboard inbox');
select is(public.set_gallery_selection_reviewed(
  (select id from public.tenants where slug = 'fotografo-a-test'),
  '77777777-0000-4000-8000-000000000001', '77777777-0000-4000-8000-000000000301', false
), true, 'Photographer can return a reviewed selection to pending');
select is((public.workspace_operations((select id from public.tenants where slug = 'fotografo-a-test'))->>'selections_received')::integer,
  1, 'Returned selection appears in the dashboard inbox');
select throws_ok($$select public.set_gallery_selection_reviewed(
  (select id from public.tenants where slug = 'fotografo-a-test'),
  '77777777-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000301', true
)$$, '42501', 'SELECTION_REVIEW_DENIED', 'Photographer cannot change another workspace selection status');
select lives_ok($$select public.set_gallery_photo_order(
  (select id from public.tenants where slug = 'fotografo-a-test'),
  '77777777-0000-4000-8000-000000000001',
  array['77777777-0000-4000-8000-000000000103','77777777-0000-4000-8000-000000000102','77777777-0000-4000-8000-000000000101','77777777-0000-4000-8000-000000000105']::uuid[]
)$$, 'Workspace member can reorder every active photo');
select is((select array_agg(id::text order by sort_order) from public.photos
  where gallery_id = '77777777-0000-4000-8000-000000000001' and deletion_requested_at is null),
  array['77777777-0000-4000-8000-000000000103','77777777-0000-4000-8000-000000000102','77777777-0000-4000-8000-000000000101','77777777-0000-4000-8000-000000000105'],
  'Saved order is reflected in gallery photo ranks');
select lives_ok($$select public.move_gallery_photo(
  (select id from public.tenants where slug = 'fotografo-a-test'),
  '77777777-0000-4000-8000-000000000001',
  '77777777-0000-4000-8000-000000000103', '77777777-0000-4000-8000-000000000101', true
)$$, 'Workspace member can move a photo after a target');
select is((select array_agg(id::text order by sort_order) from public.photos
  where gallery_id = '77777777-0000-4000-8000-000000000001' and deletion_requested_at is null),
  array['77777777-0000-4000-8000-000000000102','77777777-0000-4000-8000-000000000101','77777777-0000-4000-8000-000000000103','77777777-0000-4000-8000-000000000105'],
  'Moving down shifts intervening photo ranks');
select lives_ok($$select public.move_gallery_photo(
  (select id from public.tenants where slug = 'fotografo-a-test'),
  '77777777-0000-4000-8000-000000000001',
  '77777777-0000-4000-8000-000000000105', '77777777-0000-4000-8000-000000000102', false
)$$, 'Workspace member can move a photo before a target');
select is((select array_agg(id::text order by sort_order) from public.photos
  where gallery_id = '77777777-0000-4000-8000-000000000001' and deletion_requested_at is null),
  array['77777777-0000-4000-8000-000000000105','77777777-0000-4000-8000-000000000102','77777777-0000-4000-8000-000000000101','77777777-0000-4000-8000-000000000103'],
  'Moving up shifts intervening photo ranks');
select is(public.move_gallery_photo(
  (select id from public.tenants where slug = 'fotografo-a-test'),
  '77777777-0000-4000-8000-000000000001',
  '77777777-0000-4000-8000-000000000101', '77777777-0000-4000-8000-000000000101', true
), true, 'Moving a photo relative to itself is a safe no-op');
select throws_ok($$select public.move_gallery_photo(
  (select id from public.tenants where slug = 'fotografo-a-test'),
  '77777777-0000-4000-8000-000000000001',
  '77777777-0000-4000-8000-000000000105', '77777777-0000-4000-8000-000000000104', false
)$$, '22023', 'PHOTO_ORDER_INVALID', 'A photo pending deletion cannot be a reorder target');
reset role;
insert into public.photos(id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status, sort_order)
select '77777777-0000-4000-8000-000000000106', t.id, g.id,
  t.id::text || '/' || g.id::text || '/77777777-0000-4000-8000-000000000106.png',
  'cover-override.png', 'image/png', 128, t.created_by, 'ready', 99
from public.tenants t join public.galleries g on g.tenant_id = t.id
where t.slug = 'fotografo-a-test' and g.id = '77777777-0000-4000-8000-000000000001';
update public.galleries set cover_photo_id = '77777777-0000-4000-8000-000000000106'
where id = '77777777-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select is((select photo_id from public.workspace_gallery_cover_photos(
  (select id from public.tenants where slug = 'fotografo-a-test'), array['77777777-0000-4000-8000-000000000001']::uuid[]
)), '77777777-0000-4000-8000-000000000106'::uuid, 'Dashboard cover query honors a selected ready cover');
reset role;
update public.galleries set cover_photo_id = '77777777-0000-4000-8000-000000000103'
where id = '77777777-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select is((select photo_id from public.workspace_gallery_cover_photos(
  (select id from public.tenants where slug = 'fotografo-a-test'), array['77777777-0000-4000-8000-000000000001']::uuid[]
)), '77777777-0000-4000-8000-000000000105'::uuid, 'Dashboard cover query falls back when the selected photo is not ready');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select throws_ok($$select * from public.workspace_gallery_cover_photos(current_setting('test.workspace_a_id')::uuid,
  array['77777777-0000-4000-8000-000000000001']::uuid[])$$,
  '42501', 'Workspace access denied', 'Member cannot read another workspace gallery covers');
reset role;
update public.photos set processing_status = 'failed' where id = '88888888-0000-4000-8000-000000000105';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select is((select photo_id from public.workspace_gallery_cover_photos(
  (select id from public.tenants where slug = 'fotografo-b-test'), array['88888888-0000-4000-8000-000000000001']::uuid[]
)), null::uuid, 'Gallery without ready photos has no dashboard cover');
reset role;
update public.photos set processing_status = 'ready' where id = '88888888-0000-4000-8000-000000000105';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select is(public.workspace_operations((select id from public.tenants where slug = 'fotografo-b-test')),
  jsonb_build_object(
    'uploads_pending', 0, 'uploads_expired', 0, 'uploads_canceling', 0,
    'photos_pending', 0, 'photos_processing', 0, 'photos_failed', 1, 'photos_deleting', 0,
    'selections_received', 1,
    'selection_inbox', jsonb_build_array(jsonb_build_object(
      'share_id', '88888888-0000-4000-8000-000000000301',
      'gallery_id', '88888888-0000-4000-8000-000000000001',
      'gallery_title', 'Ops B',
      'submitted_at', (select submitted_at from public.gallery_shares where id = '88888888-0000-4000-8000-000000000301'),
      'submitted_name', 'Cliente B', 'selected_count', 1
    )),
    'galleries', jsonb_build_array(jsonb_build_object(
      'id', '88888888-0000-4000-8000-000000000001', 'title', 'Ops B',
      'uploads_pending', 0, 'uploads_expired', 0, 'uploads_canceling', 0,
      'photos_pending', 0, 'photos_processing', 0, 'photos_failed', 1, 'photos_deleting', 0
    ))
  ), 'Workspace B sees its own operational counts only');
select throws_ok($$select public.workspace_operations(current_setting('test.workspace_a_id')::uuid)$$,
  '42501', 'Workspace access denied', 'Member cannot read another workspace operational counts');
select throws_ok($$select public.set_gallery_photo_order(current_setting('test.workspace_a_id')::uuid,
  '77777777-0000-4000-8000-000000000001', array['77777777-0000-4000-8000-000000000101']::uuid[])$$,
  '42501', 'PHOTO_ORDER_DENIED', 'Member cannot reorder another workspace photos');
select throws_ok($$select public.move_gallery_photo(current_setting('test.workspace_a_id')::uuid,
  '77777777-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000105',
  '77777777-0000-4000-8000-000000000102', false)$$,
  '42501', 'PHOTO_ORDER_DENIED', 'Member cannot move photos in another workspace gallery');
set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select public.workspace_operations('99999999-9999-4999-8999-999999999999')$$,
  '42501', null, 'Anonymous visitor cannot call workspace operations');

select * from finish();
rollback;

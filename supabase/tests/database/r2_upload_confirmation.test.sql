begin;
select no_plan();

-- Exercise a future R2 reservation inside this rolled-back transaction only.
select ok(exists (select 1 from pg_constraint where conrelid = 'public.upload_sessions'::regclass
  and conname = 'upload_sessions_storage_provider_check' and pg_get_constraintdef(oid) not ilike '%r2%'),
  'R2 reservations remain disabled in the deployed schema');
alter table public.upload_sessions drop constraint upload_sessions_storage_provider_check;
alter table public.photos drop constraint photos_storage_provider_check;

insert into auth.users (id, instance_id, aud, role, email) values
  ('24242424-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2-owner@quadrics.test'),
  ('24242424-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2-outsider@quadrics.test');
insert into public.tenants (id, slug, name, created_by) values
  ('24242424-0000-4000-8000-000000000003', 'r2-confirm-tests', 'R2 confirmation', '24242424-0000-4000-8000-000000000001');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('24242424-0000-4000-8000-000000000003', '24242424-0000-4000-8000-000000000001', 'owner');
insert into public.galleries (id, tenant_id, title, slug) values
  ('24242424-0000-4000-8000-000000000004', '24242424-0000-4000-8000-000000000003', 'Confirmation', 'confirmation');
insert into public.upload_sessions (
  id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, storage_provider
) values (
  '24242424-0000-4000-8000-000000000005', '24242424-0000-4000-8000-000000000003', '24242424-0000-4000-8000-000000000004',
  '24242424-0000-4000-8000-000000000003/24242424-0000-4000-8000-000000000004/24242424-0000-4000-8000-000000000005.png',
  'photo.png', 'image/png', 128, '24242424-0000-4000-8000-000000000001', 'r2'
);

create function pg_temp.confirm_r2(
  tag text default '"object-1"', actor uuid default '24242424-0000-4000-8000-000000000001',
  bytes bigint default 128, object_type text default 'image/png'
) returns uuid language sql as $$
  select public.complete_r2_photo_upload(
    actor, '24242424-0000-4000-8000-000000000003', '24242424-0000-4000-8000-000000000004',
    '24242424-0000-4000-8000-000000000005',
    '24242424-0000-4000-8000-000000000003/24242424-0000-4000-8000-000000000004/24242424-0000-4000-8000-000000000005.png',
    bytes, object_type, tag
  );
$$;

select ok(not has_function_privilege('anon', 'public.complete_r2_photo_upload(uuid,uuid,uuid,uuid,text,bigint,text,text)', 'EXECUTE'),
  'Anonymous users cannot submit verification');
select ok(not has_function_privilege('authenticated', 'public.complete_r2_photo_upload(uuid,uuid,uuid,uuid,text,bigint,text,text)', 'EXECUTE'),
  'Browser sessions cannot submit verification');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok($$select pg_temp.confirm_r2(actor => '24242424-0000-4000-8000-000000000002')$$,
  '42501', 'UPLOAD_CONFIRMATION_DENIED', 'Server must identify a member of the workspace');
select throws_ok($$select pg_temp.confirm_r2(tag => '*')$$,
  'P0001', 'UPLOAD_MISMATCH', 'Wildcard does not identify an object');
select throws_ok($$select pg_temp.confirm_r2(bytes => 129)$$,
  'P0001', 'UPLOAD_MISMATCH', 'Size must match the reservation');
select throws_ok($$select pg_temp.confirm_r2(object_type => 'image/jpeg')$$,
  'P0001', 'UPLOAD_MISMATCH', 'Content type must match the reservation');

reset role;
update public.upload_sessions set expires_at = clock_timestamp() - interval '1 second'
  where id = '24242424-0000-4000-8000-000000000005';
set local role service_role;
select throws_ok($$select pg_temp.confirm_r2()$$, 'P0001', 'UPLOAD_CLOSED', 'Server cannot finalize an expired reservation');

reset role;
update public.upload_sessions set expires_at = clock_timestamp() + interval '1 hour'
  where id = '24242424-0000-4000-8000-000000000005';
set local role service_role;
select is(pg_temp.confirm_r2(), '24242424-0000-4000-8000-000000000005'::uuid, 'Server finalizes the reserved R2 object');
select is(pg_temp.confirm_r2(), '24242424-0000-4000-8000-000000000005'::uuid, 'Repeated confirmation returns the same photo');
select throws_ok($$select pg_temp.confirm_r2(tag => '"replacement"')$$,
  'P0001', 'UPLOAD_MISMATCH', 'Repeated confirmation cannot replace the recorded object tag');
reset role;
select is((select state from public.upload_sessions where id = '24242424-0000-4000-8000-000000000005'),
  'completed', 'Finalization releases the reservation by completing the session');
select is((select storage_etag from public.photos where id = '24242424-0000-4000-8000-000000000005'),
  '"object-1"', 'The photo stores the verified ETag');
select is((select byte_size from public.photos where id = '24242424-0000-4000-8000-000000000005'),
  128::bigint, 'Only one photo is stored with the confirmed size');

update public.photos set processing_status = 'ready' where id = '24242424-0000-4000-8000-000000000005';
update public.galleries set status = 'published' where id = '24242424-0000-4000-8000-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '24242424-0000-4000-8000-000000000001', true);
select set_config('test.r2_download_token', public.create_gallery_share(
  '24242424-0000-4000-8000-000000000003', '24242424-0000-4000-8000-000000000004',
  now() + interval '7 days', null, 'delivery', null
), true);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('test.r2_grant', public.authorize_gallery_download(
  current_setting('test.r2_download_token'), '24242424-0000-4000-8000-000000000005'
)::text, true);
select is(current_setting('test.r2_grant')::jsonb->>'storage_etag', '"object-1"',
  'Individual download receives the verified original ETag');
select is(current_setting('test.r2_grant')::jsonb->>'storage_provider', 'r2',
  'Individual download receives the original provider');
select is(public.authorize_gallery_download_bundle(current_setting('test.r2_download_token'))->'files'->0,
  current_setting('test.r2_grant')::jsonb, 'ZIP snapshots the same authorized object identity');

reset role;
insert into public.photos (
  id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, processing_status
) values (
  '24242424-0000-4000-8000-000000000006', '24242424-0000-4000-8000-000000000003', '24242424-0000-4000-8000-000000000004',
  '24242424-0000-4000-8000-000000000003/24242424-0000-4000-8000-000000000004/24242424-0000-4000-8000-000000000006.png',
  'legacy.png', 'image/png', 96, '24242424-0000-4000-8000-000000000001', 'ready'
);
set local role service_role;
select set_config('test.mixed_download_bundle',
  public.authorize_gallery_download_bundle(current_setting('test.r2_download_token'))::text, true);
select is(
  (select array_agg(file->>'storage_provider' order by file->>'storage_provider')
    from jsonb_array_elements(current_setting('test.mixed_download_bundle')::jsonb->'files') as file),
  array['r2', 'supabase'], 'ZIP carries each provider in mixed galleries'
);
select is(current_setting('test.mixed_download_bundle')::jsonb->>'total_bytes', '224',
  'ZIP counts the sizes of both providers');

reset role;
insert into public.upload_sessions (
  id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, storage_provider
)
select id, '24242424-0000-4000-8000-000000000003', '24242424-0000-4000-8000-000000000004',
  '24242424-0000-4000-8000-000000000003/24242424-0000-4000-8000-000000000004/' || id || '.png',
  'pending.png', 'image/png', 128, '24242424-0000-4000-8000-000000000001', 'r2'
from (values
  ('24242424-0000-4000-8000-000000000007'::uuid), ('24242424-0000-4000-8000-000000000008'::uuid),
  ('24242424-0000-4000-8000-000000000009'::uuid), ('24242424-0000-4000-8000-000000000010'::uuid)
) as fixture(id);

create function pg_temp.prepare_r2(
  upload_id uuid, actor uuid default '24242424-0000-4000-8000-000000000001'
) returns public.upload_sessions language sql as $$
  select public.prepare_r2_upload_put(actor, '24242424-0000-4000-8000-000000000003',
    '24242424-0000-4000-8000-000000000004', upload_id);
$$;

select ok(not has_function_privilege('authenticated', 'public.prepare_r2_upload_put(uuid,uuid,uuid,uuid)', 'EXECUTE'),
  'Browser sessions cannot authorize an R2 PUT directly');
set local role service_role;
select throws_ok($$select pg_temp.prepare_r2('24242424-0000-4000-8000-000000000007', '24242424-0000-4000-8000-000000000002')$$,
  '42501', 'UPLOAD_CONFIRMATION_DENIED', 'Another studio member cannot authorize a PUT');
select ok((pg_temp.prepare_r2('24242424-0000-4000-8000-000000000007')).r2_put_authorized_at is not null,
  'The server records the PUT capability before it can sign');
select ok((pg_temp.prepare_r2('24242424-0000-4000-8000-000000000009')).r2_put_authorized_at is not null,
  'Authorization also marks the reservation processed by automatic expiry');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok($$insert into storage.objects(bucket_id, name)
  select 'gallery-originals', object_path from public.upload_sessions where id = '24242424-0000-4000-8000-000000000007'$$,
  '42501', null, 'An R2 reservation cannot authorize a Supabase upload');

reset role;
update public.upload_sessions set expires_at = clock_timestamp() - interval '1 minute'
  where id in ('24242424-0000-4000-8000-000000000009', '24242424-0000-4000-8000-000000000010');
select private.expire_upload_reservations('24242424-0000-4000-8000-000000000003');
select is((select state from public.upload_sessions where id = '24242424-0000-4000-8000-000000000009'),
  'canceling', 'Expiry keeps the quota when a write might still commit');
select is((select state from public.upload_sessions where id = '24242424-0000-4000-8000-000000000010'),
  'canceled', 'Expiry safely releases a reservation that never authorized a write');

update public.upload_sessions set expires_at = clock_timestamp() - interval '1 minute'
  where id in ('24242424-0000-4000-8000-000000000007', '24242424-0000-4000-8000-000000000008');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.reconcile_r2_upload_reservations('24242424-0000-4000-8000-000000000003'),
  '{"examined":2,"cleaned":1,"held":2}'::jsonb, 'Reconciliation releases only the unissued reservation');
select is(public.reconcile_r2_upload_reservations('24242424-0000-4000-8000-000000000003'),
  '{"examined":0,"cleaned":0,"held":2}'::jsonb, 'Repeated cleanup does not undo holds');
select throws_ok($$select pg_temp.prepare_r2('24242424-0000-4000-8000-000000000007')$$,
  'P0001', 'UPLOAD_CLOSED', 'Held reservations cannot issue another URL');
select throws_ok($$select public.finish_upload_cancellation(
  '24242424-0000-4000-8000-000000000003', '24242424-0000-4000-8000-000000000004', '24242424-0000-4000-8000-000000000007'
)$$, 'P0001', 'UPLOAD_PROVIDER_UNSUPPORTED', 'Absence from Supabase Storage cannot release an R2 reservation');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((public.workspace_storage_usage('24242424-0000-4000-8000-000000000003')->>'reserved_bytes')::bigint,
  104857600::bigint, 'Both issued and unresolved uploads still consume quota');

reset role;
update public.upload_sessions set created_at = clock_timestamp() - interval '120 days'
  where tenant_id = '24242424-0000-4000-8000-000000000003';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.prune_upload_sessions(90, '24242424-0000-4000-8000-000000000003'),
  0, 'Supabase retention does not remove R2 history or unresolved reservations');

select * from finish();
rollback;

begin;
select no_plan();

alter table public.upload_sessions drop constraint upload_sessions_storage_provider_check;
alter table public.photos drop constraint photos_storage_provider_check;

insert into auth.users (id, instance_id, aud, role, email) values
  ('45454545-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2-delete@quadrics.test');
insert into public.tenants (id, slug, name, created_by) values
  ('45454545-0000-4000-8000-000000000003', 'r2-delete-tests', 'R2 deletion', '45454545-0000-4000-8000-000000000001');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000001', 'owner');
insert into public.galleries (id, tenant_id, title, slug) values
  ('45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000003', 'R2 deletion', 'r2-delete');
insert into public.photos (
  id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by,
  storage_provider, storage_etag
) values (
  '45454545-0000-4000-8000-000000000005', '45454545-0000-4000-8000-000000000003',
  '45454545-0000-4000-8000-000000000004',
  '45454545-0000-4000-8000-000000000003/45454545-0000-4000-8000-000000000004/45454545-0000-4000-8000-000000000005.png',
  'original.png', 'image/png', 128, '45454545-0000-4000-8000-000000000001', 'r2', '"r2-delete-etag"'
);

select has_column('public', 'photos', 'storage_delete_absent_at', 'R2 deletion persists its verified absence time');
select ok(not has_function_privilege('authenticated', 'public.record_r2_photo_deletion_absence(uuid,uuid,uuid,boolean)', 'EXECUTE'),
  'Browser sessions cannot record R2 object absence');
select ok(not has_function_privilege('authenticated', 'public.finish_r2_photo_deletion_worker(uuid,uuid,uuid)', 'EXECUTE'),
  'Browser sessions cannot finalize an R2 deletion');

set local role authenticated;
select set_config('request.jwt.claim.sub', '45454545-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is(public.begin_photo_deletion('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005'),
  '45454545-0000-4000-8000-000000000003/45454545-0000-4000-8000-000000000004/45454545-0000-4000-8000-000000000005.png',
  'Member records the R2 deletion intent');
select is(public.finish_photo_deletion('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005'),
  false, 'Member finalizer cannot remove an R2 photo row');
select throws_ok($$select public.record_r2_photo_deletion_absence('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005', true)$$,
  '42501', null, 'Member cannot claim an R2 object is absent');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.finish_photo_deletion_worker('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005'),
  false, 'Supabase worker cannot finalize an R2 photo');
select is(public.record_r2_photo_deletion_absence('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005', true),
  true, 'Trusted worker records the first absence check');
select is(public.finish_r2_photo_deletion_worker('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005'),
  false, 'R2 finalizer waits for the absence confirmation window');
select is(public.record_r2_photo_deletion_absence('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005', false),
  true, 'A present or unverified object clears the absence timer');
select is((select storage_delete_absent_at from public.photos where id = '45454545-0000-4000-8000-000000000005'),
  null::timestamptz, 'Clearing the timer is persisted');
select is(public.record_r2_photo_deletion_absence('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005', true),
  true, 'Worker can begin a new absence confirmation window');

reset role;
insert into public.photos (
  id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by,
  storage_provider, storage_etag, deletion_requested_at, storage_delete_absent_at
) values (
  '45454545-0000-4000-8000-000000000006', '45454545-0000-4000-8000-000000000003',
  '45454545-0000-4000-8000-000000000004',
  '45454545-0000-4000-8000-000000000003/45454545-0000-4000-8000-000000000004/45454545-0000-4000-8000-000000000006.png',
  'complete.png', 'image/png', 128, '45454545-0000-4000-8000-000000000001', 'r2', '"r2-delete-etag-2"',
  clock_timestamp(), clock_timestamp() - interval '6 minutes'
);
insert into storage.objects(bucket_id, name, metadata) values
  ('gallery-previews', '45454545-0000-4000-8000-000000000003/45454545-0000-4000-8000-000000000004/45454545-0000-4000-8000-000000000005.webp', '{"size":50,"mimetype":"image/webp"}'::jsonb);
update public.photos set storage_delete_absent_at = clock_timestamp() - interval '6 minutes'
  where id = '45454545-0000-4000-8000-000000000005';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(public.finish_r2_photo_deletion_worker('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000005'),
  false, 'R2 finalizer still requires Supabase derivatives to be removed');
select is(public.finish_r2_photo_deletion_worker('45454545-0000-4000-8000-000000000003', '45454545-0000-4000-8000-000000000004', '45454545-0000-4000-8000-000000000006'),
  true, 'R2 finalizer removes metadata only after a sustained absence and derivative cleanup');
select is((select count(*)::integer from public.photos where id = '45454545-0000-4000-8000-000000000006'),
  0, 'Completed R2 deletion removes the photo metadata');
select is((select count(*)::integer from public.photos where id = '45454545-0000-4000-8000-000000000005'),
  1, 'The photo with a remaining derivative stays in the deletion queue');

select * from finish();
rollback;

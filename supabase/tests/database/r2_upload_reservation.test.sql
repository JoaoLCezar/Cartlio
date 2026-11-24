begin;
select no_plan();

select ok(not has_function_privilege('authenticated',
  'public.reserve_r2_photo_upload(uuid,uuid,uuid,uuid,text,text,bigint)', 'EXECUTE'),
  'Browser sessions cannot create R2 reservations directly');
select ok(not has_function_privilege('anon',
  'public.reserve_r2_photo_upload(uuid,uuid,uuid,uuid,text,text,bigint)', 'EXECUTE'),
  'Anonymous callers cannot create R2 reservations');

insert into auth.users (id, instance_id, aud, role, email) values
  ('36363636-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2-reserve-owner@quadrics.test'),
  ('36363636-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2-reserve-outsider@quadrics.test');
insert into public.tenants (id, slug, name, created_by) values
  ('36363636-0000-4000-8000-000000000003', 'r2-reserve-tests', 'R2 reservation', '36363636-0000-4000-8000-000000000001');
insert into public.tenant_members (tenant_id, user_id, role) values
  ('36363636-0000-4000-8000-000000000003', '36363636-0000-4000-8000-000000000001', 'owner');
insert into public.galleries (id, tenant_id, title, slug) values
  ('36363636-0000-4000-8000-000000000004', '36363636-0000-4000-8000-000000000003', 'Reservation', 'reservation');

create function pg_temp.reserve_r2(
  p_upload_id uuid,
  p_actor_id uuid default '36363636-0000-4000-8000-000000000001',
  p_filename text default 'photo.png',
  p_content_type text default 'image/png',
  p_byte_size bigint default 128
) returns public.upload_sessions language sql as $$
  select public.reserve_r2_photo_upload(
    p_actor_id, '36363636-0000-4000-8000-000000000003', '36363636-0000-4000-8000-000000000004',
    p_upload_id, p_filename, p_content_type, p_byte_size
  );
$$;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is((pg_temp.reserve_r2('36363636-0000-4000-8000-000000000005')).storage_provider,
  'r2', 'The server creates a provider-tagged R2 reservation');
select is((pg_temp.reserve_r2('36363636-0000-4000-8000-000000000005')).id,
  '36363636-0000-4000-8000-000000000005'::uuid, 'Retrying the same reservation is idempotent');
select is((select object_path from public.upload_sessions where id = '36363636-0000-4000-8000-000000000005'),
  '36363636-0000-4000-8000-000000000003/36363636-0000-4000-8000-000000000004/36363636-0000-4000-8000-000000000005.png',
  'The stored key is derived from the authorized workspace, gallery, and reservation IDs');
select is((select reserved_bytes from public.upload_sessions where id = '36363636-0000-4000-8000-000000000005'),
  52428800::bigint, 'The reservation holds the maximum original size against quota');
select throws_ok($$select pg_temp.reserve_r2('36363636-0000-4000-8000-000000000005',
  '36363636-0000-4000-8000-000000000002')$$, '42501', 'UPLOAD_CONFIRMATION_DENIED',
  'The server cannot reserve storage for a nonmember');
select throws_ok($$select pg_temp.reserve_r2('36363636-0000-4000-8000-000000000005',
  '36363636-0000-4000-8000-000000000001', 'different.png')$$, '22023', 'UPLOAD_ID_CONFLICT',
  'A reservation ID cannot be reused with different metadata');
select throws_ok($$select pg_temp.reserve_r2('36363636-0000-4000-8000-000000000006',
  '36363636-0000-4000-8000-000000000001', 'bad.gif', 'image/gif')$$, '22023', 'UPLOAD_INVALID',
  'Unsupported media types are rejected before reserving quota');

update public.tenants set storage_limit_bytes = 104857600 where id = '36363636-0000-4000-8000-000000000003';
select lives_ok($$select pg_temp.reserve_r2('36363636-0000-4000-8000-000000000006')$$,
  'A second R2 upload can reserve an available slot');
select throws_ok($$select pg_temp.reserve_r2('36363636-0000-4000-8000-000000000007')$$,
  'P0001', 'STORAGE_QUOTA_EXCEEDED', 'R2 reservations share the workspace quota with all providers');

reset role;
update public.galleries set status = 'archived' where id = '36363636-0000-4000-8000-000000000004';
set local role service_role;
select throws_ok($$select pg_temp.reserve_r2('36363636-0000-4000-8000-000000000008')$$,
  'P0001', 'GALLERY_ARCHIVED', 'An archived gallery cannot accept a new R2 reservation');

select * from finish();
rollback;

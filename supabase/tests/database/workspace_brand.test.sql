begin;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at) values
  ('66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'brand-owner@cartlio.test', '', now()),
  ('66666666-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'brand-editor@cartlio.test', '', now());

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('test.brand_workspace', public.create_workspace('Estúdio da Aurora', 'brand-owner')::text, true);
select is((select brand_color from public.tenants where id = current_setting('test.brand_workspace')::uuid), '#c7a67a', 'Workspace receives a safe default brand color');
select is(public.set_tenant_public_brand(current_setting('test.brand_workspace')::uuid, 'Aurora Fotografia', '#4A8068'), true, 'Owner can save public studio branding');
select is((select public_brand_name from public.tenants where id = current_setting('test.brand_workspace')::uuid), 'Aurora Fotografia', 'Public brand name is stored');
select is((select brand_color from public.tenants where id = current_setting('test.brand_workspace')::uuid), '#4a8068', 'Brand color is normalized');
select is(public.set_tenant_brand_logo(
  current_setting('test.brand_workspace')::uuid,
  current_setting('test.brand_workspace') || '/77777777-7777-4777-8777-777777777777.webp'
), true, 'Owner can save a workspace logo path');
select is((select brand_logo_path from public.tenants where id = current_setting('test.brand_workspace')::uuid),
  current_setting('test.brand_workspace') || '/77777777-7777-4777-8777-777777777777.webp', 'Logo path is scoped to its workspace');
select throws_ok($$select public.set_tenant_brand_logo(current_setting('test.brand_workspace')::uuid, 'other-tenant/logo.webp')$$,
  '22023', 'BRAND_LOGO_PATH_INVALID', 'Database rejects logo paths outside their workspace');
select throws_ok($$select public.set_tenant_public_brand(current_setting('test.brand_workspace')::uuid, 'Aurora', 'gold')$$, '22023', 'BRAND_COLOR_INVALID', 'Only a six-digit hexadecimal color is accepted');
select throws_ok($$select public.set_tenant_public_brand(current_setting('test.brand_workspace')::uuid, repeat('x', 121), '#4a8068')$$, '22023', 'BRAND_NAME_INVALID', 'Brand name length is bounded in the database');

reset role;
insert into public.tenant_members (tenant_id, user_id, role)
  values (current_setting('test.brand_workspace')::uuid, '66666666-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'editor');
set local role authenticated;
select set_config('request.jwt.claim.sub', '66666666-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select throws_ok($$select public.set_tenant_public_brand(current_setting('test.brand_workspace')::uuid, 'Forjado', '#111111')$$, '42501', 'BRAND_UPDATE_DENIED', 'Editor cannot alter workspace brand');
select throws_ok($$select public.set_tenant_brand_logo(current_setting('test.brand_workspace')::uuid, null)$$, '42501', 'BRAND_UPDATE_DENIED', 'Editor cannot alter workspace logo');

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select throws_ok($$select public.set_tenant_public_brand(current_setting('test.brand_workspace')::uuid, 'Forjado', '#111111')$$, '42501', null, 'Anonymous visitor cannot call the branding mutation');
select throws_ok($$select public.set_tenant_brand_logo(current_setting('test.brand_workspace')::uuid, null)$$, '42501', null, 'Anonymous visitor cannot change workspace logo');

select * from finish();
rollback;

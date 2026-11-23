begin;

select plan(12);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('cccccccc-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@transfer.test', '', now()),
  ('cccccccc-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'editor@transfer.test', '', now()),
  ('cccccccc-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@transfer.test', '', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-000000000001","role":"authenticated","email":"owner@transfer.test"}', true);
select set_config('test.workspace_id', public.create_workspace('Transferência de teste', 'equipe-transfer-test')::text, true);

reset role;
insert into public.tenant_members (tenant_id, user_id, role)
values (current_setting('test.workspace_id')::uuid, 'cccccccc-0000-4000-8000-000000000002', 'editor');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-000000000001","role":"authenticated","email":"owner@transfer.test"}', true);
select throws_ok($$select public.transfer_workspace_ownership(current_setting('test.workspace_id')::uuid,
  'cccccccc-0000-4000-8000-000000000003')$$,
  '22023', 'WORKSPACE_TRANSFER_TARGET_NOT_EDITOR', 'Owner cannot transfer ownership to a non-member');
select throws_ok($$select public.transfer_workspace_ownership(current_setting('test.workspace_id')::uuid,
  'cccccccc-0000-4000-8000-000000000001')$$,
  '22023', 'WORKSPACE_TRANSFER_TARGET_INVALID', 'Owner cannot transfer ownership to themselves');

select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-000000000002","role":"authenticated","email":"editor@transfer.test"}', true);
select throws_ok($$select public.transfer_workspace_ownership(current_setting('test.workspace_id')::uuid,
  'cccccccc-0000-4000-8000-000000000003')$$,
  '42501', 'Workspace ownership transfer denied', 'Editor cannot transfer ownership');

select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-000000000001","role":"authenticated","email":"owner@transfer.test"}', true);
select is(public.transfer_workspace_ownership(current_setting('test.workspace_id')::uuid,
  'cccccccc-0000-4000-8000-000000000002'), true, 'Owner can transfer ownership to an existing editor');
select is((select role::text from public.tenant_members where tenant_id = current_setting('test.workspace_id')::uuid
  and user_id = 'cccccccc-0000-4000-8000-000000000002'), 'owner', 'Selected editor becomes the owner');
select is((select role::text from public.tenant_members where tenant_id = current_setting('test.workspace_id')::uuid
  and user_id = 'cccccccc-0000-4000-8000-000000000001'), 'editor', 'Previous owner becomes an editor');

select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-000000000002","role":"authenticated","email":"editor@transfer.test"}', true);
select is((select count(*)::int from public.list_workspace_members(current_setting('test.workspace_id')::uuid)), 2,
  'New owner receives the team management permissions');

select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-000000000001","role":"authenticated","email":"owner@transfer.test"}', true);
select throws_ok($$select * from public.list_workspace_members(current_setting('test.workspace_id')::uuid)$$,
  '42501', 'Workspace member management denied', 'Previous owner can no longer manage the team');
select throws_ok($$select public.transfer_workspace_ownership(current_setting('test.workspace_id')::uuid,
  'cccccccc-0000-4000-8000-000000000002')$$,
  '42501', 'Workspace ownership transfer denied', 'Previous owner cannot transfer ownership again');
select is((select count(*)::int from public.tenants where id = current_setting('test.workspace_id')::uuid), 1,
  'Previous owner retains workspace access as an editor');

select ok(has_function_privilege('authenticated', 'public.transfer_workspace_ownership(uuid,uuid)', 'EXECUTE'),
  'Authenticated users can call the owner-checked transfer function');
select ok(not has_function_privilege('anon', 'public.transfer_workspace_ownership(uuid,uuid)', 'EXECUTE'),
  'Anonymous users cannot call the transfer function');

select * from finish();
rollback;

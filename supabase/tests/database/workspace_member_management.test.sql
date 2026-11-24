begin;

select plan(15);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'manager@cartlio.test', '', now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collaborator@cartlio.test', '', now());
insert into public.profiles (id, display_name)
values ('bbbbbbbb-0000-4000-8000-000000000002', 'Pessoa Colaboradora');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000001","role":"authenticated","email":"manager@cartlio.test"}', true);
select set_config('test.workspace_id', public.create_workspace('Equipe de teste', 'equipe-membros-test')::text, true);

reset role;
insert into public.tenant_members (tenant_id, user_id, role)
values (current_setting('test.workspace_id')::uuid, 'bbbbbbbb-0000-4000-8000-000000000002', 'editor');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000001","role":"authenticated","email":"manager@cartlio.test"}', true);
select is((select count(*)::int from public.list_workspace_members(current_setting('test.workspace_id')::uuid)), 2,
  'Owner can list all workspace members');
select is((select member_display_name from public.list_workspace_members(current_setting('test.workspace_id')::uuid)
  where member_user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 'Pessoa Colaboradora',
  'Owner can see a collaborator display name');
select is((select member_email from public.list_workspace_members(current_setting('test.workspace_id')::uuid)
  where member_user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 'collaborator@cartlio.test',
  'Owner can see a collaborator email');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated","email":"collaborator@cartlio.test"}', true);
select throws_ok($$select * from public.list_workspace_members(current_setting('test.workspace_id')::uuid)$$,
  '42501', 'Workspace member management denied', 'Editor cannot list workspace members');
select throws_ok($$select public.remove_workspace_member(current_setting('test.workspace_id')::uuid,
  'bbbbbbbb-0000-4000-8000-000000000001')$$,
  '42501', 'Workspace member management denied', 'Editor cannot remove the owner');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000001","role":"authenticated","email":"manager@cartlio.test"}', true);
select throws_ok($$select public.remove_workspace_member(current_setting('test.workspace_id')::uuid,
  'bbbbbbbb-0000-4000-8000-000000000001')$$,
  '42501', 'WORKSPACE_OWNER_REMOVAL_DENIED', 'Owner cannot remove their own access');
select is(public.remove_workspace_member(current_setting('test.workspace_id')::uuid,
  'bbbbbbbb-0000-4000-8000-000000000002'), true, 'Owner can remove a collaborator');
select is(public.remove_workspace_member(current_setting('test.workspace_id')::uuid,
  'bbbbbbbb-0000-4000-8000-000000000002'), false, 'Removing an already-removed collaborator is a safe no-op');
select is((select count(*)::int from public.list_workspace_members(current_setting('test.workspace_id')::uuid)), 1,
  'Removed collaborator no longer appears in the team list');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated","email":"collaborator@cartlio.test"}', true);
select is((select count(*)::int from public.tenants where id = current_setting('test.workspace_id')::uuid), 0,
  'Removed collaborator immediately loses workspace access');
select is((select count(*)::int from public.tenant_members where tenant_id = current_setting('test.workspace_id')::uuid), 0,
  'Removed collaborator can no longer read workspace membership');

select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000001","role":"authenticated","email":"manager@cartlio.test"}', true);
select is((select role::text from public.tenant_members where tenant_id = current_setting('test.workspace_id')::uuid
  and user_id = auth.uid()), 'owner', 'Owner membership remains intact after collaborator removal');
select ok(has_function_privilege('authenticated', 'public.list_workspace_members(uuid)', 'EXECUTE'),
  'Authenticated users can call the owner-checked member list');
select ok(not has_function_privilege('anon', 'public.list_workspace_members(uuid)', 'EXECUTE'),
  'Anonymous users cannot call the member list');
select ok(not has_function_privilege('anon', 'public.remove_workspace_member(uuid,uuid)', 'EXECUTE'),
  'Anonymous users cannot call the removal function');

select * from finish();
rollback;

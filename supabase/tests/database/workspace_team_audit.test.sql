begin;

select plan(23);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('dddddddd-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@audit.test', '', now()),
  ('dddddddd-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'editor@audit.test', '', now()),
  ('dddddddd-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000000', 'authenticated', 'authenticated', 'next-owner@audit.test', '', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000001","role":"authenticated","email":"owner@audit.test"}', true);
select set_config('test.workspace_id', public.create_workspace('Auditoria de teste', 'equipe-auditoria-test')::text, true);

reset role;
insert into public.tenant_members (tenant_id, user_id, role)
values (current_setting('test.workspace_id')::uuid, 'dddddddd-0000-4000-8000-000000000002', 'editor');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000001","role":"authenticated","email":"owner@audit.test"}', true);
select is((select count(*)::int from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)), 2,
  'Owner sees workspace creation and collaborator join events');
select is((select event_type from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  where event_type = 'workspace_created' limit 1), 'workspace_created', 'Workspace creation is recorded');
select is((select actor_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  where event_type = 'workspace_created' limit 1), 'owner@audit.test', 'Workspace creator is recorded');
select is((select subject_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  where event_type = 'member_joined' limit 1), 'editor@audit.test', 'Joined collaborator is recorded');

select set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000002","role":"authenticated","email":"editor@audit.test"}', true);
select throws_ok($$select * from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)$$,
  '42501', 'Workspace team activity denied', 'Editor cannot read team activity');

select set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000001","role":"authenticated","email":"owner@audit.test"}', true);
select count(*)::int from public.create_workspace_invitation(current_setting('test.workspace_id')::uuid, 'pending@audit.test');
select is((select event_type from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'invitation_created', 'Invitation creation is recorded');
select is((select invited_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'pending@audit.test', 'Invitation history shows its invited address');
select count(*)::int from public.create_workspace_invitation(current_setting('test.workspace_id')::uuid, 'pending@audit.test');
select is((select event_type from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'invitation_reissued', 'Invitation reissue is recorded');
select is((select invited_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'pending@audit.test', 'Reissued invitation history retains the invited address');
select set_config('test.invitation_id', i.invitation_id::text, true)
from public.list_workspace_invitations(current_setting('test.workspace_id')::uuid) i
where i.invited_email = 'pending@audit.test';
select is(public.revoke_workspace_invitation(current_setting('test.workspace_id')::uuid,
  current_setting('test.invitation_id')::uuid), true, 'Owner can revoke invitation for audit verification');
select is((select event_type from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'invitation_revoked', 'Invitation revocation is recorded');
select is((select invited_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'pending@audit.test', 'Revocation history shows its invited address');
select is((select actor_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'owner@audit.test', 'Invitation history records its actor');

select is(public.remove_workspace_member(current_setting('test.workspace_id')::uuid,
  'dddddddd-0000-4000-8000-000000000002'), true, 'Owner can remove collaborator for audit verification');
select is((select event_type from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'member_removed', 'Collaborator removal is recorded');
select is((select actor_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'owner@audit.test', 'Member removal records its actor');
select is((select subject_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'editor@audit.test', 'Member removal records its subject');

reset role;
insert into public.tenant_members (tenant_id, user_id, role)
values (current_setting('test.workspace_id')::uuid, 'dddddddd-0000-4000-8000-000000000003', 'editor');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000001","role":"authenticated","email":"owner@audit.test"}', true);
select is(public.transfer_workspace_ownership(current_setting('test.workspace_id')::uuid,
  'dddddddd-0000-4000-8000-000000000003'), true, 'Owner can transfer workspace to test the activity history');
select set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000003","role":"authenticated","email":"next-owner@audit.test"}', true);
select is((select event_type from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'ownership_transferred', 'Ownership transfer is recorded');
select is((select actor_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'owner@audit.test', 'Ownership transfer records the former owner');
select is((select subject_email from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)
  order by event_id desc limit 1), 'next-owner@audit.test', 'Ownership transfer records the new owner');

select set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-4000-8000-000000000003","role":"authenticated","email":"next-owner@audit.test"}', true);
select is((select count(*)::int from public.list_workspace_team_activity(current_setting('test.workspace_id')::uuid)), 8,
  'New owner can read the activity history');
select ok(not has_function_privilege('anon', 'public.list_workspace_team_activity(uuid)', 'EXECUTE'),
  'Anonymous users cannot read team activity');

select * from finish();
rollback;

begin;

select plan(19);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@cartlio.test', '', now()),
  ('aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'editor@cartlio.test', '', now()),
  ('aaaaaaaa-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'invitee@cartlio.test', '', now()),
  ('aaaaaaaa-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wrong-email@cartlio.test', '', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","email":"owner@cartlio.test"}', true);
select set_config('test.workspace_id', public.create_workspace('Equipe de teste', 'equipe-convite-test')::text, true);

reset role;
insert into public.tenant_members (tenant_id, user_id, role)
values (current_setting('test.workspace_id')::uuid, 'aaaaaaaa-0000-4000-8000-000000000002', 'editor');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","email":"owner@cartlio.test"}', true);
select set_config('test.invitation_token', i.token, true)
from public.create_workspace_invitation(current_setting('test.workspace_id')::uuid, '  Invitee@Cartlio.Test  ') i;

select ok(current_setting('test.invitation_token') ~ '^[0-9a-f]{64}$', 'Owner receives a one-time 256-bit token');
select is(public.get_workspace_invitation(current_setting('test.invitation_token'))->>'email', 'invitee@cartlio.test', 'Token resolves only the normalized invited email');
select is(public.get_workspace_invitation(current_setting('test.invitation_token'))->>'workspace_name', 'Equipe de teste', 'Invitee sees the workspace name attached to the token');
select is((select count(*)::int from public.list_workspace_invitations(current_setting('test.workspace_id')::uuid)), 1, 'Owner sees the pending invite');
select throws_ok($$select * from public.create_workspace_invitation(current_setting('test.workspace_id')::uuid, 'owner@cartlio.test')$$,
  '23505', 'INVITATION_ALREADY_MEMBER', 'Owner cannot invite an existing workspace member');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000002","role":"authenticated","email":"editor@cartlio.test"}', true);
select throws_ok($$select * from public.create_workspace_invitation(current_setting('test.workspace_id')::uuid, 'other@cartlio.test')$$,
  '42501', 'Workspace invitation denied', 'Editor cannot create an invite');
select throws_ok($$select * from public.list_workspace_invitations(current_setting('test.workspace_id')::uuid)$$,
  '42501', 'Workspace invitation denied', 'Editor cannot read pending invites');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000004","role":"authenticated","email":"wrong-email@cartlio.test"}', true);
select throws_ok($$select public.accept_workspace_invitation(current_setting('test.invitation_token'))$$,
  '42501', 'INVITATION_EMAIL_MISMATCH', 'A different account cannot accept the invite');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000003","role":"authenticated","email":"invitee@cartlio.test"}', true);
select is(public.accept_workspace_invitation(current_setting('test.invitation_token')),
  current_setting('test.workspace_id')::uuid, 'Invited user joins the right workspace');
select is((select role::text from public.tenant_members where tenant_id = current_setting('test.workspace_id')::uuid and user_id = auth.uid()),
  'editor', 'Accepted collaborators receive only the editor role');
select throws_ok($$select public.accept_workspace_invitation(current_setting('test.invitation_token'))$$,
  '22023', 'INVITATION_INVALID', 'An invite can be accepted only once');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","email":"owner@cartlio.test"}', true);
select is((select count(*)::int from public.list_workspace_invitations(current_setting('test.workspace_id')::uuid)), 0, 'Accepted invite leaves the pending list');
select set_config('test.revoked_token', i.token, true)
from public.create_workspace_invitation(current_setting('test.workspace_id')::uuid, 'revoke@cartlio.test') i;
select set_config('test.revoked_id', i.invitation_id::text, true)
from public.list_workspace_invitations(current_setting('test.workspace_id')::uuid) i
where i.invited_email = 'revoke@cartlio.test';
select is(public.get_workspace_invitation(current_setting('test.revoked_token'))->>'email', 'revoke@cartlio.test',
  'Another pending invite resolves by its newly issued token');
select is(public.revoke_workspace_invitation(current_setting('test.workspace_id')::uuid,
  current_setting('test.revoked_id')::uuid),
  true, 'Owner can revoke a pending invite');
select is(public.get_workspace_invitation(current_setting('test.revoked_token')), null::jsonb, 'Revoked token no longer resolves');

reset role;
select set_config('test.expired_token', i.token, true)
from public.create_workspace_invitation(current_setting('test.workspace_id')::uuid, 'expired@cartlio.test') i;
update private.workspace_invitations
set expires_at = clock_timestamp() - interval '1 second'
where token_hash = extensions.digest(current_setting('test.expired_token'), 'sha256');
select is(public.get_workspace_invitation(current_setting('test.expired_token')), null::jsonb, 'Expired token no longer resolves');
select is(public.get_workspace_invitation('not-a-token'), null::jsonb, 'Malformed token does not resolve');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000003","role":"authenticated","email":"invitee@cartlio.test"}', true);
select throws_ok($$select public.accept_workspace_invitation(current_setting('test.expired_token'))$$,
  '22023', 'INVITATION_INVALID', 'Expired invite cannot be accepted');

reset role;
set local role anon;
select throws_ok($$select public.accept_workspace_invitation(current_setting('test.revoked_token'))$$,
  '42501', 'permission denied for function accept_workspace_invitation', 'Anonymous visitors cannot accept invites');

select * from finish();
rollback;

alter table private.workspace_team_audit
  add column invitation_id uuid references private.workspace_invitations(id) on delete set null;
alter table private.workspace_team_audit
  drop constraint workspace_team_audit_event_type_check;
alter table private.workspace_team_audit
  add constraint workspace_team_audit_event_type_check check (event_type in (
    'workspace_created', 'member_joined', 'member_removed', 'ownership_transferred',
    'invitation_created', 'invitation_reissued', 'invitation_revoked'
  ));

create function private.record_workspace_invitation_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_event_type text;
begin
  if tg_op = 'INSERT' then
    v_event_type := 'invitation_created';
  elsif tg_op = 'UPDATE' then
    if old.revoked_at is null and new.revoked_at is not null then
      v_event_type := 'invitation_revoked';
    elsif old.token_hash is distinct from new.token_hash then
      v_event_type := 'invitation_reissued';
    end if;
  end if;

  if v_actor_user_id is not null and v_event_type is not null then
    insert into private.workspace_team_audit (
      tenant_id, actor_user_id, event_type, invitation_id
    ) values (
      new.tenant_id, v_actor_user_id, v_event_type, new.id
    );
  end if;

  return new;
end;
$$;
revoke all on function private.record_workspace_invitation_audit() from public, anon, authenticated, service_role;

create trigger workspace_invitations_team_audit
  after insert or update on private.workspace_invitations
  for each row execute function private.record_workspace_invitation_audit();

drop function public.list_workspace_team_activity(uuid);
create function public.list_workspace_team_activity(p_tenant_id uuid)
returns table(
  event_id bigint,
  event_type text,
  actor_user_id uuid,
  actor_email text,
  actor_display_name text,
  subject_user_id uuid,
  subject_email text,
  subject_display_name text,
  happened_at timestamptz,
  invited_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_tenant_owner(p_tenant_id) then
    raise exception 'Workspace team activity denied' using errcode = '42501';
  end if;

  return query
  select e.id, e.event_type, e.actor_user_id, actor.email::text, actor_profile.display_name,
    e.subject_user_id, subject.email::text, subject_profile.display_name, e.created_at, invitation.invited_email
  from private.workspace_team_audit e
  left join auth.users actor on actor.id = e.actor_user_id
  left join public.profiles actor_profile on actor_profile.id = e.actor_user_id
  left join auth.users subject on subject.id = e.subject_user_id
  left join public.profiles subject_profile on subject_profile.id = e.subject_user_id
  left join private.workspace_invitations invitation on invitation.id = e.invitation_id
  where e.tenant_id = p_tenant_id
  order by e.created_at desc, e.id desc
  limit 50;
end;
$$;
revoke all on function public.list_workspace_team_activity(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_team_activity(uuid) to authenticated;

comment on function public.list_workspace_team_activity(uuid) is
  'Lists up to 50 recent membership, invitation, and ownership events for the authenticated workspace owner.';

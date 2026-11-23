create table private.workspace_team_audit (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  subject_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'workspace_created', 'member_joined', 'member_removed', 'ownership_transferred'
  )),
  created_at timestamptz not null default clock_timestamp()
);
create index workspace_team_audit_recent_idx
  on private.workspace_team_audit (tenant_id, created_at desc, id desc);
revoke all on private.workspace_team_audit from public, anon, authenticated, service_role;

create function private.record_workspace_team_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_subject_user_id uuid;
  v_event_type text;
begin
  if tg_op = 'INSERT' then
    v_tenant_id := new.tenant_id;
    v_subject_user_id := new.user_id;
    v_event_type := case when new.role = 'owner' then 'workspace_created' else 'member_joined' end;
  elsif tg_op = 'DELETE' then
    v_tenant_id := old.tenant_id;
    v_subject_user_id := old.user_id;
    if old.role = 'editor' then v_event_type := 'member_removed'; end if;
  elsif tg_op = 'UPDATE' then
    v_tenant_id := new.tenant_id;
    v_subject_user_id := new.user_id;
    if old.role = 'editor' and new.role = 'owner' then v_event_type := 'ownership_transferred'; end if;
  end if;

  -- Auth-driven account deletion and service maintenance have no user actor.
  -- They should not create misleading team activity entries.
  if v_actor_user_id is not null and v_event_type is not null then
    insert into private.workspace_team_audit (tenant_id, actor_user_id, subject_user_id, event_type)
    values (v_tenant_id, v_actor_user_id, v_subject_user_id, v_event_type);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.record_workspace_team_audit() from public, anon, authenticated, service_role;

create trigger tenant_members_team_audit
  after insert or update or delete on public.tenant_members
  for each row execute function private.record_workspace_team_audit();

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
  happened_at timestamptz
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
    e.subject_user_id, subject.email::text, subject_profile.display_name, e.created_at
  from private.workspace_team_audit e
  left join auth.users actor on actor.id = e.actor_user_id
  left join public.profiles actor_profile on actor_profile.id = e.actor_user_id
  left join auth.users subject on subject.id = e.subject_user_id
  left join public.profiles subject_profile on subject_profile.id = e.subject_user_id
  where e.tenant_id = p_tenant_id
  order by e.created_at desc, e.id desc
  limit 50;
end;
$$;
revoke all on function public.list_workspace_team_activity(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_team_activity(uuid) to authenticated;

comment on table private.workspace_team_audit is
  'Private history of workspace creation, collaborator membership changes, and ownership transfers.';
comment on function public.list_workspace_team_activity(uuid) is
  'Lists up to 50 recent team and ownership events for the authenticated workspace owner.';

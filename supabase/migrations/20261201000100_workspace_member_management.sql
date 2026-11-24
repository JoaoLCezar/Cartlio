create function public.list_workspace_members(p_tenant_id uuid)
returns table(
  member_user_id uuid,
  member_email text,
  member_display_name text,
  member_role public.tenant_role,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_tenant_owner(p_tenant_id) then
    raise exception 'Workspace member management denied' using errcode = '42501';
  end if;

  return query
  select m.user_id, u.email::text, p.display_name, m.role, m.created_at
  from public.tenant_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.tenant_id = p_tenant_id
  order by case when m.role = 'owner' then 0 else 1 end, m.created_at, m.user_id;
end;
$$;
revoke all on function public.list_workspace_members(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_members(uuid) to authenticated;

create function public.remove_workspace_member(p_tenant_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_tenant_owner(p_tenant_id) then
    raise exception 'Workspace member management denied' using errcode = '42501';
  end if;

  if p_user_id is null or p_user_id = auth.uid() then
    raise exception 'WORKSPACE_OWNER_REMOVAL_DENIED' using errcode = '42501';
  end if;

  delete from public.tenant_members m
  where m.tenant_id = p_tenant_id and m.user_id = p_user_id and m.role = 'editor';
  return found;
end;
$$;
revoke all on function public.remove_workspace_member(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_workspace_member(uuid, uuid) to authenticated;

comment on function public.list_workspace_members(uuid) is
  'Lists workspace membership details for its authenticated owner only.';
comment on function public.remove_workspace_member(uuid, uuid) is
  'Removes an editor from a workspace; owners cannot remove themselves or other owners.';

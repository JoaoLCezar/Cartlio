create function public.transfer_workspace_ownership(p_tenant_id uuid, p_new_owner_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_owner_user_id uuid := auth.uid();
begin
  if v_current_owner_user_id is null then
    raise exception 'Workspace ownership transfer denied' using errcode = '42501';
  end if;

  perform 1
  from public.tenant_members m
  where m.tenant_id = p_tenant_id
    and m.user_id = v_current_owner_user_id
    and m.role = 'owner'
  for update;
  if not found then
    raise exception 'Workspace ownership transfer denied' using errcode = '42501';
  end if;

  if p_new_owner_user_id is null or p_new_owner_user_id = v_current_owner_user_id then
    raise exception 'WORKSPACE_TRANSFER_TARGET_INVALID' using errcode = '22023';
  end if;

  perform 1
  from public.tenant_members m
  where m.tenant_id = p_tenant_id
    and m.user_id = p_new_owner_user_id
    and m.role = 'editor'
  for update;
  if not found then
    raise exception 'WORKSPACE_TRANSFER_TARGET_NOT_EDITOR' using errcode = '22023';
  end if;

  -- Demote first to satisfy the one-owner partial unique index. Both changes
  -- commit together, so the workspace is never left without an owner.
  update public.tenant_members m
  set role = 'editor'
  where m.tenant_id = p_tenant_id and m.user_id = v_current_owner_user_id and m.role = 'owner';
  update public.tenant_members m
  set role = 'owner'
  where m.tenant_id = p_tenant_id and m.user_id = p_new_owner_user_id and m.role = 'editor';

  return true;
end;
$$;
revoke all on function public.transfer_workspace_ownership(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.transfer_workspace_ownership(uuid, uuid) to authenticated;

comment on function public.transfer_workspace_ownership(uuid, uuid) is
  'Atomically transfers workspace ownership to an existing editor and demotes the previous owner.';

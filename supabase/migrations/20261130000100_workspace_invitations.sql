create table private.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invited_email text not null check (
    char_length(invited_email) between 3 and 254
    and invited_email = lower(btrim(invited_email))
    and invited_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  invited_role public.tenant_role not null default 'editor' check (invited_role = 'editor'),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references auth.users(id) on delete cascade,
  accepted_at timestamptz,
  revoked_at timestamptz
);

create unique index workspace_invitations_pending_email_idx
  on private.workspace_invitations (tenant_id, invited_email)
  where accepted_at is null and revoked_at is null;
create index workspace_invitations_pending_expiry_idx
  on private.workspace_invitations (tenant_id, expires_at)
  where accepted_at is null and revoked_at is null;
revoke all on private.workspace_invitations from public, anon, authenticated, service_role;

create function public.create_workspace_invitation(p_tenant_id uuid, p_email text)
returns table(invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_user_id uuid := auth.uid();
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_invitation_id uuid;
  v_expires_at timestamptz := clock_timestamp() + interval '7 days';
begin
  if v_user_id is null or not private.is_tenant_owner(p_tenant_id) then
    raise exception 'Workspace invitation denied' using errcode = '42501';
  end if;

  if v_email is null or char_length(v_email) not between 3 and 254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid invitation email' using errcode = '22023';
  end if;

  if exists (
    select 1 from auth.users u
    join public.tenant_members m on m.user_id = u.id
    where m.tenant_id = p_tenant_id and lower(u.email) = v_email
  ) then
    raise exception 'INVITATION_ALREADY_MEMBER' using errcode = '23505';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || v_email, 0));

  select i.id into v_invitation_id
  from private.workspace_invitations i
  where i.tenant_id = p_tenant_id and i.invited_email = v_email
    and i.accepted_at is null and i.revoked_at is null
  for update;

  if v_invitation_id is null then
    insert into private.workspace_invitations (
      tenant_id, invited_email, invited_role, token_hash, expires_at, created_by
    ) values (
      p_tenant_id, v_email, 'editor', extensions.digest(v_token, 'sha256'), v_expires_at, v_user_id
    ) returning id into v_invitation_id;
  else
    update private.workspace_invitations i
    set token_hash = extensions.digest(v_token, 'sha256'), expires_at = v_expires_at,
        created_at = clock_timestamp(), created_by = v_user_id
    where i.id = v_invitation_id;
  end if;

  return query select v_invitation_id, v_token, v_expires_at;
end;
$$;
revoke all on function public.create_workspace_invitation(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.create_workspace_invitation(uuid, text) to authenticated;

create function public.list_workspace_invitations(p_tenant_id uuid)
returns table(invitation_id uuid, invited_email text, invited_role public.tenant_role, expires_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_tenant_owner(p_tenant_id) then
    raise exception 'Workspace invitation denied' using errcode = '42501';
  end if;

  return query
  select i.id, i.invited_email, i.invited_role, i.expires_at, i.created_at
  from private.workspace_invitations i
  where i.tenant_id = p_tenant_id and i.accepted_at is null and i.revoked_at is null
    and i.expires_at > statement_timestamp()
  order by i.created_at desc, i.id;
end;
$$;
revoke all on function public.list_workspace_invitations(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_invitations(uuid) to authenticated;

create function public.revoke_workspace_invitation(p_tenant_id uuid, p_invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_tenant_owner(p_tenant_id) then
    raise exception 'Workspace invitation denied' using errcode = '42501';
  end if;

  update private.workspace_invitations i
  set revoked_at = clock_timestamp()
  where i.id = p_invitation_id and i.tenant_id = p_tenant_id
    and i.accepted_at is null and i.revoked_at is null;
  return found;
end;
$$;
revoke all on function public.revoke_workspace_invitation(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.revoke_workspace_invitation(uuid, uuid) to authenticated;

create function public.get_workspace_invitation(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email', i.invited_email,
    'role', i.invited_role,
    'workspace_name', t.name,
    'expires_at', i.expires_at
  )
  from private.workspace_invitations i
  join public.tenants t on t.id = i.tenant_id
  where p_token ~ '^[0-9a-f]{64}$'
    and i.token_hash = extensions.digest(p_token, 'sha256')
    and i.accepted_at is null and i.revoked_at is null
    and i.expires_at > statement_timestamp();
$$;
revoke all on function public.get_workspace_invitation(text) from public, anon, authenticated, service_role;
grant execute on function public.get_workspace_invitation(text) to anon, authenticated;

create function public.accept_workspace_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_email_confirmed_at timestamptz;
  v_invitation private.workspace_invitations%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'INVITATION_INVALID' using errcode = '22023';
  end if;

  select i.* into v_invitation
  from private.workspace_invitations i
  where i.token_hash = extensions.digest(p_token, 'sha256')
    and i.accepted_at is null and i.revoked_at is null
    and i.expires_at > clock_timestamp()
  for update;
  if not found then
    raise exception 'INVITATION_INVALID' using errcode = '22023';
  end if;

  select lower(u.email), u.email_confirmed_at into v_email, v_email_confirmed_at
  from auth.users u where u.id = v_user_id;
  if v_email is null or v_email <> v_invitation.invited_email or v_email_confirmed_at is null then
    raise exception 'INVITATION_EMAIL_MISMATCH' using errcode = '42501';
  end if;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_invitation.tenant_id, v_user_id, v_invitation.invited_role);

  update private.workspace_invitations i
  set accepted_at = clock_timestamp()
  where i.id = v_invitation.id;

  return v_invitation.tenant_id;
end;
$$;
revoke all on function public.accept_workspace_invitation(text) from public, anon, authenticated, service_role;
grant execute on function public.accept_workspace_invitation(text) to authenticated;

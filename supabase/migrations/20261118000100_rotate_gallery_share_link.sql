alter table public.gallery_shares
  add column last_rotated_at timestamptz;

grant select (last_rotated_at) on public.gallery_shares to authenticated;

create function public.rotate_gallery_share(
  p_tenant_id uuid,
  p_gallery_id uuid,
  p_share_id uuid,
  p_expires_at timestamptz
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
  v_share public.gallery_shares%rowtype;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'SHARE_ROTATION_DENIED' using errcode = '42501';
  end if;
  if p_expires_at is null or p_expires_at < clock_timestamp() + interval '1 hour'
    or p_expires_at > clock_timestamp() + interval '30 days' then
    raise exception 'SHARE_EXPIRY_INVALID' using errcode = '22023';
  end if;

  perform 1 from public.galleries
    where tenant_id = p_tenant_id and id = p_gallery_id and status = 'published' for update;
  if not found then raise exception 'SHARE_ROTATION_DENIED' using errcode = '42501'; end if;

  select * into v_share from public.gallery_shares
    where id = p_share_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id
    for update;
  if not found or v_share.revoked_at is not null then
    raise exception 'SHARE_ROTATION_DENIED' using errcode = '42501';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  update public.gallery_shares set
    token_hash = extensions.digest(v_token, 'sha256'),
    expires_at = p_expires_at,
    last_rotated_at = clock_timestamp()
    where id = v_share.id;

  -- A session belongs to the share row, so rotation must revoke it as well.
  delete from public.gallery_share_pin_sessions where share_id = v_share.id;
  delete from private.gallery_share_pin_attempts where share_id = v_share.id;
  return v_token;
end;
$$;

revoke all on function public.rotate_gallery_share(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.rotate_gallery_share(uuid, uuid, uuid, timestamptz)
  to authenticated;

create or replace function public.clear_gallery_selection(
  p_token text,
  p_access_token text default null
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_removed integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'SELECTION_INVALID' using errcode = '22023';
  end if;

  select * into v_share from public.gallery_shares s
    where s.token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries g where g.tenant_id = v_share.tenant_id
      and g.id = v_share.gallery_id and g.status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then
    return -1;
  end if;
  if v_share.share_mode <> 'selection' then
    raise exception 'SELECTION_MODE_DISABLED' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then
    raise exception 'SELECTION_SUBMITTED' using errcode = '42501';
  end if;

  delete from public.gallery_selection_items i where i.share_id = v_share.id;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke all on function public.clear_gallery_selection(text, text) from public, anon, authenticated;
grant execute on function public.clear_gallery_selection(text, text) to anon, authenticated;

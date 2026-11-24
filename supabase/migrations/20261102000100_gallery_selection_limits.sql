alter table public.gallery_shares
  add column selection_limit integer not null default 500
  check (selection_limit between 1 and 500);
grant select (selection_limit) on public.gallery_shares to authenticated;

create function public.create_gallery_share(
  p_tenant_id uuid,
  p_gallery_id uuid,
  p_expires_at timestamptz,
  p_selection_limit integer
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id
      and id = p_gallery_id and status = 'published') then
    raise exception 'Gallery sharing denied' using errcode = '42501';
  end if;
  if p_expires_at is null or p_expires_at < clock_timestamp() + interval '1 hour'
    or p_expires_at > clock_timestamp() + interval '30 days' then
    raise exception 'SHARE_EXPIRY_INVALID' using errcode = '22023';
  end if;
  if p_selection_limit is null or p_selection_limit not between 1 and 500 then
    raise exception 'SELECTION_LIMIT_INVALID' using errcode = '22023';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.gallery_shares (tenant_id, gallery_id, token_hash, expires_at, created_by, selection_limit)
    values (p_tenant_id, p_gallery_id, extensions.digest(v_token, 'sha256'), p_expires_at, auth.uid(), p_selection_limit);
  return v_token;
end;
$$;

create or replace function public.set_gallery_selection(p_token text, p_photo_id uuid, p_selected boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_share public.gallery_shares%rowtype; v_photo public.photos%rowtype; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null or p_selected is null then
    raise exception 'SELECTION_INVALID' using errcode = '22023';
  end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then raise exception 'SELECTION_SUBMITTED' using errcode = '42501'; end if;
  if p_selected then
    select * into v_photo from public.photos where tenant_id = v_share.tenant_id
      and gallery_id = v_share.gallery_id and id = p_photo_id
      and processing_status = 'ready' and deletion_requested_at is null;
    if not found then raise exception 'PHOTO_NOT_SELECTABLE' using errcode = '42501'; end if;
    select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
    if v_count >= v_share.selection_limit and not exists (select 1 from public.gallery_selection_items
      where share_id = v_share.id and photo_id = p_photo_id) then
      raise exception 'SELECTION_LIMIT' using errcode = '22023';
    end if;
    insert into public.gallery_selection_items (share_id, photo_id, original_filename)
      values (v_share.id, v_photo.id, v_photo.original_filename) on conflict do nothing;
  else
    delete from public.gallery_selection_items where share_id = v_share.id and photo_id = p_photo_id;
  end if;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return v_count;
end;
$$;

create or replace function public.get_shared_gallery(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gallery public.galleries%rowtype; v_share public.gallery_shares%rowtype; v_photos jsonb; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256')
      and revoked_at is null and expires_at > clock_timestamp();
  if not found then return null; end if;
  select * into v_gallery from public.galleries where tenant_id = v_share.tenant_id
    and id = v_share.gallery_id and status = 'published';
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.original_filename,
    'selected', exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id))
    order by p.created_at, p.id), '[]'::jsonb)
    into v_photos from public.photos p where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
    and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'selected_count', v_count, 'selection_limit', v_share.selection_limit,
    'submitted_at', v_share.submitted_at, 'downloads_enabled', v_share.downloads_enabled);
end;
$$;

revoke all on function public.create_gallery_share(uuid, uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.create_gallery_share(uuid, uuid, timestamptz, integer) to authenticated;

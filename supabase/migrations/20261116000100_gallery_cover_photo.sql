alter table public.galleries
  add column cover_photo_id uuid references public.photos(id) on delete set null;

comment on column public.galleries.cover_photo_id is
  'Optional ready photo selected as the public gallery cover; null uses the first ready photo in gallery order.';

create function public.set_gallery_cover_photo(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'GALLERY_COVER_DENIED' using errcode = '42501';
  end if;

  perform 1 from public.galleries
    where tenant_id = p_tenant_id and id = p_gallery_id for update;
  if not found then raise exception 'GALLERY_COVER_DENIED' using errcode = '42501'; end if;

  if p_photo_id is not null and not exists (
    select 1 from public.photos p
    where p.id = p_photo_id and p.tenant_id = p_tenant_id and p.gallery_id = p_gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
  ) then
    raise exception 'GALLERY_COVER_PHOTO_INVALID' using errcode = '22023';
  end if;

  update public.galleries set cover_photo_id = p_photo_id
    where tenant_id = p_tenant_id and id = p_gallery_id;
  return true;
end;
$$;

revoke all on function public.set_gallery_cover_photo(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_gallery_cover_photo(uuid, uuid, uuid) to authenticated;

create or replace function public.get_shared_gallery(p_token text, p_access_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_gallery public.galleries%rowtype;
  v_share public.gallery_shares%rowtype;
  v_photos jsonb;
  v_cover_photo_id uuid;
  v_count integer;
  v_brand_name text;
  v_brand_color text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256')
      and revoked_at is null and expires_at > clock_timestamp();
  if not found then return null; end if;
  select * into v_gallery from public.galleries where tenant_id = v_share.tenant_id
    and id = v_share.gallery_id and status = 'published';
  if not found then return null; end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then
    return jsonb_build_object('pin_required', true);
  end if;

  select coalesce(nullif(btrim(t.public_brand_name), ''), 'Cartlio'), t.brand_color
    into v_brand_name, v_brand_color
    from public.tenants t where t.id = v_share.tenant_id;
  select p.id into v_cover_photo_id from public.photos p
    where p.id = v_gallery.cover_photo_id and p.tenant_id = v_share.tenant_id
      and p.gallery_id = v_share.gallery_id and p.processing_status = 'ready'
      and p.deletion_requested_at is null;
  if v_cover_photo_id is null then
    select p.id into v_cover_photo_id from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
      order by p.sort_order, p.created_at desc, p.id limit 1;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.original_filename,
    'selected', exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id))
    order by p.sort_order, p.created_at desc, p.id), '[]'::jsonb)
    into v_photos from public.photos p where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'cover_photo_id', v_cover_photo_id, 'selected_count', v_count, 'selection_limit', v_share.selection_limit,
    'submitted_at', v_share.submitted_at, 'downloads_enabled', v_share.downloads_enabled,
    'share_mode', v_share.share_mode, 'brand_name', v_brand_name, 'brand_color', v_brand_color);
end;
$$;
revoke all on function public.get_shared_gallery(text, text) from public, anon, authenticated;
grant execute on function public.get_shared_gallery(text, text) to anon, authenticated;

create function public.workspace_gallery_cover_photos(p_tenant_id uuid, p_gallery_ids uuid[])
returns table(gallery_id uuid, photo_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  if p_gallery_ids is null or cardinality(p_gallery_ids) = 0 then return; end if;
  if cardinality(p_gallery_ids) > 100 then
    raise exception 'GALLERY_COVER_REQUEST_INVALID' using errcode = '22023';
  end if;

  return query
  select g.id, coalesce(selected_cover.photo_id, first_ready.photo_id)
  from public.galleries g
  left join lateral (
    select p.id as photo_id
    from public.photos p
    where p.id = g.cover_photo_id and p.tenant_id = g.tenant_id and p.gallery_id = g.id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
    limit 1
  ) selected_cover on true
  left join lateral (
    select p.id as photo_id
    from public.photos p
    where p.tenant_id = g.tenant_id and p.gallery_id = g.id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
    order by p.sort_order, p.created_at desc, p.id
    limit 1
  ) first_ready on selected_cover.photo_id is null
  where g.tenant_id = p_tenant_id and g.id = any(p_gallery_ids);
end;
$$;

revoke all on function public.workspace_gallery_cover_photos(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.workspace_gallery_cover_photos(uuid, uuid[]) to authenticated;

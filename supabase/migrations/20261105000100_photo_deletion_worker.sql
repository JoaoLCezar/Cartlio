create index photos_deletion_queue_idx on public.photos(deletion_requested_at, id)
  where deletion_requested_at is not null;

create function public.finish_photo_deletion_worker(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype; v_derived_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Worker access denied' using errcode = '42501';
  end if;
  select * into v_photo from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id for update;
  if not found then return true; end if;
  if v_photo.deletion_requested_at is null then return false; end if;
  v_derived_path := p_tenant_id::text || '/' || p_gallery_id::text || '/' || p_photo_id::text || '.webp';
  if exists (select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_photo.object_path)
    or exists (select 1 from storage.objects where bucket_id in ('gallery-previews', 'gallery-thumbnails')
      and name = v_derived_path) then return false; end if;
  delete from public.photos where id = p_photo_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return true;
end;
$$;

revoke all on function public.finish_photo_deletion_worker(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finish_photo_deletion_worker(uuid, uuid, uuid) to service_role;

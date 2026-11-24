-- Persist intent before touching Storage. A failed/abandoned client can resume.
alter table public.photos add column deletion_requested_at timestamptz;
revoke delete on public.photos from authenticated;
drop policy photos_delete_member on public.photos;

-- These narrow functions need elevated privileges because callers cannot update
-- lifecycle columns or delete rows directly. Every call checks session + scope.
create function public.begin_photo_deletion(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id and id = p_gallery_id) then
    raise exception 'Gallery access denied' using errcode = '42501';
  end if;

  update public.photos
    set deletion_requested_at = coalesce(deletion_requested_at, now())
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id
    returning object_path into v_path;
  return v_path; -- Missing photo: already complete or outside the requested scope.
end;
$$;

create function public.finish_photo_deletion(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id and id = p_gallery_id) then
    raise exception 'Gallery access denied' using errcode = '42501';
  end if;

  select * into v_photo from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id
    for update;
  if not found then return true; end if;
  if v_photo.deletion_requested_at is null then return false; end if;
  -- Storage records are read-only here. Only the Storage API removes the file.
  if exists (select 1 from storage.objects
    where bucket_id = 'gallery-originals' and name = v_photo.object_path) then
    return false;
  end if;

  delete from public.photos where id = v_photo.id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return true;
end;
$$;

revoke all on function public.begin_photo_deletion(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_photo_deletion(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_photo_deletion(uuid, uuid, uuid) to authenticated;
grant execute on function public.finish_photo_deletion(uuid, uuid, uuid) to authenticated;

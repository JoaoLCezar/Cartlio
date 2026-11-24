alter table public.photos
  add column storage_delete_absent_at timestamptz,
  add constraint photos_storage_delete_absent_provider_check check (
    storage_delete_absent_at is null or (storage_provider = 'r2' and deletion_requested_at is not null)
  );

create or replace function public.finish_photo_deletion(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype; v_derived_path text;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id and id = p_gallery_id) then
    raise exception 'Gallery access denied' using errcode = '42501';
  end if;
  select * into v_photo from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id for update;
  if not found then return true; end if;
  if v_photo.deletion_requested_at is null or v_photo.storage_provider <> 'supabase' then return false; end if;
  v_derived_path := p_tenant_id::text || '/' || p_gallery_id::text || '/' || p_photo_id::text || '.webp';
  if exists (select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_photo.object_path)
    or exists (select 1 from storage.objects where bucket_id in ('gallery-previews', 'gallery-thumbnails')
      and name = v_derived_path) then return false; end if;
  delete from public.photos where id = p_photo_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return true;
end;
$$;

create or replace function public.finish_photo_deletion_worker(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype; v_derived_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Worker access denied' using errcode = '42501';
  end if;
  select * into v_photo from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id for update;
  if not found then return true; end if;
  if v_photo.deletion_requested_at is null or v_photo.storage_provider <> 'supabase' then return false; end if;
  v_derived_path := p_tenant_id::text || '/' || p_gallery_id::text || '/' || p_photo_id::text || '.webp';
  if exists (select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_photo.object_path)
    or exists (select 1 from storage.objects where bucket_id in ('gallery-previews', 'gallery-thumbnails')
      and name = v_derived_path) then return false; end if;
  delete from public.photos where id = p_photo_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return true;
end;
$$;

create function public.record_r2_photo_deletion_absence(
  p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid, p_object_absent boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'R2 deletion access denied' using errcode = '42501';
  end if;
  if p_object_absent is null then raise exception 'R2 deletion state is required' using errcode = '22023'; end if;
  select * into v_photo from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id for update;
  if not found then return true; end if;
  if v_photo.deletion_requested_at is null or v_photo.storage_provider <> 'r2' then return false; end if;
  update public.photos set storage_delete_absent_at = case
    when p_object_absent then coalesce(storage_delete_absent_at, clock_timestamp())
    else null
  end where id = p_photo_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return true;
end;
$$;

create function public.finish_r2_photo_deletion_worker(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype; v_derived_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Worker access denied' using errcode = '42501';
  end if;
  select * into v_photo from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id for update;
  if not found then return true; end if;
  if v_photo.storage_provider <> 'r2' or v_photo.deletion_requested_at is null
    or v_photo.storage_delete_absent_at is null
    or v_photo.storage_delete_absent_at > clock_timestamp() - interval '5 minutes' then return false; end if;
  v_derived_path := p_tenant_id::text || '/' || p_gallery_id::text || '/' || p_photo_id::text || '.webp';
  if exists (select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_photo.object_path)
    or exists (select 1 from storage.objects where bucket_id in ('gallery-previews', 'gallery-thumbnails')
      and name = v_derived_path) then return false; end if;
  delete from public.photos where id = p_photo_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return true;
end;
$$;

revoke all on function public.finish_photo_deletion(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finish_photo_deletion(uuid, uuid, uuid) to authenticated;
revoke all on function public.finish_photo_deletion_worker(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finish_photo_deletion_worker(uuid, uuid, uuid) to service_role;
revoke all on function public.record_r2_photo_deletion_absence(uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.record_r2_photo_deletion_absence(uuid, uuid, uuid, boolean) to service_role;
revoke all on function public.finish_r2_photo_deletion_worker(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.finish_r2_photo_deletion_worker(uuid, uuid, uuid) to service_role;

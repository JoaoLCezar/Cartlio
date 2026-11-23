alter table public.photos add column storage_etag text;
alter table public.photos add constraint photos_storage_etag_check check (
  (storage_provider = 'supabase' and storage_etag is null)
  or (storage_provider = 'r2' and storage_etag is not null and storage_etag ~ '^"[A-Za-z0-9_-]{1,128}"$')
);

-- Only trusted confirmation functions call this helper after taking the
-- workspace and session locks. The ETag is persisted with the new photo.
create function private.finalize_verified_photo_upload(
  p_session public.upload_sessions, p_storage_provider text, p_object_path text,
  p_object_bytes text, p_object_content_type text, p_object_etag text
)
returns uuid language plpgsql set search_path = '' as $$
begin
  if p_storage_provider is distinct from p_session.storage_provider
    or p_object_path is distinct from p_session.object_path
    or p_object_bytes is distinct from p_session.byte_size::text
    or p_object_content_type is distinct from p_session.content_type then
    raise exception 'UPLOAD_MISMATCH';
  end if;

  insert into public.photos (
    id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, storage_provider, storage_etag
  ) values (
    p_session.id, p_session.tenant_id, p_session.gallery_id, p_session.object_path, p_session.original_filename,
    p_session.content_type, p_session.byte_size, p_session.created_by, p_session.storage_provider, p_object_etag
  );
  update public.upload_sessions set state = 'completed' where id = p_session.id;
  return p_session.id;
end;
$$;
revoke all on function private.finalize_verified_photo_upload(public.upload_sessions, text, text, text, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.complete_photo_upload(p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype; v_metadata jsonb;
begin
  perform private.assert_upload_scope(p_tenant_id, p_gallery_id);
  perform 1 from public.tenants where id = p_tenant_id for update;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_session.state = 'completed' then return v_session.id; end if;
  if v_session.state <> 'reserved' or v_session.expires_at <= clock_timestamp() then raise exception 'UPLOAD_CLOSED'; end if;
  if exists (select 1 from public.galleries where id = p_gallery_id and status = 'archived') then raise exception 'GALLERY_ARCHIVED'; end if;
  if v_session.storage_provider <> 'supabase' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;

  select metadata into v_metadata from storage.objects
    where bucket_id = 'gallery-originals' and name = v_session.object_path;
  if not found then raise exception 'UPLOAD_MISSING'; end if;
  return private.finalize_verified_photo_upload(
    v_session, 'supabase', v_session.object_path, v_metadata->>'size', v_metadata->>'mimetype', null
  );
end;
$$;
drop function private.finalize_verified_photo_upload(public.upload_sessions, text, text, text, text);

-- This RPC stays dormant while the provider constraints only allow Supabase.
-- It accepts metadata exclusively from the application's trusted server.
create function public.complete_r2_photo_upload(
  p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid,
  p_object_path text, p_object_bytes bigint, p_object_content_type text, p_object_etag text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'UPLOAD_CONFIRMATION_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.tenants where id = p_tenant_id for update;
  if not exists (select 1 from public.tenant_members where tenant_id = p_tenant_id and user_id = p_actor_id) then
    raise exception 'UPLOAD_CONFIRMATION_DENIED' using errcode = '42501';
  end if;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_session.storage_provider <> 'r2' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if p_object_etag is null or p_object_etag !~ '^"[A-Za-z0-9_-]{1,128}"$' then
    raise exception 'UPLOAD_MISMATCH';
  end if;
  if v_session.state = 'completed' then
    if not exists (
      select 1 from public.photos
      where id = v_session.id and tenant_id = p_tenant_id and gallery_id = p_gallery_id
        and storage_provider = 'r2' and storage_etag = p_object_etag and object_path = p_object_path
        and byte_size = p_object_bytes and content_type = p_object_content_type and deletion_requested_at is null
    ) then raise exception 'UPLOAD_MISMATCH'; end if;
    return v_session.id;
  end if;
  if v_session.state <> 'reserved' or v_session.expires_at <= clock_timestamp() then raise exception 'UPLOAD_CLOSED'; end if;
  perform 1 from public.galleries
    where id = p_gallery_id and tenant_id = p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'GALLERY_ARCHIVED'; end if;

  return private.finalize_verified_photo_upload(
    v_session, 'r2', p_object_path, p_object_bytes::text, p_object_content_type, p_object_etag
  );
end;
$$;
revoke all on function public.complete_r2_photo_upload(uuid, uuid, uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_r2_photo_upload(uuid, uuid, uuid, uuid, text, bigint, text, text)
  to service_role;

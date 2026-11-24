-- The caller must authorize the upload, lock its reservation and read the
-- object's metadata from the recorded provider in the same confirmation flow.
create function private.finalize_verified_photo_upload(
  p_session public.upload_sessions,
  p_storage_provider text,
  p_object_path text,
  p_object_bytes text,
  p_object_content_type text
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
    id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, storage_provider
  ) values (
    p_session.id, p_session.tenant_id, p_session.gallery_id, p_session.object_path, p_session.original_filename,
    p_session.content_type, p_session.byte_size, p_session.created_by, p_session.storage_provider
  );
  update public.upload_sessions set state = 'completed' where id = p_session.id;
  return p_session.id;
end;
$$;
revoke all on function private.finalize_verified_photo_upload(public.upload_sessions, text, text, text, text)
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
    v_session, 'supabase', v_session.object_path, v_metadata->>'size', v_metadata->>'mimetype'
  );
end;
$$;

-- The existing default identifies both legacy rows and new Supabase uploads.
-- Enable another provider only after its upload, read and cleanup paths exist.
alter table public.upload_sessions
  add column storage_provider text not null default 'supabase',
  add constraint upload_sessions_storage_provider_check check (storage_provider = 'supabase');

alter table public.photos
  add column storage_provider text not null default 'supabase',
  add constraint photos_storage_provider_check check (storage_provider = 'supabase');

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
  if v_metadata->>'size' is distinct from v_session.byte_size::text
    or v_metadata->>'mimetype' is distinct from v_session.content_type then raise exception 'UPLOAD_MISMATCH'; end if;

  insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by, storage_provider)
    values (v_session.id, v_session.tenant_id, v_session.gallery_id, v_session.object_path,
      v_session.original_filename, v_session.content_type, v_session.byte_size, v_session.created_by, v_session.storage_provider);
  update public.upload_sessions set state = 'completed' where id = v_session.id;
  return v_session.id;
end;
$$;

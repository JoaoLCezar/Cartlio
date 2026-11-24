-- Originals up to 50 MiB use TUS from the browser. A reservation covers the
-- bucket maximum so a forged declared size cannot overcommit workspace quota.
alter table public.photos drop constraint photos_byte_size_check;
alter table public.photos add constraint photos_byte_size_check
  check (byte_size between 1 and 52428800) not valid;
alter table public.photos validate constraint photos_byte_size_check;

alter table public.upload_sessions drop constraint upload_sessions_byte_size_check;
alter table public.upload_sessions add constraint upload_sessions_byte_size_check
  check (byte_size between 1 and 52428800) not valid;
alter table public.upload_sessions validate constraint upload_sessions_byte_size_check;

alter table public.upload_sessions alter column reserved_bytes drop default;
alter table public.upload_sessions drop constraint upload_sessions_reserved_bytes_check;
update public.upload_sessions set reserved_bytes = 52428800;
alter table public.upload_sessions alter column reserved_bytes set default 52428800;
alter table public.upload_sessions add constraint upload_sessions_reserved_bytes_check
  check (reserved_bytes = 52428800) not valid;
alter table public.upload_sessions validate constraint upload_sessions_reserved_bytes_check;
alter table public.upload_sessions alter column expires_at set default (now() + interval '4 hours');

create or replace function public.reserve_photo_upload(p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid,
  p_filename text, p_content_type text, p_byte_size bigint)
returns public.upload_sessions language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype; v_limit bigint; v_usage bigint;
begin
  perform private.assert_upload_scope(p_tenant_id, p_gallery_id);
  if p_upload_id is null or p_filename is null or char_length(btrim(p_filename)) not between 1 and 255
    or p_content_type is null or p_content_type not in ('image/jpeg', 'image/png')
    or p_byte_size is null or p_byte_size not between 1 and 52428800 then
    raise exception 'UPLOAD_INVALID' using errcode = '22023';
  end if;
  select storage_limit_bytes into v_limit from public.tenants where id = p_tenant_id for update;
  perform private.expire_upload_reservations(p_tenant_id);
  select * into v_session from public.upload_sessions where id = p_upload_id for update;
  if found then
    if v_session.tenant_id <> p_tenant_id or v_session.gallery_id <> p_gallery_id then
      raise exception 'Upload access denied' using errcode = '42501';
    end if;
    if v_session.original_filename <> btrim(p_filename) or v_session.content_type <> p_content_type
      or v_session.byte_size <> p_byte_size then raise exception 'UPLOAD_ID_CONFLICT' using errcode = '22023'; end if;
    if v_session.state not in ('reserved', 'completed') then raise exception 'UPLOAD_CLOSED'; end if;
    return v_session;
  end if;
  if exists (select 1 from public.galleries where id = p_gallery_id and status = 'archived') then
    raise exception 'GALLERY_ARCHIVED';
  end if;
  if exists (select 1 from public.photos where id = p_upload_id) then raise exception 'UPLOAD_ID_CONFLICT'; end if;
  select coalesce((select sum(byte_size) from public.photos where tenant_id = p_tenant_id), 0)
    + coalesce((select sum(reserved_bytes) from public.upload_sessions
        where tenant_id = p_tenant_id and state in ('reserved', 'canceling')), 0) into v_usage;
  if v_usage + 52428800 > v_limit then raise exception 'STORAGE_QUOTA_EXCEEDED'; end if;
  insert into public.upload_sessions (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by)
    values (p_upload_id, p_tenant_id, p_gallery_id,
      p_tenant_id::text || '/' || p_gallery_id::text || '/' || p_upload_id::text || case p_content_type when 'image/jpeg' then '.jpg' else '.png' end,
      btrim(p_filename), p_content_type, p_byte_size, auth.uid()) returning * into v_session;
  return v_session;
end;
$$;

revoke all on function public.reserve_photo_upload(uuid, uuid, uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.reserve_photo_upload(uuid, uuid, uuid, text, text, bigint) to authenticated;

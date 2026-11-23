-- Technical pilot limit, not a billing plan. Only administration may change it.
alter table public.tenants add column storage_limit_bytes bigint not null default 1073741824
  check (storage_limit_bytes >= 0);
update public.tenants t set storage_limit_bytes = greatest(storage_limit_bytes,
  coalesce((select sum(p.byte_size) from public.photos p where p.tenant_id = t.id), 0));

create table public.upload_sessions (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  gallery_id uuid not null,
  object_path text not null unique,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  content_type text not null check (content_type in ('image/jpeg', 'image/png')),
  byte_size bigint not null check (byte_size between 1 and 6291456),
  -- Reserve the bucket's maximum until Storage confirms the actual byte count.
  -- A forged Content-Length/size cannot overcommit the workspace's quota.
  reserved_bytes bigint not null default 6291456 check (reserved_bytes = 6291456),
  state text not null default 'reserved' check (state in ('reserved', 'completed', 'canceling', 'canceled')),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  foreign key (tenant_id, gallery_id) references public.galleries(tenant_id, id) on delete cascade,
  check (object_path = tenant_id::text || '/' || gallery_id::text || '/' || id::text ||
    case content_type when 'image/jpeg' then '.jpg' else '.png' end)
);
create index upload_sessions_pending_idx on public.upload_sessions(tenant_id, gallery_id, expires_at)
  where state in ('reserved', 'canceling');
alter table public.upload_sessions enable row level security;
revoke all on public.upload_sessions from public, anon, authenticated;
grant select on public.upload_sessions to authenticated;
create policy upload_sessions_select_member on public.upload_sessions for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));
revoke insert (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by)
  on public.photos from authenticated;
drop policy photos_insert_member on public.photos;

create function private.assert_upload_scope(p_tenant_id uuid, p_gallery_id uuid, p_allow_service boolean default false)
returns void language plpgsql set search_path = '' as $$
begin
  if not (coalesce(p_allow_service and auth.role() = 'service_role', false)
    or (auth.uid() is not null and private.is_tenant_member(p_tenant_id)))
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id and id = p_gallery_id) then
    raise exception 'Gallery access denied' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.assert_upload_scope(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- All quota-increasing operations serialize on the workspace row. Session locks
-- also serialize with Storage INSERT, so cancellation cannot race a late upload.
create function private.expire_upload_reservations(p_tenant_id uuid)
returns void language plpgsql set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  for v_session in select * from public.upload_sessions
    where tenant_id = p_tenant_id and state = 'reserved' and expires_at <= clock_timestamp()
    for update loop
    update public.upload_sessions set state = case when exists (
      select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_session.object_path
    ) then 'canceling' else 'canceled' end where id = v_session.id;
  end loop;
end;
$$;
revoke all on function private.expire_upload_reservations(uuid) from public, anon, authenticated, service_role;

create function public.reserve_photo_upload(p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid,
  p_filename text, p_content_type text, p_byte_size bigint)
returns public.upload_sessions language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype; v_limit bigint; v_usage bigint;
begin
  perform private.assert_upload_scope(p_tenant_id, p_gallery_id);
  if p_upload_id is null or p_filename is null or char_length(btrim(p_filename)) not between 1 and 255
    or p_content_type is null or p_content_type not in ('image/jpeg', 'image/png')
    or p_byte_size is null or p_byte_size not between 1 and 6291456 then
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
  if v_usage + 6291456 > v_limit then raise exception 'STORAGE_QUOTA_EXCEEDED'; end if;
  insert into public.upload_sessions (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by)
    values (p_upload_id, p_tenant_id, p_gallery_id,
      p_tenant_id::text || '/' || p_gallery_id::text || '/' || p_upload_id::text || case p_content_type when 'image/jpeg' then '.jpg' else '.png' end,
      btrim(p_filename), p_content_type, p_byte_size, auth.uid()) returning * into v_session;
  return v_session;
end;
$$;

create function public.complete_photo_upload(p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid)
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
  select metadata into v_metadata from storage.objects
    where bucket_id = 'gallery-originals' and name = v_session.object_path;
  if not found then raise exception 'UPLOAD_MISSING'; end if;
  if v_metadata->>'size' is distinct from v_session.byte_size::text
    or v_metadata->>'mimetype' is distinct from v_session.content_type then raise exception 'UPLOAD_MISMATCH'; end if;
  insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by)
    values (v_session.id, v_session.tenant_id, v_session.gallery_id, v_session.object_path,
      v_session.original_filename, v_session.content_type, v_session.byte_size, v_session.created_by);
  update public.upload_sessions set state = 'completed' where id = v_session.id;
  return v_session.id;
end;
$$;

create function public.begin_upload_cancellation(p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_upload_scope(p_tenant_id, p_gallery_id, true);
  perform 1 from public.tenants where id = p_tenant_id for update;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found or v_session.state = 'canceled' then return null; end if;
  if v_session.state = 'completed' then raise exception 'UPLOAD_COMPLETED'; end if;
  update public.upload_sessions set state = 'canceling' where id = v_session.id;
  return v_session.object_path;
end;
$$;

create function public.finish_upload_cancellation(p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_upload_scope(p_tenant_id, p_gallery_id, true);
  perform 1 from public.tenants where id = p_tenant_id for update;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found or v_session.state = 'canceled' then return true; end if;
  if v_session.state <> 'canceling' then return false; end if;
  if exists (select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_session.object_path) then return false; end if;
  update public.upload_sessions set state = 'canceled' where id = v_session.id;
  return true;
end;
$$;

create function public.workspace_storage_usage(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_limit bigint; v_used bigint; v_reserved bigint;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  select storage_limit_bytes into v_limit from public.tenants where id = p_tenant_id;
  select coalesce(sum(byte_size), 0) into v_used from public.photos where tenant_id = p_tenant_id;
  select coalesce(sum(reserved_bytes), 0) into v_reserved from public.upload_sessions
    where tenant_id = p_tenant_id and state in ('reserved', 'canceling');
  return jsonb_build_object('limit_bytes', v_limit, 'used_bytes', v_used, 'reserved_bytes', v_reserved,
    'available_bytes', greatest(0, v_limit - v_used - v_reserved));
end;
$$;

-- Lock the reservation during an actual Storage INSERT. An expired/canceling
-- session cannot accept late writes after its quota has been released.
create function private.can_insert_gallery_original(p_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  select s.* into v_session from public.upload_sessions s
    where s.object_path = p_name and private.is_tenant_member(s.tenant_id)
    for share;
  if not found then return false; end if;
  return v_session.state = 'reserved' and v_session.expires_at > clock_timestamp()
    and exists (select 1 from public.galleries where id = v_session.gallery_id and status <> 'archived');
end;
$$;
revoke all on function private.can_insert_gallery_original(text) from public, anon, authenticated;
grant execute on function private.can_insert_gallery_original(text) to authenticated;

alter policy gallery_originals_insert_member on storage.objects
  with check (bucket_id = 'gallery-originals' and private.can_insert_gallery_original(name));
alter policy gallery_originals_select_photo_member on storage.objects using (
  bucket_id = 'gallery-originals' and (
    exists (select 1 from public.photos p where p.object_path = storage.objects.name and private.is_tenant_member(p.tenant_id))
    or exists (select 1 from public.upload_sessions s where s.object_path = storage.objects.name
      and s.state in ('reserved', 'canceling') and private.is_tenant_member(s.tenant_id))
  )
);
alter policy gallery_originals_delete_member on storage.objects using (
  bucket_id = 'gallery-originals' and (
    exists (select 1 from public.photos p where p.object_path = storage.objects.name
      and p.deletion_requested_at is not null and private.is_tenant_member(p.tenant_id))
    or exists (select 1 from public.upload_sessions s where s.object_path = storage.objects.name
      and s.state = 'canceling' and private.is_tenant_member(s.tenant_id))
  )
);

revoke all on function public.reserve_photo_upload(uuid, uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.complete_photo_upload(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.begin_upload_cancellation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_upload_cancellation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.workspace_storage_usage(uuid) from public, anon, authenticated;
grant execute on function public.reserve_photo_upload(uuid, uuid, uuid, text, text, bigint) to authenticated;
grant execute on function public.complete_photo_upload(uuid, uuid, uuid) to authenticated;
grant execute on function public.begin_upload_cancellation(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.finish_upload_cancellation(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.workspace_storage_usage(uuid) to authenticated;

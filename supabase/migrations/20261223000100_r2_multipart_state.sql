alter table public.upload_sessions
  add column r2_multipart_state text,
  add column r2_multipart_upload_id text,
  add column r2_multipart_started_at timestamptz,
  add column r2_multipart_claimed_at timestamptz,
  add constraint upload_sessions_r2_multipart_provider_check check (
    storage_provider = 'r2' or (
      r2_multipart_state is null and r2_multipart_upload_id is null
      and r2_multipart_started_at is null and r2_multipart_claimed_at is null
    )
  ),
  add constraint upload_sessions_r2_multipart_upload_id_check check (
    r2_multipart_upload_id is null or r2_multipart_upload_id ~ '^[!-~]{1,1024}$'
  ),
  add constraint upload_sessions_r2_multipart_state_check check (
    (r2_multipart_state is null and r2_multipart_upload_id is null
      and r2_multipart_started_at is null and r2_multipart_claimed_at is null)
    or (r2_multipart_state = 'starting' and state = 'reserved' and r2_multipart_upload_id is null
      and r2_multipart_started_at is not null and r2_multipart_claimed_at is null)
    or (r2_multipart_state = 'started' and state = 'reserved' and r2_multipart_upload_id is not null
      and r2_multipart_started_at is not null and r2_multipart_claimed_at is null)
    or (r2_multipart_state = 'completing' and state = 'reserved' and r2_multipart_upload_id is not null
      and r2_multipart_started_at is not null and r2_multipart_claimed_at is not null)
    or (r2_multipart_state = 'canceling' and state = 'canceling'
      and r2_multipart_started_at is not null and r2_multipart_claimed_at is null)
  );

create index upload_sessions_r2_multipart_pending_idx
  on public.upload_sessions (tenant_id, gallery_id, r2_multipart_state, r2_multipart_started_at)
  where storage_provider = 'r2' and r2_multipart_state is not null;

create function private.assert_r2_multipart_actor(p_actor_id uuid, p_tenant_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' or p_actor_id is null
    or not exists (select 1 from public.tenant_members where tenant_id = p_tenant_id and user_id = p_actor_id) then
    raise exception 'UPLOAD_CONFIRMATION_DENIED' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.assert_r2_multipart_actor(uuid, uuid) from public, anon, authenticated, service_role;

create function public.begin_r2_multipart_upload(
  p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid
)
returns public.upload_sessions language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_r2_multipart_actor(p_actor_id, p_tenant_id);
  perform 1 from public.tenants where id = p_tenant_id for update;
  perform 1 from public.galleries where id = p_gallery_id and tenant_id = p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'GALLERY_ARCHIVED'; end if;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_session.storage_provider <> 'r2' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if v_session.state <> 'reserved' or v_session.expires_at <= clock_timestamp() then raise exception 'UPLOAD_CLOSED'; end if;
  if v_session.r2_put_authorized_at is not null then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if v_session.r2_multipart_state is not null then raise exception 'R2_MULTIPART_ALREADY_STARTED'; end if;

  update public.upload_sessions set r2_multipart_state = 'starting',
    r2_multipart_started_at = clock_timestamp()
    where id = v_session.id returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.begin_r2_multipart_upload(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_r2_multipart_upload(uuid, uuid, uuid, uuid) to service_role;

create function public.record_r2_multipart_upload_id(
  p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid, p_multipart_upload_id text
)
returns public.upload_sessions language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_r2_multipart_actor(p_actor_id, p_tenant_id);
  perform 1 from public.tenants where id = p_tenant_id for update;
  perform 1 from public.galleries where id = p_gallery_id and tenant_id = p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'GALLERY_ARCHIVED'; end if;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_session.storage_provider <> 'r2' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if p_multipart_upload_id is null or p_multipart_upload_id !~ '^[!-~]{1,1024}$' then
    raise exception 'R2_MULTIPART_ID_INVALID' using errcode = '22023';
  end if;
  if v_session.state <> 'reserved' or v_session.expires_at <= clock_timestamp() then raise exception 'UPLOAD_CLOSED'; end if;
  if v_session.r2_multipart_state = 'started' and v_session.r2_multipart_upload_id = p_multipart_upload_id then
    return v_session;
  end if;
  if v_session.r2_multipart_state <> 'starting' or v_session.r2_multipart_started_at is null then
    if v_session.r2_multipart_upload_id is not distinct from p_multipart_upload_id then
      raise exception 'R2_MULTIPART_ALREADY_STARTED';
    end if;
    raise exception 'R2_MULTIPART_ID_CONFLICT';
  end if;

  update public.upload_sessions set r2_multipart_state = 'started', r2_multipart_upload_id = p_multipart_upload_id
    where id = v_session.id returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.record_r2_multipart_upload_id(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_r2_multipart_upload_id(uuid, uuid, uuid, uuid, text) to service_role;

create function public.claim_r2_multipart_completion(
  p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid
)
returns public.upload_sessions language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_r2_multipart_actor(p_actor_id, p_tenant_id);
  perform 1 from public.tenants where id = p_tenant_id for update;
  perform 1 from public.galleries where id = p_gallery_id and tenant_id = p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'GALLERY_ARCHIVED'; end if;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_session.storage_provider <> 'r2' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if v_session.state <> 'reserved' or v_session.expires_at <= clock_timestamp() then raise exception 'UPLOAD_CLOSED'; end if;
  if v_session.r2_multipart_upload_id is null then raise exception 'R2_MULTIPART_ID_REQUIRED'; end if;
  if v_session.r2_multipart_state = 'started'
    or (v_session.r2_multipart_state = 'completing'
      and v_session.r2_multipart_claimed_at <= clock_timestamp() - interval '2 minutes') then
    update public.upload_sessions set r2_multipart_state = 'completing',
      r2_multipart_claimed_at = clock_timestamp()
      where id = v_session.id returning * into v_session;
    return v_session;
  end if;
  if v_session.r2_multipart_state = 'completing' then
    raise exception 'R2_MULTIPART_OPERATION_IN_PROGRESS';
  end if;
  raise exception 'R2_MULTIPART_NOT_READY';
end;
$$;
revoke all on function public.claim_r2_multipart_completion(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_r2_multipart_completion(uuid, uuid, uuid, uuid) to service_role;

create function public.begin_r2_multipart_cancellation(
  p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid
)
returns public.upload_sessions language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_r2_multipart_actor(p_actor_id, p_tenant_id);
  perform 1 from public.tenants where id = p_tenant_id for update;
  perform 1 from public.galleries where id = p_gallery_id and tenant_id = p_tenant_id for share;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_session.storage_provider <> 'r2' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if v_session.state = 'completed' then raise exception 'UPLOAD_COMPLETED'; end if;
  if v_session.state = 'canceled' then return v_session; end if;
  if v_session.r2_multipart_state = 'canceling' and v_session.state = 'canceling' then return v_session; end if;
  if v_session.r2_multipart_state = 'completing'
    and v_session.r2_multipart_claimed_at > clock_timestamp() - interval '2 minutes' then
    raise exception 'R2_MULTIPART_OPERATION_IN_PROGRESS';
  end if;
  if v_session.r2_multipart_state not in ('starting', 'started', 'completing') then
    raise exception 'R2_MULTIPART_NOT_READY';
  end if;

  update public.upload_sessions set state = 'canceling', r2_multipart_state = 'canceling',
    r2_multipart_claimed_at = null where id = v_session.id returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.begin_r2_multipart_cancellation(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_r2_multipart_cancellation(uuid, uuid, uuid, uuid) to service_role;

create function public.finish_r2_multipart_cancellation(
  p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid,
  p_upload_closed boolean, p_object_absent boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_r2_multipart_actor(p_actor_id, p_tenant_id);
  perform 1 from public.tenants where id = p_tenant_id for update;
  perform 1 from public.galleries where id = p_gallery_id and tenant_id = p_tenant_id for share;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found or v_session.state = 'canceled' then return true; end if;
  if v_session.storage_provider <> 'r2' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if v_session.state <> 'canceling' or v_session.r2_multipart_state <> 'canceling' then return false; end if;
  if p_upload_closed is distinct from true or p_object_absent is distinct from true then return false; end if;

  update public.upload_sessions set state = 'canceled', r2_multipart_state = null,
    r2_multipart_upload_id = null, r2_multipart_started_at = null, r2_multipart_claimed_at = null
    where id = v_session.id;
  return true;
end;
$$;
revoke all on function public.finish_r2_multipart_cancellation(uuid, uuid, uuid, uuid, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_r2_multipart_cancellation(uuid, uuid, uuid, uuid, boolean, boolean) to service_role;

create or replace function private.expire_upload_reservations(p_tenant_id uuid)
returns void language plpgsql set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  for v_session in select * from public.upload_sessions
    where tenant_id = p_tenant_id and state = 'reserved' and expires_at <= clock_timestamp()
    for update loop
    if v_session.r2_multipart_state = 'completing'
      and v_session.r2_multipart_claimed_at > clock_timestamp() - interval '2 minutes' then
      continue;
    end if;
    update public.upload_sessions set
      state = case
        when v_session.storage_provider = 'r2' and v_session.r2_multipart_state is not null then 'canceling'
        when v_session.storage_provider = 'r2' and v_session.r2_put_authorized_at is not null then 'canceling'
        when v_session.storage_provider = 'r2' then 'canceled'
        when exists (select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_session.object_path) then 'canceling'
        else 'canceled'
      end,
      r2_multipart_state = case when v_session.storage_provider = 'r2' and v_session.r2_multipart_state is not null
        then 'canceling' else v_session.r2_multipart_state end,
      r2_multipart_claimed_at = case when v_session.storage_provider = 'r2' and v_session.r2_multipart_state is not null
        then null else v_session.r2_multipart_claimed_at end
      where id = v_session.id;
  end loop;
end;
$$;
revoke all on function private.expire_upload_reservations(uuid) from public, anon, authenticated, service_role;

create or replace function public.reconcile_r2_upload_reservations(p_tenant_id uuid default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_examined integer; v_cleaned integer; v_held integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'UPLOAD_RECONCILIATION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'UPLOAD_RECONCILIATION_LIMIT_INVALID' using errcode = '22023';
  end if;
  with pending as (
    select id from public.upload_sessions
    where storage_provider = 'r2' and (p_tenant_id is null or tenant_id = p_tenant_id)
      and ((state = 'reserved' and expires_at <= clock_timestamp()
          and (r2_multipart_state <> 'completing'
            or r2_multipart_claimed_at <= clock_timestamp() - interval '2 minutes'))
        or (state = 'canceling' and r2_put_authorized_at is null and r2_multipart_state is null))
    order by created_at, id limit p_limit for update skip locked
  ), reconciled as (
    update public.upload_sessions s
    set state = case when s.r2_multipart_state is not null then 'canceling'
      when s.r2_put_authorized_at is null then 'canceled' else 'canceling' end,
      r2_multipart_state = case when s.r2_multipart_state is not null then 'canceling' else null end,
      r2_multipart_claimed_at = null
    from pending where s.id = pending.id
    returning s.state
  )
  select count(*)::integer, count(*) filter (where state = 'canceled')::integer
    into v_examined, v_cleaned from reconciled;

  select count(*)::integer into v_held from public.upload_sessions
    where storage_provider = 'r2'
      and (r2_multipart_state is not null or (state = 'canceling' and r2_put_authorized_at is not null))
      and (p_tenant_id is null or tenant_id = p_tenant_id);
  return jsonb_build_object('examined', v_examined, 'cleaned', v_cleaned, 'held', v_held);
end;
$$;
revoke all on function public.reconcile_r2_upload_reservations(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_r2_upload_reservations(uuid, integer) to service_role;

create or replace function private.finalize_verified_photo_upload(
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
  update public.upload_sessions set state = 'completed', r2_multipart_state = null,
    r2_multipart_upload_id = null, r2_multipart_started_at = null, r2_multipart_claimed_at = null
    where id = p_session.id;
  return p_session.id;
end;
$$;
revoke all on function private.finalize_verified_photo_upload(public.upload_sessions, text, text, text, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.prepare_r2_upload_put(p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid)
returns public.upload_sessions language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'UPLOAD_CONFIRMATION_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.tenants where id = p_tenant_id for update;
  if not exists (select 1 from public.tenant_members where tenant_id = p_tenant_id and user_id = p_actor_id) then
    raise exception 'UPLOAD_CONFIRMATION_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.galleries
    where id = p_gallery_id and tenant_id = p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'GALLERY_ARCHIVED'; end if;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_session.storage_provider <> 'r2' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if v_session.state <> 'reserved' or v_session.expires_at <= clock_timestamp() then raise exception 'UPLOAD_CLOSED'; end if;
  if v_session.r2_multipart_state is not null then raise exception 'UPLOAD_MULTIPART_IN_PROGRESS'; end if;

  update public.upload_sessions set r2_put_authorized_at = coalesce(r2_put_authorized_at, clock_timestamp())
    where id = v_session.id returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.prepare_r2_upload_put(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_r2_upload_put(uuid, uuid, uuid, uuid) to service_role;

create or replace function public.complete_r2_photo_upload(
  p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid,
  p_object_path text, p_object_bytes bigint, p_object_content_type text, p_object_etag text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'UPLOAD_CONFIRMATION_DENIED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.tenant_members where tenant_id = p_tenant_id and user_id = p_actor_id) then
    raise exception 'UPLOAD_CONFIRMATION_DENIED' using errcode = '42501';
  end if;
  perform 1 from public.tenants where id = p_tenant_id for update;
  if not found then raise exception 'UPLOAD_CONFIRMATION_DENIED' using errcode = '42501'; end if;
  perform 1 from public.galleries
    where id = p_gallery_id and tenant_id = p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'GALLERY_ARCHIVED'; end if;
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
  if v_session.r2_multipart_state is not null
    and (v_session.r2_multipart_state <> 'completing' or v_session.r2_multipart_claimed_at is null) then
    raise exception 'R2_MULTIPART_NOT_CLAIMED';
  end if;

  return private.finalize_verified_photo_upload(
    v_session, 'r2', p_object_path, p_object_bytes::text, p_object_content_type, p_object_etag
  );
end;
$$;
revoke all on function public.complete_r2_photo_upload(uuid, uuid, uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_r2_photo_upload(uuid, uuid, uuid, uuid, text, bigint, text, text) to service_role;

create function private.block_gallery_delete_with_r2_uploads()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.upload_sessions s
    where s.tenant_id = old.tenant_id and s.gallery_id = old.id and s.storage_provider = 'r2'
      and (s.state in ('reserved', 'canceling') or s.r2_multipart_state is not null)
    for update;
  if found then raise exception 'R2_UPLOAD_IN_PROGRESS' using errcode = '55000'; end if;
  return old;
end;
$$;
revoke all on function private.block_gallery_delete_with_r2_uploads() from public, anon, authenticated, service_role;
create trigger block_gallery_delete_with_r2_uploads
  before delete on public.galleries for each row execute function private.block_gallery_delete_with_r2_uploads();

create function private.block_tenant_delete_with_r2_uploads()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.upload_sessions s
    where s.tenant_id = old.id and s.storage_provider = 'r2'
      and (s.state in ('reserved', 'canceling') or s.r2_multipart_state is not null)
    for update;
  if found then raise exception 'R2_UPLOAD_IN_PROGRESS' using errcode = '55000'; end if;
  return old;
end;
$$;
revoke all on function private.block_tenant_delete_with_r2_uploads() from public, anon, authenticated, service_role;
create trigger block_tenant_delete_with_r2_uploads
  before delete on public.tenants for each row execute function private.block_tenant_delete_with_r2_uploads();

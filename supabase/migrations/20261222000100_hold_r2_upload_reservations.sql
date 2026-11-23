alter table public.upload_sessions add column r2_put_authorized_at timestamptz,
  add constraint upload_sessions_r2_put_authorization_check check (
    r2_put_authorized_at is null or storage_provider = 'r2'
  );

-- Record the capability before the server can hand out a writable URL.
create function public.prepare_r2_upload_put(p_actor_id uuid, p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid)
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
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found then raise exception 'UPLOAD_NOT_FOUND'; end if;
  if v_session.storage_provider <> 'r2' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if v_session.state <> 'reserved' or v_session.expires_at <= clock_timestamp() then raise exception 'UPLOAD_CLOSED'; end if;
  perform 1 from public.galleries
    where id = p_gallery_id and tenant_id = p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'GALLERY_ARCHIVED'; end if;

  update public.upload_sessions set r2_put_authorized_at = coalesce(r2_put_authorized_at, clock_timestamp())
    where id = v_session.id returning * into v_session;
  return v_session;
end;
$$;
revoke all on function public.prepare_r2_upload_put(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_r2_upload_put(uuid, uuid, uuid, uuid) to service_role;

create or replace function private.expire_upload_reservations(p_tenant_id uuid)
returns void language plpgsql set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  for v_session in select * from public.upload_sessions
    where tenant_id = p_tenant_id and state = 'reserved' and expires_at <= clock_timestamp()
    for update loop
    update public.upload_sessions set state = case
      when v_session.storage_provider = 'r2' then
        case when v_session.r2_put_authorized_at is null then 'canceled' else 'canceling' end
      when exists (
        select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_session.object_path
      ) then 'canceling'
      else 'canceled'
    end where id = v_session.id;
  end loop;
end;
$$;

-- A direct PUT may still commit after a timeout or a negative HEAD. Held
-- reservations keep their quota; this routine never deletes an R2 object.
create function public.reconcile_r2_upload_reservations(p_tenant_id uuid default null, p_limit integer default 100)
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
      and ((state = 'reserved' and expires_at <= clock_timestamp())
        or (state = 'canceling' and r2_put_authorized_at is null))
    order by created_at, id limit p_limit for update skip locked
  ), reconciled as (
    update public.upload_sessions s
    set state = case when s.r2_put_authorized_at is null then 'canceled' else 'canceling' end
    from pending where s.id = pending.id
    returning s.state
  )
  select count(*)::integer, count(*) filter (where state = 'canceled')::integer
    into v_examined, v_cleaned from reconciled;

  select count(*)::integer into v_held from public.upload_sessions
    where storage_provider = 'r2' and state = 'canceling' and r2_put_authorized_at is not null
      and (p_tenant_id is null or tenant_id = p_tenant_id);
  return jsonb_build_object('examined', v_examined, 'cleaned', v_cleaned, 'held', v_held);
end;
$$;
revoke all on function public.reconcile_r2_upload_reservations(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_r2_upload_reservations(uuid, integer) to service_role;

create or replace function public.begin_upload_cancellation(p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_upload_scope(p_tenant_id, p_gallery_id, true);
  perform 1 from public.tenants where id = p_tenant_id for update;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if found and v_session.storage_provider <> 'supabase' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if not found or v_session.state = 'canceled' then return null; end if;
  if v_session.state = 'completed' then raise exception 'UPLOAD_COMPLETED'; end if;
  update public.upload_sessions set state = 'canceling' where id = v_session.id;
  return v_session.object_path;
end;
$$;

create or replace function public.finish_upload_cancellation(p_tenant_id uuid, p_gallery_id uuid, p_upload_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  perform private.assert_upload_scope(p_tenant_id, p_gallery_id, true);
  perform 1 from public.tenants where id = p_tenant_id for update;
  select * into v_session from public.upload_sessions
    where id = p_upload_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if found and v_session.storage_provider <> 'supabase' then raise exception 'UPLOAD_PROVIDER_UNSUPPORTED'; end if;
  if not found or v_session.state = 'canceled' then return true; end if;
  if v_session.state <> 'canceling' then return false; end if;
  if exists (select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_session.object_path) then return false; end if;
  update public.upload_sessions set state = 'canceled' where id = v_session.id;
  return true;
end;
$$;

create or replace function private.can_insert_gallery_original(p_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_session public.upload_sessions%rowtype;
begin
  select s.* into v_session from public.upload_sessions s
    where s.object_path = p_name and private.is_tenant_member(s.tenant_id)
    for share;
  if not found then return false; end if;
  return v_session.storage_provider = 'supabase' and v_session.state = 'reserved' and v_session.expires_at > clock_timestamp()
    and exists (select 1 from public.galleries where id = v_session.gallery_id and status <> 'archived');
end;
$$;

create or replace function public.prune_upload_sessions(
  p_retention_days integer default 90,
  p_tenant_id uuid default null,
  p_batch_size integer default 500
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'UPLOAD_RETENTION_DENIED' using errcode = '42501';
  end if;
  if p_retention_days is null or p_retention_days not between 30 and 365 then
    raise exception 'UPLOAD_RETENTION_INVALID' using errcode = '22023';
  end if;
  if p_batch_size is null or p_batch_size not between 1 and 1000 then
    raise exception 'UPLOAD_RETENTION_BATCH_INVALID' using errcode = '22023';
  end if;

  with stale_sessions as (
    select s.id
    from public.upload_sessions s
    where s.storage_provider = 'supabase' and s.state in ('completed', 'canceled')
      and s.created_at < clock_timestamp() - make_interval(days => p_retention_days)
      and (p_tenant_id is null or s.tenant_id = p_tenant_id)
      and (
        exists (select 1 from public.photos p where p.tenant_id = s.tenant_id and p.object_path = s.object_path)
        or not exists (select 1 from storage.objects o where o.bucket_id = 'gallery-originals' and o.name = s.object_path)
      )
    order by s.created_at, s.id
    limit p_batch_size
    for update skip locked
  ), deleted_sessions as (
    delete from public.upload_sessions s
    using stale_sessions stale
    where s.id = stale.id
    returning s.id
  )
  select count(*)::integer into v_deleted from deleted_sessions;

  return coalesce(v_deleted, 0);
end;
$$;

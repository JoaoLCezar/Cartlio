alter table public.upload_sessions
  drop constraint upload_sessions_r2_multipart_upload_id_check,
  add constraint upload_sessions_r2_multipart_upload_id_check check (
    r2_multipart_upload_id is null or (
      char_length(r2_multipart_upload_id) between 1 and 1024
      and r2_multipart_upload_id ~ '^[!-~]+$'
    )
  );

create or replace function public.record_r2_multipart_upload_id(
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
  if p_multipart_upload_id is null or char_length(p_multipart_upload_id) not between 1 and 1024
    or p_multipart_upload_id !~ '^[!-~]+$' then
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

create or replace function public.begin_r2_multipart_cancellation(
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
  if v_session.r2_multipart_state is null
    or v_session.r2_multipart_state not in ('starting', 'started', 'completing') then
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
          and (r2_multipart_state is distinct from 'completing'
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

create index upload_sessions_retention_idx on public.upload_sessions(created_at, id)
  where state in ('completed', 'canceled');

create function public.prune_upload_sessions(
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
    where s.state in ('completed', 'canceled')
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

revoke all on function public.prune_upload_sessions(integer, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.prune_upload_sessions(integer, uuid, integer) to service_role;

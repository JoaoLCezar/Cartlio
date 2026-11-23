create function public.prune_gallery_notification_outbox(p_retention_days integer default 90)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'NOTIFICATION_WORKER_DENIED' using errcode = '42501';
  end if;
  if p_retention_days is null or p_retention_days not between 30 and 365 then
    raise exception 'NOTIFICATION_RETENTION_INVALID' using errcode = '22023';
  end if;
  delete from public.gallery_notification_outbox n
    where (n.sent_at is not null or n.failed_at is not null)
      and coalesce(n.sent_at, n.failed_at) < clock_timestamp() - make_interval(days => p_retention_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.prune_gallery_notification_outbox(integer) from public, anon, authenticated;
grant execute on function public.prune_gallery_notification_outbox(integer) to service_role;

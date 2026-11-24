create index gallery_download_events_created_at_idx on public.gallery_download_events(created_at);

-- Local/operational maintenance entry point. Access is limited to the trusted
-- server role; no browser-facing role can purge audit history.
create function public.prune_gallery_download_events(p_retention_days integer default 90)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_removed integer;
begin
  if p_retention_days is null or p_retention_days not between 30 and 365 then
    raise exception 'DOWNLOAD_RETENTION_INVALID' using errcode = '22023';
  end if;
  delete from public.gallery_download_events
    where created_at < clock_timestamp() - make_interval(days => p_retention_days);
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke all on function public.prune_gallery_download_events(integer) from public, anon, authenticated, service_role;
grant execute on function public.prune_gallery_download_events(integer) to service_role;

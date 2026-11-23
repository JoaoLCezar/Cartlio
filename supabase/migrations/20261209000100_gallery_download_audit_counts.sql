create function public.gallery_download_audit_counts(p_tenant_id uuid, p_gallery_id uuid)
returns table(share_id uuid, photo_id uuid, download_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'DOWNLOAD_AUDIT_DENIED' using errcode = '42501';
  end if;

  return query
  select e.share_id, e.photo_id, count(*)::integer
  from public.gallery_download_events e
  join public.gallery_shares s on s.id = e.share_id
  where s.tenant_id = p_tenant_id and s.gallery_id = p_gallery_id
    and (s.share_mode = 'delivery' or exists (
      select 1 from public.gallery_selection_items i
      where i.share_id = s.id and i.photo_id = e.photo_id
    ))
  group by e.share_id, e.photo_id;
end;
$$;

revoke all on function public.gallery_download_audit_counts(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.gallery_download_audit_counts(uuid, uuid) to authenticated;

create function public.retry_failed_photo_processing(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id and id = p_gallery_id) then
    raise exception 'Gallery access denied' using errcode = '42501';
  end if;

  update public.photos set processing_status = 'pending', processing_attempts = 0,
    processing_started_at = null, processing_available_at = null, processing_token = null,
    processed_at = null, width = null, height = null
  where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id
    and deletion_requested_at is null and processing_status = 'failed';
  return found;
end;
$$;

revoke all on function public.retry_failed_photo_processing(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.retry_failed_photo_processing(uuid, uuid, uuid) to authenticated;

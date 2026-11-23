-- A worker can disappear during its fifth attempt. Close that expired lease
-- explicitly so it does not remain displayed as processing forever.
create or replace function public.claim_photo_processing(p_tenant_id uuid default null)
returns public.photos language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Worker access denied' using errcode = '42501'; end if;
  update public.photos set processing_status = 'failed', processing_token = null, processing_started_at = null
    where (p_tenant_id is null or tenant_id = p_tenant_id) and deletion_requested_at is null
      and processing_status = 'processing' and processing_attempts >= 5
      and processing_started_at < clock_timestamp() - interval '15 minutes';
  select * into v_photo from public.photos
    where (p_tenant_id is null or tenant_id = p_tenant_id)
      and deletion_requested_at is null and processing_attempts < 5
      and ((processing_status = 'pending' and (processing_available_at is null or processing_available_at <= clock_timestamp())) or
        (processing_status = 'processing' and processing_started_at < clock_timestamp() - interval '15 minutes'))
    order by created_at, id for update skip locked limit 1;
  if not found then return null; end if;
  update public.photos set processing_status = 'processing', processing_started_at = clock_timestamp(), processing_available_at = null,
    processing_token = gen_random_uuid(), processing_attempts = processing_attempts + 1
    where id = v_photo.id returning * into v_photo;
  return v_photo;
end;
$$;

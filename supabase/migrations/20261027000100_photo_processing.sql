-- Private derivatives are keyed by the original photo UUID. The worker alone
-- may create them; workspace members may read ready images and delete them
-- only after recording an intent to delete the parent photo.
alter table public.photos
  add column processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'ready', 'invalid', 'failed')),
  add column processing_started_at timestamptz,
  add column processing_available_at timestamptz,
  add column processing_token uuid,
  add column processing_attempts integer not null default 0 check (processing_attempts >= 0),
  add column processed_at timestamptz,
  add column width integer check (width > 0),
  add column height integer check (height > 0);
create index photos_processing_queue_idx on public.photos(processing_status, processing_started_at, created_at)
  where deletion_requested_at is null and processing_status in ('pending', 'processing');

create policy gallery_previews_select_ready on storage.objects for select to authenticated
  using (bucket_id = 'gallery-previews' and exists (
    select 1 from public.photos p where
      name = p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp'
      and p.processing_status = 'ready' and p.deletion_requested_at is null
      and private.is_tenant_member(p.tenant_id)
  ));
create policy gallery_thumbnails_select_ready on storage.objects for select to authenticated
  using (bucket_id = 'gallery-thumbnails' and exists (
    select 1 from public.photos p where
      name = p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp'
      and p.processing_status = 'ready' and p.deletion_requested_at is null
      and private.is_tenant_member(p.tenant_id)
  ));
create policy gallery_previews_delete_intent on storage.objects for delete to authenticated
  using (bucket_id = 'gallery-previews' and exists (
    select 1 from public.photos p where
      name = p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp'
      and p.deletion_requested_at is not null and private.is_tenant_member(p.tenant_id)
  ));
create policy gallery_thumbnails_delete_intent on storage.objects for delete to authenticated
  using (bucket_id = 'gallery-thumbnails' and exists (
    select 1 from public.photos p where
      name = p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp'
      and p.deletion_requested_at is not null and private.is_tenant_member(p.tenant_id)
  ));

create function public.claim_photo_processing(p_tenant_id uuid default null)
returns public.photos language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Worker access denied' using errcode = '42501'; end if;
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

create function public.finish_photo_processing(p_photo_id uuid, p_token uuid, p_result text,
  p_width integer default null, p_height integer default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype; v_path text;
begin
  if auth.role() <> 'service_role' then raise exception 'Worker access denied' using errcode = '42501'; end if;
  select * into v_photo from public.photos where id = p_photo_id for update;
  if not found or v_photo.processing_status <> 'processing' or v_photo.processing_token is distinct from p_token
    or v_photo.deletion_requested_at is not null then return false; end if;
  if p_result not in ('ready', 'invalid', 'retry') then raise exception 'PROCESSING_INVALID' using errcode = '22023'; end if;
  if p_result = 'ready' then
    if p_width is null or p_height is null or p_width <= 0 or p_height <= 0
      or p_width::bigint * p_height::bigint > 40000000 then
      raise exception 'PROCESSING_DIMENSIONS' using errcode = '22023';
    end if;
    v_path := v_photo.tenant_id::text || '/' || v_photo.gallery_id::text || '/' || v_photo.id::text || '.webp';
    if not exists (select 1 from storage.objects where bucket_id = 'gallery-previews' and name = v_path
      and metadata->>'mimetype' = 'image/webp')
      or not exists (select 1 from storage.objects where bucket_id = 'gallery-thumbnails' and name = v_path
        and metadata->>'mimetype' = 'image/webp') then
      raise exception 'PROCESSING_DERIVATIVES_MISSING';
    end if;
    update public.photos set processing_status = 'ready', processed_at = clock_timestamp(),
      width = p_width, height = p_height, processing_token = null, processing_started_at = null
      where id = p_photo_id;
  elsif p_result = 'invalid' then
    update public.photos set processing_status = 'invalid', processed_at = clock_timestamp(),
      processing_token = null, processing_started_at = null where id = p_photo_id;
  else
    update public.photos set processing_status = case when processing_attempts >= 5 then 'failed' else 'pending' end,
      processing_token = null, processing_started_at = null,
      processing_available_at = case when processing_attempts >= 5 then null else clock_timestamp() + interval '1 minute' end
      where id = p_photo_id;
  end if;
  return true;
end;
$$;

-- Photo deletion waits until all three private objects have disappeared.
create or replace function public.finish_photo_deletion(p_tenant_id uuid, p_gallery_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_photo public.photos%rowtype; v_derived_path text;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id and id = p_gallery_id) then
    raise exception 'Gallery access denied' using errcode = '42501';
  end if;
  select * into v_photo from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and id = p_photo_id for update;
  if not found then return true; end if;
  if v_photo.deletion_requested_at is null then return false; end if;
  v_derived_path := p_tenant_id::text || '/' || p_gallery_id::text || '/' || p_photo_id::text || '.webp';
  if exists (select 1 from storage.objects where bucket_id = 'gallery-originals' and name = v_photo.object_path)
    or exists (select 1 from storage.objects where bucket_id in ('gallery-previews', 'gallery-thumbnails')
      and name = v_derived_path) then return false; end if;
  delete from public.photos where id = p_photo_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return true;
end;
$$;

revoke all on function public.claim_photo_processing(uuid) from public, anon, authenticated, service_role;
revoke all on function public.finish_photo_processing(uuid, uuid, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_photo_processing(uuid) to service_role;
grant execute on function public.finish_photo_processing(uuid, uuid, text, integer, integer) to service_role;

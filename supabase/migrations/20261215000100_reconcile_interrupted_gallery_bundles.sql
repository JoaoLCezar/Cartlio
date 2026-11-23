alter table public.gallery_download_events
  add column download_batch_id uuid,
  add column bundle_position integer,
  add column reverted_at timestamptz,
  add constraint gallery_download_events_bundle_position_check check (
    (download_batch_id is null and bundle_position is null and reverted_at is null)
    or (download_batch_id is not null and bundle_position is not null and bundle_position between 1 and 500)
  );

create index gallery_download_events_bundle_idx
  on public.gallery_download_events(share_id, download_batch_id)
  where download_batch_id is not null;

create or replace function public.authorize_gallery_download(
  p_token text,
  p_photo_id uuid,
  p_access_token text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_share public.gallery_shares%rowtype; v_photo public.photos%rowtype; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null then return null; end if;
  select * into v_share from public.gallery_shares where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not v_share.downloads_enabled
    or not private.gallery_share_pin_authorized(v_share.id, p_access_token)
    or (v_share.share_mode = 'selection' and (v_share.submitted_at is null
      or not exists (select 1 from public.gallery_selection_items where share_id = v_share.id and photo_id = p_photo_id)))
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    return null;
  end if;
  select * into v_photo from public.photos where tenant_id = v_share.tenant_id and gallery_id = v_share.gallery_id
    and id = p_photo_id and processing_status = 'ready' and deletion_requested_at is null;
  if not found then return null; end if;
  select count(*)::integer into v_count from public.gallery_download_events
    where share_id = v_share.id and photo_id = p_photo_id and reverted_at is null;
  if v_count >= 3 then raise exception 'DOWNLOAD_LIMIT_REACHED' using errcode = '54000'; end if;
  insert into public.gallery_download_events(share_id, photo_id) values (v_share.id, p_photo_id);
  return jsonb_build_object('path', v_photo.object_path, 'filename', v_photo.original_filename, 'content_type', v_photo.content_type);
end;
$$;
revoke all on function public.authorize_gallery_download(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.authorize_gallery_download(text, uuid, text) to service_role;

create or replace function public.authorize_gallery_download_bundle(
  p_token text,
  p_access_token text default null,
  p_max_bytes bigint default 524288000
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_total_bytes bigint;
  v_photo_count integer;
  v_files jsonb;
  v_download_batch_id uuid := pg_catalog.gen_random_uuid();
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  if p_max_bytes is null or p_max_bytes not between 1 and 524288000 then
    raise exception 'DOWNLOAD_BUNDLE_SIZE_INVALID' using errcode = '22023';
  end if;

  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not v_share.downloads_enabled
    or not private.gallery_share_pin_authorized(v_share.id, p_access_token)
    or (v_share.share_mode = 'selection' and v_share.submitted_at is null)
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    return null;
  end if;

  with bundle_photos as materialized (
    select p.id, p.object_path, p.original_filename, p.content_type, p.byte_size,
      p.sort_order, p.created_at,
      row_number() over (order by p.sort_order, p.created_at desc, p.id) as bundle_position
    from public.photos p
    where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
      and (v_share.share_mode = 'delivery' or exists (
        select 1 from public.gallery_selection_items i
        where i.share_id = v_share.id and i.photo_id = p.id
      ))
  )
  select coalesce(sum(byte_size), 0)::bigint, count(*)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'photo_id', id,
      'path', object_path,
      'filename', original_filename,
      'content_type', content_type,
      'byte_size', byte_size
    ) order by sort_order, created_at desc, id) filter (where bundle_position <= 500), '[]'::jsonb)
    into v_total_bytes, v_photo_count, v_files
    from bundle_photos;

  if v_photo_count = 0 then return null; end if;
  if v_photo_count > 500 then
    raise exception 'DOWNLOAD_BUNDLE_TOO_MANY_FILES' using errcode = '54000';
  end if;
  if v_total_bytes > p_max_bytes then
    raise exception 'DOWNLOAD_BUNDLE_TOO_LARGE' using errcode = '54000';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_files) as selected(photo)
    where (select count(*) from public.gallery_download_events e
      where e.share_id = v_share.id and e.photo_id = (selected.photo->>'photo_id')::uuid
        and e.reverted_at is null) >= 3
  ) then
    raise exception 'DOWNLOAD_LIMIT_REACHED' using errcode = '54000';
  end if;

  insert into public.gallery_download_events(share_id, photo_id, download_batch_id, bundle_position)
    select v_share.id, (selected.photo->>'photo_id')::uuid, v_download_batch_id, selected.ordinal::integer
    from jsonb_array_elements(v_files) with ordinality as selected(photo, ordinal);

  return jsonb_build_object(
    'files', v_files,
    'total_bytes', v_total_bytes,
    'count', v_photo_count,
    'download_batch_id', v_download_batch_id
  );
end;
$$;
revoke all on function public.authorize_gallery_download_bundle(text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_gallery_download_bundle(text, text, bigint) to service_role;

create function public.release_interrupted_gallery_download_bundle(
  p_token text,
  p_download_batch_id uuid,
  p_completed_count integer
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_share_id uuid;
  v_released_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_download_batch_id is null then return 0; end if;
  if p_completed_count is null or p_completed_count not between 0 and 500 then
    raise exception 'DOWNLOAD_BUNDLE_PROGRESS_INVALID' using errcode = '22023';
  end if;

  select id into v_share_id from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found then return 0; end if;

  update public.gallery_download_events
    set reverted_at = clock_timestamp()
    where share_id = v_share_id and download_batch_id = p_download_batch_id
      and bundle_position > p_completed_count and reverted_at is null;
  get diagnostics v_released_count = row_count;
  return v_released_count;
end;
$$;
revoke all on function public.release_interrupted_gallery_download_bundle(text, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.release_interrupted_gallery_download_bundle(text, uuid, integer) to service_role;

create or replace function public.gallery_download_audit_counts(p_tenant_id uuid, p_gallery_id uuid)
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
    and e.reverted_at is null
    and (s.share_mode = 'delivery' or exists (
      select 1 from public.gallery_selection_items i
      where i.share_id = s.id and i.photo_id = e.photo_id
    ))
  group by e.share_id, e.photo_id;
end;
$$;
revoke all on function public.gallery_download_audit_counts(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.gallery_download_audit_counts(uuid, uuid) to authenticated;

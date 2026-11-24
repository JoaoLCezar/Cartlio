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

  select coalesce(sum(p.byte_size), 0)::bigint, count(*)::integer
    into v_total_bytes, v_photo_count
    from public.photos p
    where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
      and (v_share.share_mode = 'delivery' or exists (
        select 1 from public.gallery_selection_items i
        where i.share_id = v_share.id and i.photo_id = p.id
      ));

  if v_photo_count = 0 then return null; end if;
  if v_photo_count > 500 then
    raise exception 'DOWNLOAD_BUNDLE_TOO_MANY_FILES' using errcode = '54000';
  end if;
  if v_total_bytes > p_max_bytes then
    raise exception 'DOWNLOAD_BUNDLE_TOO_LARGE' using errcode = '54000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'path', p.object_path,
      'filename', p.original_filename,
      'content_type', p.content_type,
      'byte_size', p.byte_size
    ) order by p.sort_order, p.created_at desc, p.id), '[]'::jsonb)
    into v_files
    from public.photos p
    where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
      and (v_share.share_mode = 'delivery' or exists (
        select 1 from public.gallery_selection_items i
        where i.share_id = v_share.id and i.photo_id = p.id
      ));

  if exists (
    select 1 from public.photos p
    where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
      and (v_share.share_mode = 'delivery' or exists (
        select 1 from public.gallery_selection_items i
        where i.share_id = v_share.id and i.photo_id = p.id
      ))
      and (select count(*) from public.gallery_download_events e
        where e.share_id = v_share.id and e.photo_id = p.id) >= 3
  ) then
    raise exception 'DOWNLOAD_LIMIT_REACHED' using errcode = '54000';
  end if;

  insert into public.gallery_download_events(share_id, photo_id)
    select v_share.id, p.id from public.photos p
    where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
      and (v_share.share_mode = 'delivery' or exists (
        select 1 from public.gallery_selection_items i
        where i.share_id = v_share.id and i.photo_id = p.id
      ));

  return jsonb_build_object('files', v_files, 'total_bytes', v_total_bytes, 'count', v_photo_count);
end;
$$;

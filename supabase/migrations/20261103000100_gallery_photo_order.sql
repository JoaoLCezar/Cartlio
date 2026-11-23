alter table public.photos add column sort_order integer not null default 0;
create index photos_gallery_order_idx on public.photos(tenant_id, gallery_id, sort_order, created_at desc)
  where deletion_requested_at is null;

create function public.set_gallery_photo_order(p_tenant_id uuid, p_gallery_id uuid, p_photo_ids uuid[])
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_gallery uuid; v_photo_count integer; v_distinct_count integer; v_valid_count integer;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'PHOTO_ORDER_DENIED' using errcode = '42501';
  end if;
  select id into v_gallery from public.galleries
    where tenant_id = p_tenant_id and id = p_gallery_id for update;
  if not found then raise exception 'PHOTO_ORDER_DENIED' using errcode = '42501'; end if;
  if p_photo_ids is null then raise exception 'PHOTO_ORDER_INVALID' using errcode = '22023'; end if;

  select count(*)::integer into v_photo_count from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and deletion_requested_at is null;
  select count(distinct photo_id)::integer into v_distinct_count from unnest(p_photo_ids) as requested(photo_id);
  select count(*)::integer into v_valid_count from unnest(p_photo_ids) as requested(photo_id)
    join public.photos p on p.id = requested.photo_id and p.tenant_id = p_tenant_id and p.gallery_id = p_gallery_id
      and p.deletion_requested_at is null;
  if cardinality(p_photo_ids) <> v_photo_count or v_distinct_count <> v_photo_count or v_valid_count <> v_photo_count then
    raise exception 'PHOTO_ORDER_INVALID' using errcode = '22023';
  end if;

  update public.photos p set sort_order = requested.position::integer
    from unnest(p_photo_ids) with ordinality as requested(photo_id, position)
    where p.id = requested.photo_id and p.tenant_id = p_tenant_id and p.gallery_id = p_gallery_id
      and p.deletion_requested_at is null;
  return true;
end;
$$;

revoke all on function public.set_gallery_photo_order(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.set_gallery_photo_order(uuid, uuid, uuid[]) to authenticated;

create or replace function public.get_shared_gallery(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gallery public.galleries%rowtype; v_share public.gallery_shares%rowtype; v_photos jsonb; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256')
      and revoked_at is null and expires_at > clock_timestamp();
  if not found then return null; end if;
  select * into v_gallery from public.galleries where tenant_id = v_share.tenant_id
    and id = v_share.gallery_id and status = 'published';
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.original_filename,
    'selected', exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id))
    order by p.sort_order, p.created_at desc, p.id), '[]'::jsonb)
    into v_photos from public.photos p where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'selected_count', v_count, 'selection_limit', v_share.selection_limit,
    'submitted_at', v_share.submitted_at, 'downloads_enabled', v_share.downloads_enabled);
end;
$$;

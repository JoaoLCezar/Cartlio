create extension if not exists pg_trgm with schema extensions;

-- PostgreSQL marks unaccent as STABLE because dictionaries can be changed.
-- Cartlio uses the installed dictionary as fixed normalization data for these indexes.
create or replace function public.gallery_photo_search_text(p_value text)
returns text
language sql immutable strict parallel safe set search_path = '' as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, lower(p_value))
$$;
comment on function public.gallery_photo_search_text(text) is
  'Normalizes gallery filenames for indexed accent-insensitive search; rebuild its trigram index if the unaccent dictionary changes.';
revoke all on function public.gallery_photo_search_text(text) from public, anon, authenticated;
grant execute on function public.gallery_photo_search_text(text) to authenticated, service_role;

create index photos_shared_gallery_ready_order_idx
  on public.photos (tenant_id, gallery_id, sort_order, created_at desc, id)
  include (original_filename)
  where processing_status = 'ready' and deletion_requested_at is null;

create index photos_shared_gallery_filename_trgm_idx
  on public.photos using gin (public.gallery_photo_search_text(original_filename) extensions.gin_trgm_ops)
  where processing_status = 'ready' and deletion_requested_at is null;

create or replace function public.get_shared_gallery_photo_page(
  p_token text,
  p_access_token text default null,
  p_offset integer default 0,
  p_limit integer default 60,
  p_search text default null,
  p_selected_only boolean default false
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_query text;
  v_search_pattern text;
  v_total_count integer;
  v_photos jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000
    or p_limit is null or p_limit < 1 or p_limit > 60
    or char_length(btrim(coalesce(p_search, ''))) > 120 then
    raise exception 'PHOTO_PAGE_INVALID' using errcode = '22023';
  end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256')
      and revoked_at is null and expires_at > clock_timestamp();
  if not found or not exists (
    select 1 from public.galleries g where g.tenant_id = v_share.tenant_id
      and g.id = v_share.gallery_id and g.status = 'published'
  ) then return null; end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then
    return jsonb_build_object('pin_required', true);
  end if;
  if p_selected_only and v_share.share_mode <> 'selection' then
    raise exception 'PHOTO_PAGE_FILTER_INVALID' using errcode = '22023';
  end if;

  v_query := nullif(public.gallery_photo_search_text(btrim(coalesce(p_search, ''))), '');
  if v_query is not null then
    v_search_pattern := '%' || replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  end if;

  if v_query is null then
    select count(*)::integer into v_total_count from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
        and (not p_selected_only or exists (
          select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id
        ));
    select coalesce(jsonb_agg(jsonb_build_object('id', page.id, 'name', page.original_filename, 'selected', page.selected)
      order by page.sort_order, page.created_at desc, page.id), '[]'::jsonb)
      into v_photos
      from (
        select p.id, p.original_filename, p.sort_order, p.created_at,
          exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as selected
        from public.photos p
        where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
          and p.processing_status = 'ready' and p.deletion_requested_at is null
          and (not p_selected_only or exists (
            select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id
          ))
        order by p.sort_order, p.created_at desc, p.id
        limit p_limit offset p_offset
      ) page;
  else
    select count(*)::integer into v_total_count from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
        and public.gallery_photo_search_text(p.original_filename) like v_search_pattern escape E'\\'
        and (not p_selected_only or exists (
          select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id
        ));
    select coalesce(jsonb_agg(jsonb_build_object('id', page.id, 'name', page.original_filename, 'selected', page.selected)
      order by page.sort_order, page.created_at desc, page.id), '[]'::jsonb)
      into v_photos
      from (
        select p.id, p.original_filename, p.sort_order, p.created_at,
          exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as selected
        from public.photos p
        where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
          and p.processing_status = 'ready' and p.deletion_requested_at is null
          and public.gallery_photo_search_text(p.original_filename) like v_search_pattern escape E'\\'
          and (not p_selected_only or exists (
            select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id
          ))
        order by p.sort_order, p.created_at desc, p.id
        limit p_limit offset p_offset
      ) page;
  end if;

  return jsonb_build_object('photos', v_photos, 'total_count', v_total_count, 'offset', p_offset, 'limit', p_limit);
end;
$$;
revoke all on function public.get_shared_gallery_photo_page(text, text, integer, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.get_shared_gallery_photo_page(text, text, integer, integer, text, boolean) to anon, authenticated;

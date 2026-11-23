-- Change only the default public brand. Studio names and share permissions are preserved.
create or replace function public.get_shared_gallery(p_token text, p_access_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_gallery public.galleries%rowtype;
  v_share public.gallery_shares%rowtype;
  v_photos jsonb;
  v_selected_photo_ids jsonb;
  v_cover_photo_id uuid;
  v_photo_count integer;
  v_selected_count integer;
  v_brand_name text;
  v_brand_color text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256')
      and revoked_at is null and expires_at > clock_timestamp();
  if not found then return null; end if;
  select * into v_gallery from public.galleries where tenant_id = v_share.tenant_id
    and id = v_share.gallery_id and status = 'published';
  if not found then return null; end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then
    return jsonb_build_object('pin_required', true);
  end if;

  select coalesce(nullif(btrim(t.public_brand_name), ''), 'Quadrics'), t.brand_color
    into v_brand_name, v_brand_color from public.tenants t where t.id = v_share.tenant_id;
  select p.id into v_cover_photo_id from public.photos p
    where p.id = v_gallery.cover_photo_id and p.tenant_id = v_share.tenant_id
      and p.gallery_id = v_share.gallery_id and p.processing_status = 'ready'
      and p.deletion_requested_at is null;
  if v_cover_photo_id is null then
    select p.id into v_cover_photo_id from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
      order by p.sort_order, p.created_at desc, p.id limit 1;
  end if;

  select count(*)::integer into v_photo_count from public.photos p
    where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'name', page.original_filename,
    'selected', page.selected, 'client_note', page.client_note
  ) order by page.sort_order, page.created_at desc, page.id), '[]'::jsonb)
    into v_photos
    from (
      select p.id, p.original_filename, p.sort_order, p.created_at,
        exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as selected,
        (select i.client_note from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as client_note
      from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
      order by p.sort_order, p.created_at desc, p.id limit 60
    ) page;
  select coalesce(jsonb_agg(i.photo_id order by p.sort_order, p.created_at desc, p.id), '[]'::jsonb), count(*)::integer
    into v_selected_photo_ids, v_selected_count
    from public.gallery_selection_items i
    join public.photos p on p.id = i.photo_id and p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
    where i.share_id = v_share.id;

  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'photo_count', v_photo_count, 'selected_photo_ids', v_selected_photo_ids,
    'cover_photo_id', v_cover_photo_id, 'selected_count', v_selected_count, 'selection_limit', v_share.selection_limit,
    'submitted_at', v_share.submitted_at, 'downloads_enabled', v_share.downloads_enabled,
    'share_mode', v_share.share_mode, 'brand_name', v_brand_name, 'brand_color', v_brand_color,
    'revision_message', case when v_share.submitted_at is null then v_share.revision_message else null end);
end;
$$;
revoke all on function public.get_shared_gallery(text, text) from public, anon, authenticated;
grant execute on function public.get_shared_gallery(text, text) to anon, authenticated;

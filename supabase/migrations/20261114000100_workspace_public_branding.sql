alter table public.tenants
  add column public_brand_name text,
  add column brand_color text not null default '#c7a67a';

alter table public.tenants
  add constraint tenants_public_brand_name_check
    check (public_brand_name is null or char_length(btrim(public_brand_name)) between 1 and 120),
  add constraint tenants_brand_color_check
    check (brand_color ~ '^#[0-9a-f]{6}$');

create function public.set_tenant_public_brand(
  p_tenant_id uuid,
  p_brand_name text,
  p_brand_color text
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or p_tenant_id is null or not private.is_tenant_owner(p_tenant_id) then
    raise exception 'BRAND_UPDATE_DENIED' using errcode = '42501';
  end if;
  if p_brand_name is not null and char_length(btrim(p_brand_name)) not between 1 and 120 then
    raise exception 'BRAND_NAME_INVALID' using errcode = '22023';
  end if;
  if p_brand_color is null or p_brand_color !~* '^#[0-9a-f]{6}$' then
    raise exception 'BRAND_COLOR_INVALID' using errcode = '22023';
  end if;

  update public.tenants
    set public_brand_name = nullif(btrim(p_brand_name), ''), brand_color = lower(p_brand_color)
    where id = p_tenant_id;
  return found;
end;
$$;
revoke all on function public.set_tenant_public_brand(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_tenant_public_brand(uuid, text, text) to authenticated;

create or replace function public.get_shared_gallery(p_token text, p_access_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_gallery public.galleries%rowtype;
  v_share public.gallery_shares%rowtype;
  v_photos jsonb;
  v_count integer;
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

  select coalesce(nullif(btrim(t.public_brand_name), ''), t.name), t.brand_color
    into v_brand_name, v_brand_color
    from public.tenants t where t.id = v_share.tenant_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.original_filename,
    'selected', exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id))
    order by p.sort_order, p.created_at desc, p.id), '[]'::jsonb)
    into v_photos from public.photos p where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'selected_count', v_count, 'selection_limit', v_share.selection_limit,
    'submitted_at', v_share.submitted_at, 'downloads_enabled', v_share.downloads_enabled,
    'share_mode', v_share.share_mode, 'brand_name', v_brand_name, 'brand_color', v_brand_color);
end;
$$;
revoke all on function public.get_shared_gallery(text, text) from public, anon, authenticated;
grant execute on function public.get_shared_gallery(text, text) to anon, authenticated;

alter table public.gallery_shares
  add column revision_requested_at timestamptz,
  add column revision_message text check (
    revision_message is null or char_length(btrim(revision_message)) between 2 and 500
  );
grant select (revision_requested_at, revision_message) on public.gallery_shares to authenticated;

create table public.gallery_selection_revisions (
  id uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.gallery_shares(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  submitted_at timestamptz not null,
  submitted_name text not null check (char_length(btrim(submitted_name)) between 2 and 80),
  revision_message text not null check (char_length(btrim(revision_message)) between 2 and 500),
  requested_at timestamptz not null default clock_timestamp(),
  unique (share_id, revision_number),
  unique (share_id, id)
);
create index gallery_selection_revisions_share_idx
  on public.gallery_selection_revisions(share_id, revision_number desc);

create table public.gallery_selection_revision_items (
  revision_id uuid not null references public.gallery_selection_revisions(id) on delete cascade,
  photo_id uuid not null,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  primary key (revision_id, photo_id)
);
alter table public.gallery_selection_revisions enable row level security;
alter table public.gallery_selection_revision_items enable row level security;
revoke all on public.gallery_selection_revisions, public.gallery_selection_revision_items from public, anon, authenticated;
grant select (id, share_id, revision_number, submitted_at, submitted_name, revision_message, requested_at)
  on public.gallery_selection_revisions to authenticated;
grant select (revision_id, photo_id, original_filename)
  on public.gallery_selection_revision_items to authenticated;
create policy gallery_selection_revisions_select_member on public.gallery_selection_revisions for select to authenticated
  using (exists (select 1 from public.gallery_shares s where s.id = share_id and private.is_tenant_member(s.tenant_id)));
create policy gallery_selection_revision_items_select_member on public.gallery_selection_revision_items for select to authenticated
  using (exists (
    select 1 from public.gallery_selection_revisions r
      join public.gallery_shares s on s.id = r.share_id
    where r.id = revision_id and private.is_tenant_member(s.tenant_id)
  ));

create function public.request_gallery_selection_revision(
  p_tenant_id uuid, p_gallery_id uuid, p_share_id uuid, p_message text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_revision_id uuid;
  v_revision_number integer;
  v_item_count integer;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'SELECTION_REVISION_DENIED' using errcode = '42501';
  end if;
  if p_message is null or char_length(btrim(p_message)) not between 2 and 500 then
    raise exception 'SELECTION_REVISION_MESSAGE_INVALID' using errcode = '22023';
  end if;
  perform 1 from public.galleries
    where tenant_id = p_tenant_id and id = p_gallery_id and status = 'published' for update;
  if not found then raise exception 'SELECTION_REVISION_DENIED' using errcode = '42501'; end if;

  select * into v_share from public.gallery_shares
    where id = p_share_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp() then
    raise exception 'SELECTION_REVISION_DENIED' using errcode = '42501';
  end if;
  if v_share.share_mode <> 'selection' then
    raise exception 'SELECTION_MODE_DISABLED' using errcode = '42501';
  end if;
  if v_share.submitted_at is null or v_share.submitted_name is null then
    raise exception 'SELECTION_NOT_SUBMITTED' using errcode = '42501';
  end if;

  select count(*)::integer into v_item_count from public.gallery_selection_items where share_id = v_share.id;
  if v_item_count = 0 then raise exception 'SELECTION_EMPTY' using errcode = '22023'; end if;
  select coalesce(max(revision_number), 0) + 1 into v_revision_number
    from public.gallery_selection_revisions where share_id = v_share.id;

  insert into public.gallery_selection_revisions(share_id, revision_number, submitted_at, submitted_name, revision_message)
    values (v_share.id, v_revision_number, v_share.submitted_at, v_share.submitted_name, btrim(p_message))
    returning id into v_revision_id;
  insert into public.gallery_selection_revision_items(revision_id, photo_id, original_filename)
    select v_revision_id, photo_id, original_filename from public.gallery_selection_items where share_id = v_share.id;

  -- Keep only still-visible photos as the client's starting point for revision.
  delete from public.gallery_selection_items i where i.share_id = v_share.id and not exists (
    select 1 from public.photos p where p.id = i.photo_id and p.tenant_id = p_tenant_id
      and p.gallery_id = p_gallery_id and p.processing_status = 'ready' and p.deletion_requested_at is null
  );
  update public.gallery_shares set submitted_at = null, submitted_name = null,
    revision_requested_at = clock_timestamp(), revision_message = btrim(p_message), downloads_enabled = false
    where id = v_share.id;
  return true;
end;
$$;
revoke all on function public.request_gallery_selection_revision(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.request_gallery_selection_revision(uuid, uuid, uuid, text) to authenticated;

create or replace function public.submit_gallery_selection(p_token text, p_client_name text, p_access_token text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_share public.gallery_shares%rowtype; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'SELECTION_INVALID' using errcode = '22023'; end if;
  select * into v_share from public.gallery_shares where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then return false; end if;
  if v_share.share_mode <> 'selection' then
    raise exception 'SELECTION_MODE_DISABLED' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then return true; end if;
  if p_client_name is null or char_length(btrim(p_client_name)) not between 2 and 80 then
    raise exception 'CLIENT_NAME_INVALID' using errcode = '22023';
  end if;
  delete from public.gallery_selection_items i where i.share_id = v_share.id and not exists (
    select 1 from public.photos p where p.id = i.photo_id and p.tenant_id = v_share.tenant_id
      and p.gallery_id = v_share.gallery_id and p.processing_status = 'ready' and p.deletion_requested_at is null
  );
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  if v_count = 0 then return false; end if;
  update public.gallery_shares set submitted_at = clock_timestamp(), submitted_name = btrim(p_client_name),
    revision_requested_at = null, revision_message = null
    where id = v_share.id;
  return true;
end;
$$;
revoke all on function public.submit_gallery_selection(text, text, text) from public, anon, authenticated;
grant execute on function public.submit_gallery_selection(text, text, text) to anon, authenticated;

create or replace function public.get_shared_gallery(p_token text, p_access_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_gallery public.galleries%rowtype;
  v_share public.gallery_shares%rowtype;
  v_photos jsonb;
  v_cover_photo_id uuid;
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

  select coalesce(nullif(btrim(t.public_brand_name), ''), 'Cartlio'), t.brand_color
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
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.original_filename,
    'selected', exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id))
    order by p.sort_order, p.created_at desc, p.id), '[]'::jsonb)
    into v_photos from public.photos p where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'cover_photo_id', v_cover_photo_id, 'selected_count', v_count, 'selection_limit', v_share.selection_limit,
    'submitted_at', v_share.submitted_at, 'downloads_enabled', v_share.downloads_enabled,
    'share_mode', v_share.share_mode, 'brand_name', v_brand_name, 'brand_color', v_brand_color,
    'revision_message', case when v_share.submitted_at is null then v_share.revision_message else null end);
end;
$$;
revoke all on function public.get_shared_gallery(text, text) from public, anon, authenticated;
grant execute on function public.get_shared_gallery(text, text) to anon, authenticated;

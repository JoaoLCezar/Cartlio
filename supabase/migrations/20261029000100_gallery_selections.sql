-- A link represents one shared draft and one final submission. Anonymous
-- visitors need its bearer token for every mutation; no table writes granted.
alter table public.gallery_shares
  add column submitted_at timestamptz,
  add column submitted_name text check (submitted_name is null or char_length(btrim(submitted_name)) between 2 and 80);
grant select (submitted_at, submitted_name) on public.gallery_shares to authenticated;

create table public.gallery_selection_items (
  share_id uuid not null references public.gallery_shares(id) on delete cascade,
  photo_id uuid not null,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  selected_at timestamptz not null default now(),
  primary key (share_id, photo_id)
);
create index gallery_selection_items_photo_idx on public.gallery_selection_items(photo_id);
alter table public.gallery_selection_items enable row level security;
revoke all on public.gallery_selection_items from public, anon, authenticated;
grant select (share_id, photo_id, original_filename, selected_at) on public.gallery_selection_items to authenticated;
create policy gallery_selection_items_select_member on public.gallery_selection_items for select to authenticated
  using (exists (select 1 from public.gallery_shares s where s.id = share_id and private.is_tenant_member(s.tenant_id)));

create function public.set_gallery_selection(p_token text, p_photo_id uuid, p_selected boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_share public.gallery_shares%rowtype; v_photo public.photos%rowtype; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null or p_selected is null then
    raise exception 'SELECTION_INVALID' using errcode = '22023';
  end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then raise exception 'SELECTION_SUBMITTED' using errcode = '42501'; end if;
  if p_selected then
    select * into v_photo from public.photos where tenant_id = v_share.tenant_id
      and gallery_id = v_share.gallery_id and id = p_photo_id
      and processing_status = 'ready' and deletion_requested_at is null;
    if not found then raise exception 'PHOTO_NOT_SELECTABLE' using errcode = '42501'; end if;
    select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
    if v_count >= 500 and not exists (select 1 from public.gallery_selection_items
      where share_id = v_share.id and photo_id = p_photo_id) then
      raise exception 'SELECTION_LIMIT' using errcode = '22023';
    end if;
    insert into public.gallery_selection_items (share_id, photo_id, original_filename)
      values (v_share.id, v_photo.id, v_photo.original_filename) on conflict do nothing;
  else
    delete from public.gallery_selection_items where share_id = v_share.id and photo_id = p_photo_id;
  end if;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return v_count;
end;
$$;

create function public.submit_gallery_selection(p_token text, p_client_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_share public.gallery_shares%rowtype; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'SELECTION_INVALID' using errcode = '22023'; end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then return true; end if;
  if p_client_name is null or char_length(btrim(p_client_name)) not between 2 and 80 then
    raise exception 'CLIENT_NAME_INVALID' using errcode = '22023';
  end if;
  -- Draft items can become unavailable while the client is choosing.
  delete from public.gallery_selection_items i where i.share_id = v_share.id and not exists (
    select 1 from public.photos p where p.id = i.photo_id and p.tenant_id = v_share.tenant_id
      and p.gallery_id = v_share.gallery_id and p.processing_status = 'ready' and p.deletion_requested_at is null
  );
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  if v_count = 0 then return false; end if;
  update public.gallery_shares set submitted_at = clock_timestamp(), submitted_name = btrim(p_client_name)
    where id = v_share.id;
  return true;
end;
$$;

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
    order by p.created_at, p.id), '[]'::jsonb)
    into v_photos from public.photos p where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
    and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'selected_count', v_count, 'submitted_at', v_share.submitted_at);
end;
$$;

revoke all on function public.set_gallery_selection(text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.submit_gallery_selection(text, text) from public, anon, authenticated;
grant execute on function public.set_gallery_selection(text, uuid, boolean) to anon, authenticated;
grant execute on function public.submit_gallery_selection(text, text) to anon, authenticated;

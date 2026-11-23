-- Original downloads are a separate permission from preview access. A link
-- owner must enable them, and visitors can request only submitted selections.
alter table public.gallery_shares add column downloads_enabled boolean not null default false;
grant select (downloads_enabled) on public.gallery_shares to authenticated;

create table public.gallery_download_events (
  id bigint generated always as identity primary key,
  share_id uuid not null references public.gallery_shares(id) on delete cascade,
  photo_id uuid not null,
  created_at timestamptz not null default now()
);
create index gallery_download_events_share_idx on public.gallery_download_events(share_id, created_at desc);
alter table public.gallery_download_events enable row level security;
revoke all on public.gallery_download_events from public, anon, authenticated;
grant select (share_id, photo_id, created_at) on public.gallery_download_events to authenticated;
create policy gallery_download_events_select_member on public.gallery_download_events for select to authenticated
  using (exists (select 1 from public.gallery_shares s where s.id = share_id and private.is_tenant_member(s.tenant_id)));

create function public.set_gallery_share_downloads(p_tenant_id uuid, p_gallery_id uuid, p_share_id uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) or p_enabled is null
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id and id = p_gallery_id) then
    raise exception 'DOWNLOAD_PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.gallery_shares set downloads_enabled = p_enabled
    where id = p_share_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return found;
end;
$$;

-- This capability is callable only by the trusted server using its secret
-- key. It records and rate-limits grants before a short-lived URL is issued.
create function public.authorize_gallery_download(p_token text, p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_share public.gallery_shares%rowtype; v_photo public.photos%rowtype; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null then return null; end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not v_share.downloads_enabled or v_share.submitted_at is null
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published')
    or not exists (select 1 from public.gallery_selection_items where share_id = v_share.id and photo_id = p_photo_id) then
    return null;
  end if;
  select * into v_photo from public.photos where tenant_id = v_share.tenant_id and gallery_id = v_share.gallery_id
    and id = p_photo_id and processing_status = 'ready' and deletion_requested_at is null;
  if not found then return null; end if;
  select count(*)::integer into v_count from public.gallery_download_events
    where share_id = v_share.id and photo_id = p_photo_id;
  if v_count >= 3 then raise exception 'DOWNLOAD_LIMIT_REACHED' using errcode = '54000'; end if;
  insert into public.gallery_download_events(share_id, photo_id) values (v_share.id, p_photo_id);
  return jsonb_build_object('path', v_photo.object_path, 'filename', v_photo.original_filename, 'content_type', v_photo.content_type);
end;
$$;

revoke all on function public.set_gallery_share_downloads(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.authorize_gallery_download(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_gallery_share_downloads(uuid, uuid, uuid, boolean) to authenticated;
grant execute on function public.authorize_gallery_download(text, uuid) to service_role;

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
    'photos', v_photos, 'selected_count', v_count, 'submitted_at', v_share.submitted_at,
    'downloads_enabled', v_share.downloads_enabled);
end;
$$;

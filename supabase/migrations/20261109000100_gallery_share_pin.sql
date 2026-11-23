alter table public.gallery_shares
  add column pin_hash text,
  add column pin_failed_attempts integer not null default 0 check (pin_failed_attempts between 0 and 5),
  add column pin_locked_until timestamptz,
  add column pin_enabled boolean generated always as (pin_hash is not null) stored;
grant select (pin_enabled) on public.gallery_shares to authenticated;

create table public.gallery_share_pin_sessions (
  id uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.gallery_shares(id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index gallery_share_pin_sessions_share_expiry_idx
  on public.gallery_share_pin_sessions(share_id, expires_at);
alter table public.gallery_share_pin_sessions enable row level security;
revoke all on public.gallery_share_pin_sessions from public, anon, authenticated;

create function private.gallery_share_pin_authorized(p_share_id uuid, p_access_token text)
returns boolean language sql security definer set search_path = '' as $$
  select exists (
    select 1 from public.gallery_shares s
    where s.id = p_share_id and s.revoked_at is null and s.expires_at > clock_timestamp()
      and (s.pin_hash is null or exists (
        select 1 from public.gallery_share_pin_sessions pin_session
        where pin_session.share_id = s.id
          and pin_session.token_hash = extensions.digest(p_access_token, 'sha256')
          and pin_session.expires_at > clock_timestamp()
      ))
  );
$$;
revoke all on function private.gallery_share_pin_authorized(uuid, text) from public, anon, authenticated;

create function public.create_gallery_pin_session(p_token text, p_pin text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_access_token text;
  v_session_expiry timestamptz;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_pin is null or p_pin !~ '^[0-9]{6,12}$' then
    return null;
  end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or v_share.pin_hash is null
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    return null;
  end if;
  if v_share.pin_locked_until > clock_timestamp() then return null; end if;
  if v_share.pin_locked_until is not null then
    update public.gallery_shares set pin_failed_attempts = 0, pin_locked_until = null where id = v_share.id;
    v_share.pin_failed_attempts := 0;
    v_share.pin_locked_until := null;
  end if;
  if extensions.crypt(p_pin, v_share.pin_hash) is distinct from v_share.pin_hash then
    if v_share.pin_failed_attempts >= 4 then
      update public.gallery_shares set pin_failed_attempts = 5,
        pin_locked_until = clock_timestamp() + interval '1 hour' where id = v_share.id;
    else
      update public.gallery_shares set pin_failed_attempts = pin_failed_attempts + 1 where id = v_share.id;
    end if;
    return null;
  end if;

  update public.gallery_shares set pin_failed_attempts = 0, pin_locked_until = null where id = v_share.id;
  delete from public.gallery_share_pin_sessions where expires_at <= clock_timestamp();
  v_access_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_session_expiry := least(v_share.expires_at, clock_timestamp() + interval '12 hours');
  insert into public.gallery_share_pin_sessions(share_id, token_hash, expires_at)
    values (v_share.id, extensions.digest(v_access_token, 'sha256'), v_session_expiry);
  return v_access_token;
end;
$$;
revoke all on function public.create_gallery_pin_session(text, text) from public, anon, authenticated;
grant execute on function public.create_gallery_pin_session(text, text) to anon, authenticated;

create function private.revoke_gallery_share_pin_sessions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    delete from public.gallery_share_pin_sessions where share_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.revoke_gallery_share_pin_sessions() from public, anon, authenticated;
create trigger revoke_gallery_share_pin_sessions
  after update of revoked_at on public.gallery_shares
  for each row execute function private.revoke_gallery_share_pin_sessions();

drop function public.create_gallery_share(uuid, uuid, timestamptz, integer, text);
create function public.create_gallery_share(
  p_tenant_id uuid,
  p_gallery_id uuid,
  p_expires_at timestamptz,
  p_selection_limit integer,
  p_share_mode text,
  p_pin text default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
  v_selection_limit integer;
  v_pin_hash text;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id
      and id = p_gallery_id and status = 'published') then
    raise exception 'Gallery sharing denied' using errcode = '42501';
  end if;
  if p_expires_at is null or p_expires_at < clock_timestamp() + interval '1 hour'
    or p_expires_at > clock_timestamp() + interval '30 days' then
    raise exception 'SHARE_EXPIRY_INVALID' using errcode = '22023';
  end if;
  if p_share_mode not in ('selection', 'delivery') or p_share_mode is null then
    raise exception 'SHARE_MODE_INVALID' using errcode = '22023';
  end if;
  if p_share_mode = 'selection' and (p_selection_limit is null or p_selection_limit not between 1 and 500) then
    raise exception 'SELECTION_LIMIT_INVALID' using errcode = '22023';
  end if;
  if p_pin is not null and p_pin !~ '^[0-9]{6,12}$' then
    raise exception 'SHARE_PIN_INVALID' using errcode = '22023';
  end if;

  v_selection_limit := case when p_share_mode = 'delivery' then 500 else p_selection_limit end;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  if p_pin is not null then v_pin_hash := extensions.crypt(p_pin, extensions.gen_salt('bf', 10)); end if;
  insert into public.gallery_shares
    (tenant_id, gallery_id, token_hash, expires_at, created_by, selection_limit, share_mode, downloads_enabled, pin_hash)
  values
    (p_tenant_id, p_gallery_id, extensions.digest(v_token, 'sha256'), p_expires_at, auth.uid(),
      v_selection_limit, p_share_mode, p_share_mode = 'delivery', v_pin_hash);
  return v_token;
end;
$$;
revoke all on function public.create_gallery_share(uuid, uuid, timestamptz, integer, text, text) from public, anon, authenticated;
grant execute on function public.create_gallery_share(uuid, uuid, timestamptz, integer, text, text) to authenticated;

drop function public.get_shared_gallery(text);
create function public.get_shared_gallery(p_token text, p_access_token text default null)
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
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then
    return jsonb_build_object('pin_required', true);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.original_filename,
    'selected', exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id))
    order by p.sort_order, p.created_at desc, p.id), '[]'::jsonb)
    into v_photos from public.photos p where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'selected_count', v_count, 'selection_limit', v_share.selection_limit,
    'submitted_at', v_share.submitted_at, 'downloads_enabled', v_share.downloads_enabled,
    'share_mode', v_share.share_mode);
end;
$$;
revoke all on function public.get_shared_gallery(text, text) from public, anon, authenticated;
grant execute on function public.get_shared_gallery(text, text) to anon, authenticated;

drop function public.resolve_shared_photo(text, uuid);
create function public.resolve_shared_photo(p_token text, p_photo_id uuid, p_access_token text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null then return null; end if;
  select p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp' into v_path
    from public.gallery_shares s
    join public.galleries g on g.tenant_id = s.tenant_id and g.id = s.gallery_id
    join public.photos p on p.tenant_id = s.tenant_id and p.gallery_id = s.gallery_id
    where s.token_hash = extensions.digest(p_token, 'sha256') and s.revoked_at is null
      and s.expires_at > clock_timestamp() and g.status = 'published'
      and p.id = p_photo_id and p.processing_status = 'ready' and p.deletion_requested_at is null
      and private.gallery_share_pin_authorized(s.id, p_access_token);
  return v_path;
end;
$$;
revoke all on function public.resolve_shared_photo(text, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_shared_photo(text, uuid, text) to anon, authenticated;

drop function public.set_gallery_selection(text, uuid, boolean);
create function public.set_gallery_selection(p_token text, p_photo_id uuid, p_selected boolean, p_access_token text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_share public.gallery_shares%rowtype; v_photo public.photos%rowtype; v_count integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null or p_selected is null then
    raise exception 'SELECTION_INVALID' using errcode = '22023';
  end if;
  select * into v_share from public.gallery_shares where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then return -1; end if;
  if v_share.share_mode <> 'selection' then
    raise exception 'SELECTION_MODE_DISABLED' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then raise exception 'SELECTION_SUBMITTED' using errcode = '42501'; end if;
  if p_selected then
    select * into v_photo from public.photos where tenant_id = v_share.tenant_id
      and gallery_id = v_share.gallery_id and id = p_photo_id
      and processing_status = 'ready' and deletion_requested_at is null;
    if not found then raise exception 'PHOTO_NOT_SELECTABLE' using errcode = '42501'; end if;
    select count(*)::integer into v_count from public.gallery_selection_items where share_id = v_share.id;
    if v_count >= v_share.selection_limit and not exists (select 1 from public.gallery_selection_items
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
revoke all on function public.set_gallery_selection(text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.set_gallery_selection(text, uuid, boolean, text) to anon, authenticated;

drop function public.submit_gallery_selection(text, text);
create function public.submit_gallery_selection(p_token text, p_client_name text, p_access_token text default null)
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
  update public.gallery_shares set submitted_at = clock_timestamp(), submitted_name = btrim(p_client_name)
    where id = v_share.id;
  return true;
end;
$$;
revoke all on function public.submit_gallery_selection(text, text, text) from public, anon, authenticated;
grant execute on function public.submit_gallery_selection(text, text, text) to anon, authenticated;

drop function public.authorize_gallery_download(text, uuid);
create function public.authorize_gallery_download(p_token text, p_photo_id uuid, p_access_token text default null)
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
    where share_id = v_share.id and photo_id = p_photo_id;
  if v_count >= 3 then raise exception 'DOWNLOAD_LIMIT_REACHED' using errcode = '54000'; end if;
  insert into public.gallery_download_events(share_id, photo_id) values (v_share.id, p_photo_id);
  return jsonb_build_object('path', v_photo.object_path, 'filename', v_photo.original_filename, 'content_type', v_photo.content_type);
end;
$$;
revoke all on function public.authorize_gallery_download(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.authorize_gallery_download(text, uuid, text) to service_role;

create table private.gallery_share_selection_rate_limits (
  share_id uuid primary key references public.gallery_shares(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count between 1 and 300),
  updated_at timestamptz not null default clock_timestamp()
);
create index gallery_share_selection_rate_limits_updated_idx
  on private.gallery_share_selection_rate_limits(updated_at);
alter table private.gallery_share_selection_rate_limits enable row level security;
revoke all on private.gallery_share_selection_rate_limits from public, anon, authenticated, service_role;

create function private.consume_gallery_selection_write_limit(p_share_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz;
  v_window_started_at timestamptz;
  v_request_count integer;
begin
  if p_share_id is null then
    raise exception 'SELECTION_RATE_LIMIT_INVALID' using errcode = '22023';
  end if;
  v_now := clock_timestamp();

  insert into private.gallery_share_selection_rate_limits as rate
    (share_id, window_started_at, request_count, updated_at)
  values (p_share_id, v_now, 1, v_now)
  on conflict (share_id) do update set
    window_started_at = case
      when rate.window_started_at <= v_now - interval '1 minute' then v_now
      else rate.window_started_at
    end,
    request_count = case
      when rate.window_started_at <= v_now - interval '1 minute' then 1
      else rate.request_count + 1
    end,
    updated_at = v_now
  where rate.request_count < 300 or rate.window_started_at <= v_now - interval '1 minute'
  returning request_count, window_started_at into v_request_count, v_window_started_at;

  if found then return 0; end if;

  select rate.window_started_at into v_window_started_at
    from private.gallery_share_selection_rate_limits rate where rate.share_id = p_share_id;
  if not found then return 60; end if;
  return greatest(1, ceil(extract(epoch from v_window_started_at + interval '1 minute' - v_now))::integer);
end;
$$;
revoke all on function private.consume_gallery_selection_write_limit(uuid) from public, anon, authenticated, service_role;

create or replace function public.set_gallery_selection(
  p_token text,
  p_photo_id uuid,
  p_selected boolean,
  p_access_token text default null
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_photo public.photos%rowtype;
  v_count integer;
  v_retry_after integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null or p_selected is null then
    raise exception 'SELECTION_INVALID' using errcode = '22023';
  end if;
  select * into v_share from public.gallery_shares s
    where s.token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries g where g.tenant_id = v_share.tenant_id
      and g.id = v_share.gallery_id and g.status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then return -1; end if;
  if v_share.share_mode <> 'selection' then
    raise exception 'SELECTION_MODE_DISABLED' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then raise exception 'SELECTION_SUBMITTED' using errcode = '42501'; end if;

  v_retry_after := private.consume_gallery_selection_write_limit(v_share.id);
  if v_retry_after > 0 then
    raise exception 'SELECTION_RATE_LIMITED' using errcode = 'PT429', detail = v_retry_after::text;
  end if;

  if p_selected then
    select * into v_photo from public.photos p where p.tenant_id = v_share.tenant_id
      and p.gallery_id = v_share.gallery_id and p.id = p_photo_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
    if not found then raise exception 'PHOTO_NOT_SELECTABLE' using errcode = '42501'; end if;
    select count(*)::integer into v_count from public.gallery_selection_items i where i.share_id = v_share.id;
    if v_count >= v_share.selection_limit and not exists (
      select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p_photo_id
    ) then
      raise exception 'SELECTION_LIMIT' using errcode = '22023';
    end if;
    insert into public.gallery_selection_items (share_id, photo_id, original_filename)
      values (v_share.id, v_photo.id, v_photo.original_filename) on conflict do nothing;
  else
    delete from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p_photo_id;
  end if;
  select count(*)::integer into v_count from public.gallery_selection_items i where i.share_id = v_share.id;
  return v_count;
end;
$$;
revoke all on function public.set_gallery_selection(text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.set_gallery_selection(text, uuid, boolean, text) to anon, authenticated;

create or replace function public.set_gallery_selection_photo_note(
  p_token text,
  p_photo_id uuid,
  p_note text,
  p_access_token text default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_note text;
  v_retry_after integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null then
    raise exception 'PHOTO_NOTE_INVALID' using errcode = '22023';
  end if;
  v_note := nullif(regexp_replace(coalesce(p_note, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'PHOTO_NOTE_INVALID' using errcode = '22023';
  end if;

  select * into v_share from public.gallery_shares s
    where s.token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries g where g.tenant_id = v_share.tenant_id
      and g.id = v_share.gallery_id and g.status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then
    raise exception 'PHOTO_NOTE_DENIED' using errcode = '42501';
  end if;
  if v_share.share_mode <> 'selection' then
    raise exception 'SELECTION_MODE_DISABLED' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then
    raise exception 'SELECTION_SUBMITTED' using errcode = '42501';
  end if;

  v_retry_after := private.consume_gallery_selection_write_limit(v_share.id);
  if v_retry_after > 0 then
    raise exception 'SELECTION_RATE_LIMITED' using errcode = 'PT429', detail = v_retry_after::text;
  end if;

  update public.gallery_selection_items i set client_note = v_note
    from public.photos p
    where i.share_id = v_share.id and i.photo_id = p_photo_id
      and p.id = i.photo_id and p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
  if not found then
    raise exception 'PHOTO_NOT_SELECTED' using errcode = '42501';
  end if;
  return v_note;
end;
$$;
revoke all on function public.set_gallery_selection_photo_note(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_gallery_selection_photo_note(text, uuid, text, text) to anon, authenticated;

create or replace function public.submit_gallery_selection(
  p_token text,
  p_client_name text,
  p_access_token text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_count integer;
  v_version integer;
  v_submitted_at timestamptz;
  v_recipient text;
  v_gallery_title text;
  v_retry_after integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'SELECTION_INVALID' using errcode = '22023';
  end if;
  select * into v_share from public.gallery_shares s
    where s.token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries g where g.tenant_id = v_share.tenant_id
      and g.id = v_share.gallery_id and g.status = 'published') then
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
  select count(*)::integer into v_count from public.gallery_selection_items i where i.share_id = v_share.id;
  if v_count = 0 then return false; end if;

  select coalesce(max(r.revision_number), 0) + 1 into v_version
    from public.gallery_selection_revisions r where r.share_id = v_share.id;

  v_retry_after := private.consume_gallery_selection_write_limit(v_share.id);
  if v_retry_after > 0 then
    raise exception 'SELECTION_RATE_LIMITED' using errcode = 'PT429', detail = v_retry_after::text;
  end if;

  v_submitted_at := clock_timestamp();
  update public.gallery_shares s set submitted_at = v_submitted_at, submitted_name = btrim(p_client_name),
    revision_requested_at = null, revision_message = null
    where s.id = v_share.id;

  select u.email into v_recipient from public.tenant_members m
    join auth.users u on u.id = m.user_id
    where m.tenant_id = v_share.tenant_id and m.role = 'owner';
  select g.title into v_gallery_title from public.galleries g
    where g.tenant_id = v_share.tenant_id and g.id = v_share.gallery_id;
  if v_recipient is not null then
    insert into public.gallery_notification_outbox(
      tenant_id, gallery_id, share_id, notification_type, event_version, recipient_email,
      gallery_title, client_name, selected_count
    ) values (
      v_share.tenant_id, v_share.gallery_id, v_share.id, 'selection_submitted', v_version,
      v_recipient, v_gallery_title, btrim(p_client_name), v_count
    ) on conflict (share_id, notification_type, event_version) do nothing;
  end if;
  return true;
end;
$$;
revoke all on function public.submit_gallery_selection(text, text, text) from public, anon, authenticated;
grant execute on function public.submit_gallery_selection(text, text, text) to anon, authenticated;

create or replace function public.clear_gallery_selection(
  p_token text,
  p_access_token text default null
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_removed integer;
  v_retry_after integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'SELECTION_INVALID' using errcode = '22023';
  end if;

  select * into v_share from public.gallery_shares s
    where s.token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (select 1 from public.galleries g where g.tenant_id = v_share.tenant_id
      and g.id = v_share.gallery_id and g.status = 'published') then
    raise exception 'SHARE_INACTIVE' using errcode = '42501';
  end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then return -1; end if;
  if v_share.share_mode <> 'selection' then
    raise exception 'SELECTION_MODE_DISABLED' using errcode = '42501';
  end if;
  if v_share.submitted_at is not null then
    raise exception 'SELECTION_SUBMITTED' using errcode = '42501';
  end if;

  v_retry_after := private.consume_gallery_selection_write_limit(v_share.id);
  if v_retry_after > 0 then
    raise exception 'SELECTION_RATE_LIMITED' using errcode = 'PT429', detail = v_retry_after::text;
  end if;

  delete from public.gallery_selection_items i where i.share_id = v_share.id;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;
revoke all on function public.clear_gallery_selection(text, text) from public, anon, authenticated;
grant execute on function public.clear_gallery_selection(text, text) to anon, authenticated;

create or replace function public.prune_gallery_share_image_rate_limits(p_batch_size integer default 1000)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_removed integer;
  v_selection_removed integer;
begin
  if p_batch_size is null or p_batch_size not between 1 and 5000 then
    raise exception 'SHARE_IMAGE_RATE_LIMIT_BATCH_INVALID' using errcode = '22023';
  end if;

  with stale as (
    select ctid from private.gallery_share_image_rate_limits
      where updated_at < clock_timestamp() - interval '24 hours'
      order by updated_at limit p_batch_size for update skip locked
  )
  delete from private.gallery_share_image_rate_limits as limits using stale where limits.ctid = stale.ctid;
  get diagnostics v_removed = row_count;

  with stale as (
    select ctid from private.gallery_share_selection_rate_limits
      where updated_at < clock_timestamp() - interval '24 hours'
      order by updated_at limit greatest(0, p_batch_size - v_removed) for update skip locked
  )
  delete from private.gallery_share_selection_rate_limits as limits using stale where limits.ctid = stale.ctid;
  get diagnostics v_selection_removed = row_count;
  return v_removed + v_selection_removed;
end;
$$;
revoke all on function public.prune_gallery_share_image_rate_limits(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_gallery_share_image_rate_limits(integer) to service_role;

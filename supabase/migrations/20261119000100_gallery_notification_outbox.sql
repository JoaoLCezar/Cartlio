create table public.gallery_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  gallery_id uuid not null,
  share_id uuid not null references public.gallery_shares(id) on delete cascade,
  notification_type text not null check (notification_type in ('selection_submitted', 'selection_revision_requested')),
  event_version integer not null check (event_version > 0),
  recipient_email text not null check (
    char_length(recipient_email) <= 254
    and recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  gallery_title text not null check (char_length(gallery_title) between 1 and 120),
  client_name text not null check (char_length(client_name) between 2 and 80),
  selected_count integer not null check (selected_count > 0),
  message text check (message is null or char_length(message) between 2 and 500),
  created_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 5),
  last_error_code text check (last_error_code is null or last_error_code in ('smtp_send_failed', 'max_attempts')),
  unique (share_id, notification_type, event_version),
  foreign key (tenant_id, gallery_id) references public.galleries(tenant_id, id) on delete cascade
);
create index gallery_notification_outbox_pending_idx
  on public.gallery_notification_outbox(available_at, created_at)
  where sent_at is null and failed_at is null;
alter table public.gallery_notification_outbox enable row level security;
revoke all on public.gallery_notification_outbox from public, anon, authenticated;

create function public.claim_gallery_notifications(
  p_limit integer default 10, p_share_id uuid default null, p_token text default null
)
returns table (
  id uuid, tenant_id uuid, gallery_id uuid, share_id uuid, notification_type text,
  event_version integer, recipient_email text, gallery_title text, client_name text,
  selected_count integer, message text, created_at timestamptz, attempts integer
)
language plpgsql security definer set search_path = '' as $$
declare
  v_share_id uuid := p_share_id;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'NOTIFICATION_WORKER_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'NOTIFICATION_BATCH_INVALID' using errcode = '22023';
  end if;
  if p_token is not null then
    if p_share_id is not null or p_token !~ '^[0-9a-f]{64}$' then
      raise exception 'NOTIFICATION_FILTER_INVALID' using errcode = '22023';
    end if;
    select s.id into v_share_id from public.gallery_shares s
      where s.token_hash = extensions.digest(p_token, 'sha256');
    if v_share_id is null then return; end if;
  end if;

  update public.gallery_notification_outbox n
    set claimed_at = null, failed_at = clock_timestamp(), last_error_code = 'max_attempts'
    where n.sent_at is null and n.failed_at is null and n.attempts >= 5
      and n.claimed_at <= clock_timestamp() - interval '10 minutes';

  return query
    with next_batch as (
      select n.id from public.gallery_notification_outbox n
      where n.sent_at is null and n.failed_at is null and n.attempts < 5
        and n.available_at <= clock_timestamp()
        and (n.claimed_at is null or n.claimed_at <= clock_timestamp() - interval '10 minutes')
        and (v_share_id is null or n.share_id = v_share_id)
      order by n.created_at, n.id
      for update skip locked
      limit p_limit
    )
    update public.gallery_notification_outbox n
      set claimed_at = clock_timestamp(), attempts = n.attempts + 1
      from next_batch b where n.id = b.id
      returning n.id, n.tenant_id, n.gallery_id, n.share_id, n.notification_type,
        n.event_version, n.recipient_email, n.gallery_title, n.client_name,
        n.selected_count, n.message, n.created_at, n.attempts;
end;
$$;

create function public.finish_gallery_notification(
  p_id uuid, p_success boolean, p_error_code text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_attempts integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'NOTIFICATION_WORKER_DENIED' using errcode = '42501';
  end if;
  if p_id is null or p_success is null then
    raise exception 'NOTIFICATION_RESULT_INVALID' using errcode = '22023';
  end if;
  if p_success then
    update public.gallery_notification_outbox n set sent_at = clock_timestamp(), claimed_at = null,
      last_error_code = null where n.id = p_id and n.claimed_at is not null
        and n.sent_at is null and n.failed_at is null;
    return found;
  end if;

  select n.attempts into v_attempts from public.gallery_notification_outbox n
    where n.id = p_id and n.claimed_at is not null and n.sent_at is null and n.failed_at is null
    for update;
  if not found then return false; end if;
  update public.gallery_notification_outbox n set
    claimed_at = null,
    available_at = clock_timestamp() + case v_attempts
      when 1 then interval '1 minute'
      when 2 then interval '5 minutes'
      when 3 then interval '15 minutes'
      when 4 then interval '1 hour'
      else interval '1 day'
    end,
    failed_at = case when v_attempts >= 5 then clock_timestamp() else null end,
    last_error_code = case when v_attempts >= 5 then 'max_attempts' else 'smtp_send_failed' end
    where n.id = p_id;
  return true;
end;
$$;
revoke all on function public.claim_gallery_notifications(integer, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_gallery_notification(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_gallery_notifications(integer, uuid, text) to service_role;
grant execute on function public.finish_gallery_notification(uuid, boolean, text) to service_role;

create or replace function public.request_gallery_selection_revision(
  p_tenant_id uuid, p_gallery_id uuid, p_share_id uuid, p_message text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_revision_id uuid;
  v_revision_number integer;
  v_item_count integer;
  v_recipient text;
  v_gallery_title text;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'SELECTION_REVISION_DENIED' using errcode = '42501';
  end if;
  if p_message is null or char_length(btrim(p_message)) not between 2 and 500 then
    raise exception 'SELECTION_REVISION_MESSAGE_INVALID' using errcode = '22023';
  end if;
  select g.title into v_gallery_title from public.galleries g
    where g.tenant_id = p_tenant_id and g.id = p_gallery_id and g.status = 'published' for update;
  if not found then raise exception 'SELECTION_REVISION_DENIED' using errcode = '42501'; end if;

  select * into v_share from public.gallery_shares s
    where s.id = p_share_id and s.tenant_id = p_tenant_id and s.gallery_id = p_gallery_id for update;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp() then
    raise exception 'SELECTION_REVISION_DENIED' using errcode = '42501';
  end if;
  if v_share.share_mode <> 'selection' then
    raise exception 'SELECTION_MODE_DISABLED' using errcode = '42501';
  end if;
  if v_share.submitted_at is null or v_share.submitted_name is null then
    raise exception 'SELECTION_NOT_SUBMITTED' using errcode = '42501';
  end if;

  select count(*)::integer into v_item_count from public.gallery_selection_items i where i.share_id = v_share.id;
  if v_item_count = 0 then raise exception 'SELECTION_EMPTY' using errcode = '22023'; end if;
  select coalesce(max(r.revision_number), 0) + 1 into v_revision_number
    from public.gallery_selection_revisions r where r.share_id = v_share.id;

  insert into public.gallery_selection_revisions(share_id, revision_number, submitted_at, submitted_name, revision_message)
    values (v_share.id, v_revision_number, v_share.submitted_at, v_share.submitted_name, btrim(p_message))
    returning id into v_revision_id;
  insert into public.gallery_selection_revision_items(revision_id, photo_id, original_filename)
    select v_revision_id, i.photo_id, i.original_filename
      from public.gallery_selection_items i where i.share_id = v_share.id;

  select c.email into v_recipient from public.galleries g
    join public.customers c on c.tenant_id = g.tenant_id and c.id = g.customer_id
    where g.tenant_id = p_tenant_id and g.id = p_gallery_id;
  if v_recipient is not null then
    insert into public.gallery_notification_outbox(
      tenant_id, gallery_id, share_id, notification_type, event_version, recipient_email,
      gallery_title, client_name, selected_count, message
    ) values (
      p_tenant_id, p_gallery_id, v_share.id, 'selection_revision_requested', v_revision_number,
      v_recipient, v_gallery_title, v_share.submitted_name, v_item_count, btrim(p_message)
    ) on conflict (share_id, notification_type, event_version) do nothing;
  end if;

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
declare
  v_share public.gallery_shares%rowtype;
  v_count integer;
  v_version integer;
  v_submitted_at timestamptz;
  v_recipient text;
  v_gallery_title text;
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
  v_submitted_at := clock_timestamp();
  update public.gallery_shares set submitted_at = v_submitted_at, submitted_name = btrim(p_client_name),
    revision_requested_at = null, revision_message = null where id = v_share.id;

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

alter table public.gallery_notification_outbox
  add column manual_retry_count integer not null default 0
    check (manual_retry_count between 0 and 2);

drop function public.gallery_notification_status(uuid, uuid);
create function public.gallery_notification_status(
  p_tenant_id uuid,
  p_gallery_id uuid
)
returns table (
  share_id uuid,
  notification_type text,
  delivery_state text,
  attempts integer,
  available_at timestamptz,
  manual_retry_count integer
)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'NOTIFICATION_STATUS_DENIED' using errcode = '42501';
  end if;
  if p_gallery_id is null or not exists (
    select 1 from public.galleries g where g.tenant_id = p_tenant_id and g.id = p_gallery_id
  ) then
    raise exception 'NOTIFICATION_STATUS_DENIED' using errcode = '42501';
  end if;

  return query
    with ranked_notifications as (
      select n.share_id, n.notification_type, n.attempts, n.available_at,
        n.manual_retry_count, n.claimed_at, n.sent_at, n.failed_at,
        row_number() over (
          partition by n.share_id, n.notification_type
          order by n.event_version desc, n.created_at desc, n.id desc
        ) as event_rank
      from public.gallery_notification_outbox n
      where n.tenant_id = p_tenant_id and n.gallery_id = p_gallery_id
    )
    select r.share_id, r.notification_type,
      case
        when r.sent_at is not null then 'sent'
        when r.failed_at is not null then 'failed'
        when r.claimed_at > clock_timestamp() - interval '10 minutes' then 'sending'
        when r.attempts > 0 then 'retry_wait'
        else 'queued'
      end,
      r.attempts, r.available_at, r.manual_retry_count
    from ranked_notifications r
    where r.event_rank = 1;
end;
$$;
revoke all on function public.gallery_notification_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gallery_notification_status(uuid, uuid) to authenticated;

create function public.retry_failed_gallery_notification(
  p_tenant_id uuid,
  p_gallery_id uuid,
  p_share_id uuid,
  p_notification_type text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_notification public.gallery_notification_outbox%rowtype;
  v_recipient text;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'NOTIFICATION_RETRY_DENIED' using errcode = '42501';
  end if;
  if p_notification_type is null or p_notification_type not in ('selection_submitted', 'selection_revision_requested') then
    raise exception 'NOTIFICATION_TYPE_INVALID' using errcode = '22023';
  end if;
  if p_gallery_id is null or not exists (
    select 1 from public.galleries g where g.tenant_id = p_tenant_id and g.id = p_gallery_id
  ) then
    raise exception 'NOTIFICATION_RETRY_DENIED' using errcode = '42501';
  end if;

  select s.* into v_share from public.gallery_shares s
    where s.id = p_share_id and s.tenant_id = p_tenant_id and s.gallery_id = p_gallery_id
    for update;
  if not found or v_share.share_mode <> 'selection' then
    raise exception 'NOTIFICATION_RETRY_UNAVAILABLE' using errcode = '42501';
  end if;
  if p_notification_type = 'selection_submitted' and v_share.submitted_at is null then
    raise exception 'NOTIFICATION_RETRY_UNAVAILABLE' using errcode = '42501';
  end if;
  if p_notification_type = 'selection_revision_requested' and (
    v_share.revision_requested_at is null or v_share.submitted_at is not null
    or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or not exists (
      select 1 from public.galleries g
      where g.tenant_id = p_tenant_id and g.id = p_gallery_id and g.status = 'published'
    )
  ) then
    raise exception 'NOTIFICATION_RETRY_UNAVAILABLE' using errcode = '42501';
  end if;

  select n.* into v_notification from public.gallery_notification_outbox n
    where n.tenant_id = p_tenant_id and n.gallery_id = p_gallery_id
      and n.share_id = p_share_id and n.notification_type = p_notification_type
    order by n.event_version desc, n.created_at desc, n.id desc
    limit 1 for update;
  if not found or v_notification.sent_at is not null or v_notification.failed_at is null
    or v_notification.claimed_at is not null then
    raise exception 'NOTIFICATION_RETRY_UNAVAILABLE' using errcode = '42501';
  end if;
  if v_notification.manual_retry_count >= 2 then
    raise exception 'NOTIFICATION_RETRY_LIMIT' using errcode = '22023';
  end if;

  if p_notification_type = 'selection_submitted' then
    select u.email into v_recipient from public.tenant_members m
      join auth.users u on u.id = m.user_id
      where m.tenant_id = p_tenant_id and m.role = 'owner';
  else
    select c.email into v_recipient from public.galleries g
      join public.customers c on c.tenant_id = g.tenant_id and c.id = g.customer_id
      where g.tenant_id = p_tenant_id and g.id = p_gallery_id;
  end if;
  if v_recipient is null then
    raise exception 'NOTIFICATION_RECIPIENT_MISSING' using errcode = '22023';
  end if;

  update public.gallery_notification_outbox n set
    recipient_email = v_recipient,
    attempts = 0,
    available_at = clock_timestamp(),
    claimed_at = null,
    failed_at = null,
    last_error_code = null,
    manual_retry_count = n.manual_retry_count + 1
    where n.id = v_notification.id and n.failed_at is not null
      and n.sent_at is null and n.claimed_at is null and n.manual_retry_count < 2;
  if not found then
    raise exception 'NOTIFICATION_RETRY_UNAVAILABLE' using errcode = '42501';
  end if;
  return true;
end;
$$;
revoke all on function public.retry_failed_gallery_notification(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.retry_failed_gallery_notification(uuid, uuid, uuid, text) to authenticated;

create function public.gallery_notification_status(
  p_tenant_id uuid,
  p_gallery_id uuid
)
returns table (
  share_id uuid,
  notification_type text,
  delivery_state text,
  attempts integer,
  available_at timestamptz
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
        n.claimed_at, n.sent_at, n.failed_at,
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
      r.attempts, r.available_at
    from ranked_notifications r
    where r.event_rank = 1;
end;
$$;
revoke all on function public.gallery_notification_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gallery_notification_status(uuid, uuid) to authenticated;

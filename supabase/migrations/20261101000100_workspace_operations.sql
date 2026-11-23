create function public.workspace_operations(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;

  return (
    with per_gallery as (
      select g.id, g.title,
        coalesce(u.pending, 0)::integer as uploads_pending,
        coalesce(u.expired, 0)::integer as uploads_expired,
        coalesce(u.canceling, 0)::integer as uploads_canceling,
        coalesce(p.pending, 0)::integer as photos_pending,
        coalesce(p.processing, 0)::integer as photos_processing,
        coalesce(p.failed, 0)::integer as photos_failed,
        coalesce(p.deleting, 0)::integer as photos_deleting
      from public.galleries g
      left join lateral (
        select count(*) filter (where state in ('reserved', 'canceling')) as pending,
          count(*) filter (where state = 'reserved' and expires_at <= clock_timestamp()) as expired,
          count(*) filter (where state = 'canceling') as canceling
        from public.upload_sessions s
        where s.tenant_id = g.tenant_id and s.gallery_id = g.id
      ) u on true
      left join lateral (
        select count(*) filter (where processing_status = 'pending' and deletion_requested_at is null) as pending,
          count(*) filter (where processing_status = 'processing' and deletion_requested_at is null) as processing,
          count(*) filter (where processing_status = 'failed' and deletion_requested_at is null) as failed,
          count(*) filter (where deletion_requested_at is not null) as deleting
        from public.photos p
        where p.tenant_id = g.tenant_id and p.gallery_id = g.id
      ) p on true
      where g.tenant_id = p_tenant_id
    )
    select jsonb_build_object(
      'uploads_pending', coalesce(sum(uploads_pending), 0),
      'uploads_expired', coalesce(sum(uploads_expired), 0),
      'uploads_canceling', coalesce(sum(uploads_canceling), 0),
      'photos_pending', coalesce(sum(photos_pending), 0),
      'photos_processing', coalesce(sum(photos_processing), 0),
      'photos_failed', coalesce(sum(photos_failed), 0),
      'photos_deleting', coalesce(sum(photos_deleting), 0),
      'galleries', coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'title', title,
        'uploads_pending', uploads_pending, 'uploads_expired', uploads_expired, 'uploads_canceling', uploads_canceling,
        'photos_pending', photos_pending, 'photos_processing', photos_processing,
        'photos_failed', photos_failed, 'photos_deleting', photos_deleting
      ) order by title) filter (where uploads_pending + photos_pending + photos_processing + photos_failed + photos_deleting > 0), '[]'::jsonb)
    )
    from per_gallery
  );
end;
$$;

revoke all on function public.workspace_operations(uuid) from public, anon, authenticated;
grant execute on function public.workspace_operations(uuid) to authenticated;

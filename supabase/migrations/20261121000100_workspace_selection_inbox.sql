-- Keep photographer work actionable: surface submitted selections on the
-- workspace dashboard without exposing share tokens or requiring broad reads.
create index gallery_shares_submitted_inbox_idx
  on public.gallery_shares(tenant_id, submitted_at asc, id)
  where share_mode = 'selection' and submitted_at is not null;

create or replace function public.workspace_operations(p_tenant_id uuid)
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
      'selections_received', (
        select count(*)::integer
        from public.gallery_shares s
        where s.tenant_id = p_tenant_id and s.share_mode = 'selection' and s.submitted_at is not null
      ),
      'selection_inbox', coalesce((
        select jsonb_agg(jsonb_build_object(
          'share_id', inbox.share_id,
          'gallery_id', inbox.gallery_id,
          'gallery_title', inbox.gallery_title,
          'submitted_at', inbox.submitted_at,
          'submitted_name', inbox.submitted_name,
          'selected_count', inbox.selected_count
        ) order by inbox.submitted_at asc, inbox.share_id)
        from (
          select s.id as share_id, s.gallery_id, g.title as gallery_title,
            s.submitted_at, s.submitted_name, count(i.photo_id)::integer as selected_count
          from public.gallery_shares s
          join public.galleries g on g.tenant_id = s.tenant_id and g.id = s.gallery_id
          left join public.gallery_selection_items i on i.share_id = s.id
          where s.tenant_id = p_tenant_id and s.share_mode = 'selection' and s.submitted_at is not null
          group by s.id, g.title
          order by s.submitted_at asc, s.id
          limit 10
        ) inbox
      ), '[]'::jsonb),
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

create function public.move_gallery_photo(
  p_tenant_id uuid,
  p_gallery_id uuid,
  p_photo_id uuid,
  p_target_photo_id uuid,
  p_after_target boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_gallery uuid;
  v_source_position integer;
  v_target_position integer;
  v_insert_position integer;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id) then
    raise exception 'PHOTO_ORDER_DENIED' using errcode = '42501';
  end if;
  if p_gallery_id is null or p_photo_id is null or p_target_photo_id is null or p_after_target is null then
    raise exception 'PHOTO_ORDER_INVALID' using errcode = '22023';
  end if;

  select id into v_gallery from public.galleries
    where tenant_id = p_tenant_id and id = p_gallery_id for update;
  if not found then raise exception 'PHOTO_ORDER_DENIED' using errcode = '42501'; end if;

  with ranked as (
    select id, (row_number() over (order by sort_order, created_at desc, id) - 1)::integer as position
    from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and deletion_requested_at is null
  )
  select max(position) filter (where id = p_photo_id),
    max(position) filter (where id = p_target_photo_id)
  into v_source_position, v_target_position
  from ranked;

  if v_source_position is null or v_target_position is null then
    raise exception 'PHOTO_ORDER_INVALID' using errcode = '22023';
  end if;
  if p_photo_id = p_target_photo_id then return true; end if;

  if p_after_target then
    v_insert_position := v_target_position + 1 - case when v_source_position < v_target_position then 1 else 0 end;
  else
    v_insert_position := v_target_position - case when v_source_position < v_target_position then 1 else 0 end;
  end if;

  with ranked as (
    select id, (row_number() over (order by sort_order, created_at desc, id) - 1)::integer as position
    from public.photos
    where tenant_id = p_tenant_id and gallery_id = p_gallery_id and deletion_requested_at is null
  ), adjusted as (
    select id, position,
      position - case when position > v_source_position then 1 else 0 end as remaining_position
    from ranked
  ), moved as (
    select id,
      case when id = p_photo_id then v_insert_position
        else remaining_position + case when remaining_position >= v_insert_position then 1 else 0 end
      end as new_position
    from adjusted
  )
  update public.photos p set sort_order = moved.new_position
  from moved
  where p.id = moved.id and p.tenant_id = p_tenant_id and p.gallery_id = p_gallery_id
    and p.deletion_requested_at is null;

  return true;
end;
$$;

revoke all on function public.move_gallery_photo(uuid, uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.move_gallery_photo(uuid, uuid, uuid, uuid, boolean) to authenticated;

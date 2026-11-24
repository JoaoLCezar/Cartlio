alter table public.gallery_selection_items
  add column client_note text,
  add constraint gallery_selection_items_client_note_check
    check (client_note is null or (
      char_length(client_note) between 1 and 500
      and client_note = btrim(client_note)
      and client_note !~ '^[[:space:]]*$'
    ));

alter table public.gallery_selection_revision_items
  add column client_note text,
  add constraint gallery_selection_revision_items_client_note_check
    check (client_note is null or (
      char_length(client_note) between 1 and 500
      and client_note = btrim(client_note)
      and client_note !~ '^[[:space:]]*$'
    ));

grant select (client_note) on public.gallery_selection_items to authenticated;
grant select (client_note) on public.gallery_selection_revision_items to authenticated;

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

create or replace function public.get_shared_gallery(p_token text, p_access_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_gallery public.galleries%rowtype;
  v_share public.gallery_shares%rowtype;
  v_photos jsonb;
  v_selected_photo_ids jsonb;
  v_cover_photo_id uuid;
  v_photo_count integer;
  v_selected_count integer;
  v_brand_name text;
  v_brand_color text;
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

  select coalesce(nullif(btrim(t.public_brand_name), ''), 'Cartlio'), t.brand_color
    into v_brand_name, v_brand_color from public.tenants t where t.id = v_share.tenant_id;
  select p.id into v_cover_photo_id from public.photos p
    where p.id = v_gallery.cover_photo_id and p.tenant_id = v_share.tenant_id
      and p.gallery_id = v_share.gallery_id and p.processing_status = 'ready'
      and p.deletion_requested_at is null;
  if v_cover_photo_id is null then
    select p.id into v_cover_photo_id from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
      order by p.sort_order, p.created_at desc, p.id limit 1;
  end if;

  select count(*)::integer into v_photo_count from public.photos p
    where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'name', page.original_filename,
    'selected', page.selected, 'client_note', page.client_note
  ) order by page.sort_order, page.created_at desc, page.id), '[]'::jsonb)
    into v_photos
    from (
      select p.id, p.original_filename, p.sort_order, p.created_at,
        exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as selected,
        (select i.client_note from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as client_note
      from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
      order by p.sort_order, p.created_at desc, p.id limit 60
    ) page;
  select coalesce(jsonb_agg(i.photo_id order by p.sort_order, p.created_at desc, p.id), '[]'::jsonb), count(*)::integer
    into v_selected_photo_ids, v_selected_count
    from public.gallery_selection_items i
    join public.photos p on p.id = i.photo_id and p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
    where i.share_id = v_share.id;

  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description,
    'photos', v_photos, 'photo_count', v_photo_count, 'selected_photo_ids', v_selected_photo_ids,
    'cover_photo_id', v_cover_photo_id, 'selected_count', v_selected_count, 'selection_limit', v_share.selection_limit,
    'submitted_at', v_share.submitted_at, 'downloads_enabled', v_share.downloads_enabled,
    'share_mode', v_share.share_mode, 'brand_name', v_brand_name, 'brand_color', v_brand_color,
    'revision_message', case when v_share.submitted_at is null then v_share.revision_message else null end);
end;
$$;
revoke all on function public.get_shared_gallery(text, text) from public, anon, authenticated;
grant execute on function public.get_shared_gallery(text, text) to anon, authenticated;

create or replace function public.get_shared_gallery_photo_page(
  p_token text,
  p_access_token text default null,
  p_offset integer default 0,
  p_limit integer default 60,
  p_search text default null,
  p_selected_only boolean default false
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_query text;
  v_search_pattern text;
  v_total_count integer;
  v_photos jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000
    or p_limit is null or p_limit < 1 or p_limit > 60
    or char_length(btrim(coalesce(p_search, ''))) > 120 then
    raise exception 'PHOTO_PAGE_INVALID' using errcode = '22023';
  end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256')
      and revoked_at is null and expires_at > clock_timestamp();
  if not found or not exists (
    select 1 from public.galleries g where g.tenant_id = v_share.tenant_id
      and g.id = v_share.gallery_id and g.status = 'published'
  ) then return null; end if;
  if not private.gallery_share_pin_authorized(v_share.id, p_access_token) then
    return jsonb_build_object('pin_required', true);
  end if;
  if p_selected_only and v_share.share_mode <> 'selection' then
    raise exception 'PHOTO_PAGE_FILTER_INVALID' using errcode = '22023';
  end if;

  v_query := nullif(public.gallery_photo_search_text(btrim(coalesce(p_search, ''))), '');
  if v_query is not null then
    v_search_pattern := '%' || replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  end if;

  if v_query is null then
    select count(*)::integer into v_total_count from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
        and (not p_selected_only or exists (
          select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id
        ));
    select coalesce(jsonb_agg(jsonb_build_object('id', page.id, 'name', page.original_filename,
      'selected', page.selected, 'client_note', page.client_note)
      order by page.sort_order, page.created_at desc, page.id), '[]'::jsonb)
      into v_photos
      from (
        select p.id, p.original_filename, p.sort_order, p.created_at,
          exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as selected,
          (select i.client_note from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as client_note
        from public.photos p
        where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
          and p.processing_status = 'ready' and p.deletion_requested_at is null
          and (not p_selected_only or exists (
            select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id
          ))
        order by p.sort_order, p.created_at desc, p.id
        limit p_limit offset p_offset
      ) page;
  else
    select count(*)::integer into v_total_count from public.photos p
      where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
        and public.gallery_photo_search_text(p.original_filename) like v_search_pattern escape E'\\'
        and (not p_selected_only or exists (
          select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id
        ));
    select coalesce(jsonb_agg(jsonb_build_object('id', page.id, 'name', page.original_filename,
      'selected', page.selected, 'client_note', page.client_note)
      order by page.sort_order, page.created_at desc, page.id), '[]'::jsonb)
      into v_photos
      from (
        select p.id, p.original_filename, p.sort_order, p.created_at,
          exists (select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as selected,
          (select i.client_note from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id) as client_note
        from public.photos p
        where p.tenant_id = v_share.tenant_id and p.gallery_id = v_share.gallery_id
          and p.processing_status = 'ready' and p.deletion_requested_at is null
          and public.gallery_photo_search_text(p.original_filename) like v_search_pattern escape E'\\'
          and (not p_selected_only or exists (
            select 1 from public.gallery_selection_items i where i.share_id = v_share.id and i.photo_id = p.id
          ))
        order by p.sort_order, p.created_at desc, p.id
        limit p_limit offset p_offset
      ) page;
  end if;

  return jsonb_build_object('photos', v_photos, 'total_count', v_total_count, 'offset', p_offset, 'limit', p_limit);
end;
$$;
revoke all on function public.get_shared_gallery_photo_page(text, text, integer, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.get_shared_gallery_photo_page(text, text, integer, integer, text, boolean) to anon, authenticated;

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
  insert into public.gallery_selection_revision_items(revision_id, photo_id, original_filename, client_note)
    select v_revision_id, i.photo_id, i.original_filename, i.client_note
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

create table public.photographer_portfolios (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  bio text not null default '' check (char_length(bio) <= 1200),
  contact_email text check (
    char_length(contact_email) <= 254 and contact_email ~ '^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
  ),
  published boolean not null default false,
  photo_ids uuid[] not null default '{}',
  check (cardinality(photo_ids) <= 12)
);

alter table public.photographer_portfolios enable row level security;
revoke all on public.photographer_portfolios from public, anon, authenticated;
grant select on public.photographer_portfolios to authenticated;

create policy portfolio_select_owner on public.photographer_portfolios for select to authenticated
  using (private.is_tenant_owner(tenant_id));

create function public.save_portfolio(
  p_tenant_id uuid, p_display_name text, p_bio text, p_contact_email text, p_published boolean
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_tenant_owner(p_tenant_id) then
    raise exception 'PORTFOLIO_EDIT_DENIED' using errcode = '42501';
  end if;
  insert into public.photographer_portfolios (tenant_id, display_name, bio, contact_email, published)
  values (p_tenant_id, btrim(p_display_name), btrim(p_bio), nullif(btrim(p_contact_email), ''), p_published)
  on conflict (tenant_id) do update set
    display_name = excluded.display_name,
    bio = excluded.bio,
    contact_email = excluded.contact_email,
    published = excluded.published;
end;
$$;
revoke all on function public.save_portfolio(uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.save_portfolio(uuid, text, text, text, boolean) to authenticated;

create function public.set_portfolio_photo(p_tenant_id uuid, p_photo_id uuid, p_include boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_photo_ids uuid[];
begin
  if not private.is_tenant_owner(p_tenant_id) then
    raise exception 'PORTFOLIO_EDIT_DENIED' using errcode = '42501';
  end if;
  if p_photo_id is null or p_include is null then
    raise exception 'PORTFOLIO_PHOTO_INVALID' using errcode = '22023';
  end if;
  select photo_ids into v_photo_ids from public.photographer_portfolios
    where tenant_id = p_tenant_id for update;
  if not found then return false; end if;

  v_photo_ids := array(
    select picked.id from unnest(v_photo_ids) with ordinality as picked(id, position)
    join public.photos p on p.id = picked.id and p.tenant_id = p_tenant_id
    where p.processing_status = 'ready' and p.deletion_requested_at is null
    order by picked.position
  );
  if p_include and not (p_photo_id = any(v_photo_ids)) then
    if cardinality(v_photo_ids) >= 12 then
      raise exception 'PORTFOLIO_PHOTO_LIMIT' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.photos p where p.id = p_photo_id and p.tenant_id = p_tenant_id
        and p.processing_status = 'ready' and p.deletion_requested_at is null
    ) then
      raise exception 'PORTFOLIO_PHOTO_INVALID' using errcode = '22023';
    end if;
    v_photo_ids := array_append(v_photo_ids, p_photo_id);
  elsif not p_include then
    v_photo_ids := array_remove(v_photo_ids, p_photo_id);
  end if;

  update public.photographer_portfolios set photo_ids = v_photo_ids where tenant_id = p_tenant_id;
  return true;
end;
$$;
revoke all on function public.set_portfolio_photo(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_portfolio_photo(uuid, uuid, boolean) to authenticated;

create function public.get_public_portfolio(p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'display_name', portfolio.display_name,
    'bio', portfolio.bio,
    'contact_email', portfolio.contact_email,
    'photo_ids', array(
      select picked.id from unnest(portfolio.photo_ids) with ordinality as picked(id, position)
      join public.photos p on p.id = picked.id and p.tenant_id = portfolio.tenant_id
      where p.processing_status = 'ready' and p.deletion_requested_at is null
      order by picked.position
    )
  )
  from public.photographer_portfolios portfolio
  join public.tenants t on t.id = portfolio.tenant_id
  where t.slug = p_slug and portfolio.published;
$$;
revoke all on function public.get_public_portfolio(text) from public, anon, authenticated;
grant execute on function public.get_public_portfolio(text) to anon, authenticated;

create function public.resolve_public_portfolio_image(p_slug text, p_photo_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp'
  from public.photographer_portfolios portfolio
  join public.tenants t on t.id = portfolio.tenant_id
  join public.photos p on p.tenant_id = portfolio.tenant_id and p.id = p_photo_id
  where t.slug = p_slug and portfolio.published and p.id = any(portfolio.photo_ids)
    and p.processing_status = 'ready' and p.deletion_requested_at is null;
$$;
revoke all on function public.resolve_public_portfolio_image(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.resolve_public_portfolio_image(text, uuid) to service_role;

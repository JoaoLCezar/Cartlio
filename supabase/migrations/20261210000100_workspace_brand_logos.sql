insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gallery-brand-assets', 'gallery-brand-assets', false, 2097152, array['image/webp'])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.tenants
  add column brand_logo_path text,
  add constraint tenants_brand_logo_path_check check (
    brand_logo_path is null or brand_logo_path ~ (
      '^' || id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]webp$'
    )
  );

create function public.set_tenant_brand_logo(p_tenant_id uuid, p_logo_path text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid() and m.role = 'owner'
  ) then
    raise exception 'BRAND_UPDATE_DENIED' using errcode = '42501';
  end if;
  if p_logo_path is not null and p_logo_path !~ (
    '^' || p_tenant_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]webp$'
  ) then
    raise exception 'BRAND_LOGO_PATH_INVALID' using errcode = '22023';
  end if;

  update public.tenants set brand_logo_path = p_logo_path where id = p_tenant_id;
  return found;
end;
$$;
revoke all on function public.set_tenant_brand_logo(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_tenant_brand_logo(uuid, text) to authenticated;

create function public.get_shared_brand_logo_status(p_token text, p_access_token text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_share_id uuid;
  v_has_logo boolean;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  select s.id, t.brand_logo_path is not null into v_share_id, v_has_logo
    from public.gallery_shares s
    join public.galleries g on g.tenant_id = s.tenant_id and g.id = s.gallery_id and g.status = 'published'
    join public.tenants t on t.id = s.tenant_id
    where s.token_hash = extensions.digest(p_token, 'sha256')
      and s.revoked_at is null and s.expires_at > clock_timestamp();
  if not found or not private.gallery_share_pin_authorized(v_share_id, p_access_token) then return false; end if;
  return coalesce(v_has_logo, false);
end;
$$;
revoke all on function public.get_shared_brand_logo_status(text, text) from public, anon, authenticated, service_role;
grant execute on function public.get_shared_brand_logo_status(text, text) to anon, authenticated;

create function public.authorize_shared_brand_logo(
  p_token text,
  p_access_token text,
  p_client_fingerprint text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_share_id uuid;
  v_path text;
  v_request_count integer;
  v_window_started_at timestamptz;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$'
    or (p_client_fingerprint is not null and p_client_fingerprint !~ '^[0-9a-f]{64}$') then
    return null;
  end if;

  select s.id, t.brand_logo_path into v_share_id, v_path
    from public.gallery_shares s
    join public.galleries g on g.tenant_id = s.tenant_id and g.id = s.gallery_id and g.status = 'published'
    join public.tenants t on t.id = s.tenant_id
    where s.token_hash = extensions.digest(p_token, 'sha256')
      and s.revoked_at is null and s.expires_at > clock_timestamp()
      and t.brand_logo_path is not null
      and private.gallery_share_pin_authorized(s.id, p_access_token);
  if not found then return null; end if;

  if p_client_fingerprint is not null then
    insert into private.gallery_share_image_rate_limits as rate
      (share_id, client_fingerprint, window_started_at, request_count, updated_at)
    values (v_share_id, decode(p_client_fingerprint, 'hex'), clock_timestamp(), 1, clock_timestamp())
    on conflict (share_id, client_fingerprint) do update set
      window_started_at = case
        when rate.window_started_at <= clock_timestamp() - interval '1 minute' then clock_timestamp()
        else rate.window_started_at
      end,
      request_count = least(case
        when rate.window_started_at <= clock_timestamp() - interval '1 minute' then 1
        else rate.request_count + 1
      end, 1801),
      updated_at = clock_timestamp()
    returning request_count, window_started_at into v_request_count, v_window_started_at;

    if v_request_count > 1800 then
      return jsonb_build_object(
        'rate_limited', true,
        'retry_after', greatest(1, ceil(60 - extract(epoch from clock_timestamp() - v_window_started_at)))
      );
    end if;
  end if;

  return jsonb_build_object('path', v_path, 'rate_limited', false);
end;
$$;
revoke all on function public.authorize_shared_brand_logo(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_shared_brand_logo(text, text, text) to service_role;

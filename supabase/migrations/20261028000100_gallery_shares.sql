create table public.gallery_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  gallery_id uuid not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  foreign key (tenant_id, gallery_id) references public.galleries(tenant_id, id) on delete cascade
);
create index gallery_shares_gallery_idx on public.gallery_shares(tenant_id, gallery_id, created_at desc);
alter table public.gallery_shares enable row level security;
revoke all on public.gallery_shares from public, anon, authenticated;
grant select (id, tenant_id, gallery_id, created_at, expires_at, revoked_at) on public.gallery_shares to authenticated;
create policy gallery_shares_select_member on public.gallery_shares for select to authenticated
  using (private.is_tenant_member(tenant_id));

create function public.create_gallery_share(p_tenant_id uuid, p_gallery_id uuid, p_expires_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id
      and id = p_gallery_id and status = 'published') then
    raise exception 'Gallery sharing denied' using errcode = '42501';
  end if;
  if p_expires_at is null or p_expires_at < clock_timestamp() + interval '1 hour'
    or p_expires_at > clock_timestamp() + interval '30 days' then
    raise exception 'SHARE_EXPIRY_INVALID' using errcode = '22023';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.gallery_shares (tenant_id, gallery_id, token_hash, expires_at, created_by)
    values (p_tenant_id, p_gallery_id, extensions.digest(v_token, 'sha256'), p_expires_at, auth.uid());
  return v_token;
end;
$$;

create function public.revoke_gallery_share(p_tenant_id uuid, p_gallery_id uuid, p_share_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_tenant_member(p_tenant_id)
    or not exists (select 1 from public.galleries where tenant_id = p_tenant_id and id = p_gallery_id) then
    raise exception 'Gallery sharing denied' using errcode = '42501';
  end if;
  update public.gallery_shares set revoked_at = coalesce(revoked_at, clock_timestamp())
    where id = p_share_id and tenant_id = p_tenant_id and gallery_id = p_gallery_id;
  return found;
end;
$$;

-- A gallery must receive a new link after being unpublished or archived.
create function private.revoke_shares_on_unpublish() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'published' and new.status <> 'published' then
    update public.gallery_shares set revoked_at = coalesce(revoked_at, clock_timestamp())
      where tenant_id = new.tenant_id and gallery_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
create trigger revoke_shares_on_unpublish after update of status on public.galleries
  for each row execute function private.revoke_shares_on_unpublish();
revoke all on function private.revoke_shares_on_unpublish() from public, anon, authenticated;

create function public.get_shared_gallery(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gallery public.galleries%rowtype; v_share public.gallery_shares%rowtype; v_photos jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256')
      and revoked_at is null and expires_at > clock_timestamp();
  if not found then return null; end if;
  select * into v_gallery from public.galleries where tenant_id = v_share.tenant_id
    and id = v_share.gallery_id and status = 'published';
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', original_filename) order by created_at, id), '[]'::jsonb)
    into v_photos from public.photos where tenant_id = v_share.tenant_id and gallery_id = v_share.gallery_id
    and processing_status = 'ready' and deletion_requested_at is null;
  return jsonb_build_object('title', v_gallery.title, 'description', v_gallery.description, 'photos', v_photos);
end;
$$;

-- Returns only the deterministic derivative key; the route picks one of two
-- private buckets. The original bucket is never reachable through this RPC.
create function public.resolve_shared_photo(p_token text, p_photo_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null then return null; end if;
  select p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp' into v_path
    from public.gallery_shares s
    join public.galleries g on g.tenant_id = s.tenant_id and g.id = s.gallery_id
    join public.photos p on p.tenant_id = s.tenant_id and p.gallery_id = s.gallery_id
    where s.token_hash = extensions.digest(p_token, 'sha256') and s.revoked_at is null
      and s.expires_at > clock_timestamp() and g.status = 'published'
      and p.id = p_photo_id and p.processing_status = 'ready' and p.deletion_requested_at is null;
  return v_path;
end;
$$;

revoke all on function public.create_gallery_share(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.revoke_gallery_share(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_shared_gallery(text) from public, anon, authenticated;
revoke all on function public.resolve_shared_photo(text, uuid) from public, anon, authenticated;
grant execute on function public.create_gallery_share(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.revoke_gallery_share(uuid, uuid, uuid) to authenticated;
grant execute on function public.get_shared_gallery(text) to anon, authenticated;
grant execute on function public.resolve_shared_photo(text, uuid) to anon, authenticated;

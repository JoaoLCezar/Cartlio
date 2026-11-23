create table private.gallery_share_image_rate_limits (
  share_id uuid not null references public.gallery_shares(id) on delete cascade,
  client_fingerprint bytea not null check (octet_length(client_fingerprint) = 32),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count between 1 and 1801),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (share_id, client_fingerprint)
);
create index gallery_share_image_rate_limits_updated_idx
  on private.gallery_share_image_rate_limits(updated_at);
alter table private.gallery_share_image_rate_limits enable row level security;
revoke all on private.gallery_share_image_rate_limits from public, anon, authenticated, service_role;

drop function public.resolve_shared_photo(text, uuid, text);

create function public.authorize_shared_photo_image(
  p_token text,
  p_photo_id uuid,
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
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_photo_id is null
    or (p_client_fingerprint is not null and p_client_fingerprint !~ '^[0-9a-f]{64}$') then
    return null;
  end if;

  select s.id, p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp'
    into v_share_id, v_path
    from public.gallery_shares s
    join public.galleries g on g.tenant_id = s.tenant_id and g.id = s.gallery_id
    join public.photos p on p.tenant_id = s.tenant_id and p.gallery_id = s.gallery_id
    where s.token_hash = extensions.digest(p_token, 'sha256') and s.revoked_at is null
      and s.expires_at > clock_timestamp() and g.status = 'published'
      and p.id = p_photo_id and p.processing_status = 'ready' and p.deletion_requested_at is null
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
revoke all on function public.authorize_shared_photo_image(text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_shared_photo_image(text, uuid, text, text) to service_role;

create function public.prune_gallery_share_image_rate_limits(p_batch_size integer default 1000)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_removed integer;
begin
  if p_batch_size is null or p_batch_size not between 1 and 5000 then
    raise exception 'SHARE_IMAGE_RATE_LIMIT_BATCH_INVALID' using errcode = '22023';
  end if;
  with stale as (
    select ctid from private.gallery_share_image_rate_limits
    where updated_at < clock_timestamp() - interval '24 hours'
    order by updated_at limit p_batch_size for update skip locked
  )
  delete from private.gallery_share_image_rate_limits as limits using stale
    where limits.ctid = stale.ctid;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;
revoke all on function public.prune_gallery_share_image_rate_limits(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_gallery_share_image_rate_limits(integer) to service_role;

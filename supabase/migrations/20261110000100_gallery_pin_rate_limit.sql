alter table public.gallery_shares
  drop column pin_failed_attempts,
  drop column pin_locked_until;

create table private.gallery_share_pin_attempts (
  share_id uuid not null references public.gallery_shares(id) on delete cascade,
  client_fingerprint bytea not null check (octet_length(client_fingerprint) = 32),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  locked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (share_id, client_fingerprint)
);
create index gallery_share_pin_attempts_updated_idx
  on private.gallery_share_pin_attempts(updated_at);
alter table private.gallery_share_pin_attempts enable row level security;
revoke all on private.gallery_share_pin_attempts from public, anon, authenticated, service_role;

drop function public.create_gallery_pin_session(text, text);
create function public.create_gallery_pin_session(
  p_token text,
  p_pin text,
  p_client_fingerprint text
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_share public.gallery_shares%rowtype;
  v_attempt private.gallery_share_pin_attempts%rowtype;
  v_fingerprint bytea;
  v_access_token text;
  v_session_expiry timestamptz;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$'
    or p_pin is null or p_pin !~ '^[0-9]{6,12}$'
    or p_client_fingerprint is null or p_client_fingerprint !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  v_fingerprint := decode(p_client_fingerprint, 'hex');

  select * into v_share from public.gallery_shares
    where token_hash = extensions.digest(p_token, 'sha256') for share;
  if not found or v_share.revoked_at is not null or v_share.expires_at <= clock_timestamp()
    or v_share.pin_hash is null
    or not exists (select 1 from public.galleries where tenant_id = v_share.tenant_id
      and id = v_share.gallery_id and status = 'published') then
    return null;
  end if;

  delete from private.gallery_share_pin_attempts
    where share_id = v_share.id and updated_at < clock_timestamp() - interval '24 hours';
  insert into private.gallery_share_pin_attempts(share_id, client_fingerprint)
    values (v_share.id, v_fingerprint) on conflict do nothing;
  select * into v_attempt from private.gallery_share_pin_attempts
    where share_id = v_share.id and client_fingerprint = v_fingerprint for update;

  if v_attempt.updated_at < clock_timestamp() - interval '1 hour' then
    update private.gallery_share_pin_attempts set failed_attempts = 0, locked_until = null,
      updated_at = clock_timestamp()
      where share_id = v_share.id and client_fingerprint = v_fingerprint;
    v_attempt.failed_attempts := 0;
    v_attempt.locked_until := null;
  end if;
  if v_attempt.locked_until > clock_timestamp() then return 'PIN_RATE_LIMITED'; end if;

  if extensions.crypt(p_pin, v_share.pin_hash) is distinct from v_share.pin_hash then
    if v_attempt.failed_attempts >= 4 then
      update private.gallery_share_pin_attempts set failed_attempts = 5,
        locked_until = clock_timestamp() + interval '1 hour', updated_at = clock_timestamp()
        where share_id = v_share.id and client_fingerprint = v_fingerprint;
    else
      update private.gallery_share_pin_attempts set failed_attempts = failed_attempts + 1,
        updated_at = clock_timestamp()
        where share_id = v_share.id and client_fingerprint = v_fingerprint;
    end if;
    return null;
  end if;

  delete from private.gallery_share_pin_attempts
    where share_id = v_share.id and client_fingerprint = v_fingerprint;
  delete from public.gallery_share_pin_sessions where expires_at <= clock_timestamp();
  v_access_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_session_expiry := least(v_share.expires_at, clock_timestamp() + interval '12 hours');
  insert into public.gallery_share_pin_sessions(share_id, token_hash, expires_at)
    values (v_share.id, extensions.digest(v_access_token, 'sha256'), v_session_expiry);
  return v_access_token;
end;
$$;
revoke all on function public.create_gallery_pin_session(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_gallery_pin_session(text, text, text) to service_role;

create or replace function private.revoke_gallery_share_pin_sessions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    delete from public.gallery_share_pin_sessions where share_id = new.id;
    delete from private.gallery_share_pin_attempts where share_id = new.id;
  end if;
  return new;
end;
$$;

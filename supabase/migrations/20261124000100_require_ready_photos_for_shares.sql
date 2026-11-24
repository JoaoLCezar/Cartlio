create function private.require_ready_photo_for_gallery_share()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.photos p
    where p.tenant_id = new.tenant_id and p.gallery_id = new.gallery_id
      and p.processing_status = 'ready' and p.deletion_requested_at is null
  ) then
    raise exception 'SHARE_NO_READY_PHOTOS' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.require_ready_photo_for_gallery_share() from public, anon, authenticated;

create trigger gallery_shares_require_ready_photo_on_insert
  before insert on public.gallery_shares
  for each row execute function private.require_ready_photo_for_gallery_share();

create trigger gallery_shares_require_ready_photo_on_rotation
  before update of token_hash on public.gallery_shares
  for each row execute function private.require_ready_photo_for_gallery_share();

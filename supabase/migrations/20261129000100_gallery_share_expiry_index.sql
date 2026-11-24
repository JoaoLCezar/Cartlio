create index gallery_shares_active_expiry_idx
  on public.gallery_shares(tenant_id, expires_at)
  where revoked_at is null;

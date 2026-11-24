-- The browser cleans the object if its subsequent metadata insert fails.
-- Scope deletion to galleries in the caller's workspaces.
create policy gallery_originals_delete_member on storage.objects for delete to authenticated
  using (
    bucket_id = 'gallery-originals'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (
      select 1 from public.galleries g
      where g.id = ((storage.foldername(name))[2])::uuid
        and g.tenant_id = ((storage.foldername(name))[1])::uuid
        and (select private.is_tenant_member(g.tenant_id))
    )
  );

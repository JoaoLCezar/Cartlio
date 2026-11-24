-- Require durable intent for recorded photos even through direct Storage calls.
-- Unregistered objects can still be cleaned after a failed metadata insert.
alter policy gallery_originals_delete_member on storage.objects
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
    and not exists (
      select 1 from public.photos p
      where p.object_path = storage.objects.name and p.deletion_requested_at is null
    )
  );

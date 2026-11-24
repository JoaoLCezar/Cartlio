-- Storage DELETE also needs to see the object through SELECT. Keep pending
-- derivatives visible to the same workspace solely to complete deletion;
-- the app never signs a URL once the deletion intent is recorded.
alter policy gallery_previews_select_ready on storage.objects using (
  bucket_id = 'gallery-previews' and exists (
    select 1 from public.photos p where
      name = p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp'
      and (p.processing_status = 'ready' or p.deletion_requested_at is not null)
      and private.is_tenant_member(p.tenant_id)
  )
);
alter policy gallery_thumbnails_select_ready on storage.objects using (
  bucket_id = 'gallery-thumbnails' and exists (
    select 1 from public.photos p where
      name = p.tenant_id::text || '/' || p.gallery_id::text || '/' || p.id::text || '.webp'
      and (p.processing_status = 'ready' or p.deletion_requested_at is not null)
      and private.is_tenant_member(p.tenant_id)
  )
);

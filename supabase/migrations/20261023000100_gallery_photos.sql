create table public.photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  gallery_id uuid not null,
  object_path text not null unique,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  content_type text not null check (content_type in ('image/jpeg', 'image/png')),
  byte_size bigint not null check (byte_size between 1 and 6291456),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, gallery_id, id),
  constraint photos_gallery_same_tenant foreign key (tenant_id, gallery_id)
    references public.galleries(tenant_id, id) on delete cascade,
  constraint photos_path_matches_gallery check (
    object_path = tenant_id::text || '/' || gallery_id::text || '/' || id::text ||
      case content_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' end
  )
);
create index photos_gallery_created_idx on public.photos(tenant_id, gallery_id, created_at, id);

alter table public.photos enable row level security;
revoke all on public.photos from public, anon, authenticated;
grant select on public.photos to authenticated;
grant insert (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by)
  on public.photos to authenticated;

create policy photos_select_member on public.photos for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));
create policy photos_insert_member on public.photos for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.is_tenant_member(tenant_id))
    and exists (
      select 1 from public.galleries g
      where g.id = photos.gallery_id and g.tenant_id = photos.tenant_id and g.status <> 'archived'
    )
  );

-- A foto can only be uploaded to the matching workspace/gallery. Exact object
-- keys use tenant/gallery/photo UUIDs and MIME-compatible extensions.
create policy gallery_originals_insert_member on storage.objects for insert to authenticated
  with check (
    bucket_id = 'gallery-originals'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and char_length(storage.filename(name)) = 40
    and left(storage.filename(name), 36) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and right(storage.filename(name), 4) in ('.jpg', '.png')
    and exists (
      select 1 from public.galleries g
      where g.id = ((storage.foldername(name))[2])::uuid
        and g.tenant_id = ((storage.foldername(name))[1])::uuid
        and g.status <> 'archived'
        and (select private.is_tenant_member(g.tenant_id))
    )
  );

-- Original objects remain private. Only a recorded photo in the same workspace
-- can be read, and only by that workspace's authenticated members.
create policy gallery_originals_select_photo_member on storage.objects for select to authenticated
  using (
    bucket_id = 'gallery-originals'
    and exists (
      select 1 from public.photos p
      where p.object_path = name
        and p.tenant_id = ((storage.foldername(name))[1])::uuid
        and p.gallery_id = ((storage.foldername(name))[2])::uuid
        and (select private.is_tenant_member(p.tenant_id))
    )
  );

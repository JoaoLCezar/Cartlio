grant delete on public.photos to authenticated;

create policy photos_delete_member on public.photos for delete to authenticated
  using ((select private.is_tenant_member(tenant_id)));

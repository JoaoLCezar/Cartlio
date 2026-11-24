grant delete on public.customers to authenticated;
create policy customers_delete_member on public.customers for delete to authenticated
  using ((select private.is_tenant_member(tenant_id)));

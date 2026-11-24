alter table public.customers
  add column whatsapp_phone text,
  add constraint customers_whatsapp_phone_e164_check
    check (whatsapp_phone is null or whatsapp_phone ~ '^\+[1-9][0-9]{7,14}$');

grant insert (whatsapp_phone) on public.customers to authenticated;
grant update (whatsapp_phone) on public.customers to authenticated;

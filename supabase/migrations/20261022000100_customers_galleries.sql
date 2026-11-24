-- Owner e editor podem gerenciar clientes e galerias do seu workspace.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  email text check (email is null or (char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create type public.gallery_status as enum ('draft', 'published', 'archived');
create table public.galleries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  slug text not null check (char_length(slug) between 3 and 80 and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text not null default '' check (char_length(description) <= 2000),
  status public.gallery_status not null default 'draft',
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug),
  constraint galleries_customer_same_tenant foreign key (tenant_id, customer_id)
    references public.customers(tenant_id, id) on delete restrict
);
create index galleries_customer_idx on public.galleries (tenant_id, customer_id);
create index galleries_tenant_created_idx on public.galleries (tenant_id, created_at desc);
alter table public.customers enable row level security;
alter table public.galleries enable row level security;
revoke all on public.customers, public.galleries from public, anon, authenticated;
grant select on public.customers, public.galleries to authenticated;
grant insert (tenant_id, name, email) on public.customers to authenticated;
grant update (name, email) on public.customers to authenticated;
grant insert (tenant_id, customer_id, title, slug, description, status) on public.galleries to authenticated;
grant update (customer_id, title, slug, description, status) on public.galleries to authenticated;
create policy customers_select_member on public.customers for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));
create policy customers_insert_member on public.customers for insert to authenticated
  with check ((select private.is_tenant_member(tenant_id)));
create policy customers_update_member on public.customers for update to authenticated
  using ((select private.is_tenant_member(tenant_id))) with check ((select private.is_tenant_member(tenant_id)));
create policy galleries_select_member on public.galleries for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));
create policy galleries_insert_member on public.galleries for insert to authenticated
  with check ((select private.is_tenant_member(tenant_id)));
create policy galleries_update_member on public.galleries for update to authenticated
  using ((select private.is_tenant_member(tenant_id))) with check ((select private.is_tenant_member(tenant_id)));
comment on column public.galleries.status is 'Estado editorial interno; published não concede acesso público.';

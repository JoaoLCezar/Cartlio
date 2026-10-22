-- Primeira fronteira de segurança: identidade, workspace e associação.
-- Executar pelo Supabase CLI; auth.users e auth.uid() pertencem à plataforma.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) between 3 and 48),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create type public.tenant_role as enum ('owner', 'editor');

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.tenant_role not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_tenant_idx on public.tenant_members (user_id, tenant_id);
create unique index tenant_members_one_owner_idx on public.tenant_members (tenant_id) where role = 'owner';

-- A função lê a associação como seu dono para evitar recursão nas políticas de
-- tenants e tenant_members. Ela só responde sobre o usuário autenticado atual.
create function private.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid())
  );
$$;

create function private.is_tenant_owner(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

revoke all on function private.is_tenant_member(uuid) from public, anon, authenticated;
revoke all on function private.is_tenant_owner(uuid) from public, anon, authenticated;
grant execute on function private.is_tenant_member(uuid) to authenticated;
grant execute on function private.is_tenant_owner(uuid) to authenticated;

-- Única porta de criação de workspace: tenant e owner nascem na mesma transação.
-- A função exposta não aceita user_id/owner_id do cliente.
create function public.create_workspace(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    raise exception 'Invalid workspace name' using errcode = '22023';
  end if;

  if p_slug is null or char_length(p_slug) not between 3 and 48
    or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Invalid workspace slug' using errcode = '22023';
  end if;

  insert into public.tenants (slug, name, created_by)
  values (p_slug, btrim(p_name), v_user_id)
  returning id into v_tenant_id;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_tenant_id, v_user_id, 'owner');

  return v_tenant_id;
end;
$$;

revoke all on function public.create_workspace(text, text) from public, anon, authenticated;
grant execute on function public.create_workspace(text, text) to authenticated;

alter table public.profiles enable row level security;
alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;

-- Revogar grants é necessário além de habilitar RLS. Cada operação é explícita.
revoke all on public.profiles, public.tenants, public.tenant_members from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.tenants, public.tenant_members to authenticated;

create policy profiles_select_self on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy tenants_select_member on public.tenants
  for select to authenticated
  using ((select private.is_tenant_member(id)));

create policy tenant_members_select_member on public.tenant_members
  for select to authenticated
  using ((select private.is_tenant_member(tenant_id)));

comment on function public.create_workspace(text, text) is
  'Atomic authenticated workspace creation; caller becomes its owner.';

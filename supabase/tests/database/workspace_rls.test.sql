begin;

select plan(10);

-- Dados apenas nesta transação; rollback evita usuários de teste persistentes.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@cartlio.test', '', now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@cartlio.test', '', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select public.create_workspace('Fotógrafo A', 'fotografo-a-test');

select is((select count(*)::int from public.tenants), 1, 'A vê seu workspace');
select is((select count(*)::int from public.tenant_members), 1, 'A vê sua associação');
select throws_ok(
  $$ insert into public.tenant_members (tenant_id, user_id, role)
     select id, '22222222-2222-4222-8222-222222222222', 'owner' from public.tenants $$,
  '42501', 'permission denied for table tenant_members',
  'Membro não consegue se conceder papel de owner'
);
select throws_ok(
  $$ insert into public.tenants (slug, name, created_by)
     values ('injetado-test', 'Injetado', '22222222-2222-4222-8222-222222222222') $$,
  '42501', 'permission denied for table tenants',
  'Usuário não consegue forjar o criador diretamente'
);

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select public.create_workspace('Fotógrafo B', 'fotografo-b-test');

select is((select count(*)::int from public.tenants), 1, 'B vê apenas seu workspace');
select is((select count(*)::int from public.tenant_members), 1, 'B vê apenas sua associação');
select is((select count(*)::int from public.tenants where slug = 'fotografo-a-test'), 0, 'B não lê A');
select is((select private.is_tenant_owner(id) from public.tenants where slug = 'fotografo-b-test'), true, 'B é owner de B');

reset role;
select is((select count(*)::int from public.tenants), 2, 'Administrador vê ambos para conferência');
set local role anon;
select throws_ok(
  $$ select * from public.tenants $$,
  '42501', 'permission denied for table tenants',
  'Visitante anônimo não acessa workspaces'
);

select * from finish();
rollback;

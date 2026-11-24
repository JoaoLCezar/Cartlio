begin;
select plan(9);

insert into auth.users (id, instance_id, aud, role, email)
values
 ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profile-a@cartlio.test'),
 ('44444444-4444-4444-8444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'profile-b@cartlio.test');

set local role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
insert into public.profiles (id, display_name) values ('33333333-3333-4333-8333-333333333333', 'Pessoa A');
select is((select display_name from public.profiles), 'Pessoa A', 'Usuário lê o próprio perfil');
update public.profiles set display_name = 'Novo nome';
select is((select display_name from public.profiles), 'Novo nome', 'Usuário altera o próprio nome');
select throws_ok(
 $$ insert into public.profiles (id, display_name) values ('44444444-4444-4444-8444-444444444444', 'Forjado') $$,
 '42501', 'new row violates row-level security policy for table "profiles"', 'Não cria perfil de outra pessoa'
);
select throws_ok(
 $$ select public.create_workspace('Inválido', 'A') $$,
 '22023', 'Invalid workspace slug', 'Rejeita endereço inválido'
);
select public.create_workspace('Workspace', 'profile-workspace-test');
select throws_ok(
 $$ select public.create_workspace('Duplicado', 'profile-workspace-test') $$,
 '23505', 'duplicate key value violates unique constraint "tenants_slug_key"', 'Rejeita endereço duplicado'
);
select is((select count(*)::int from public.tenant_members), 1, 'Falha não cria associação extra');

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
select is((select count(*)::int from public.profiles), 0, 'Outro usuário não lê perfil alheio');
with changed as (update public.profiles set display_name = 'Invadido' returning id)
select is((select count(*)::int from changed), 0, 'Outro usuário não altera perfil alheio');

set local role anon;
select throws_ok(
 $$ select public.create_workspace('Anônimo', 'anon-workspace-test') $$,
 '42501', 'permission denied for function create_workspace', 'Anônimo não cria workspace'
);
select * from finish();
rollback;

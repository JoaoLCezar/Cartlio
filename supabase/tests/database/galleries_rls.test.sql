begin;
select no_plan();
insert into auth.users (id, instance_id, aud, role, email) values
 ('55555555-5555-4555-8555-555555555555', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gallery-a@cartlio.test'),
 ('66666666-6666-4666-8666-666666666666', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gallery-b@cartlio.test');
insert into public.tenants (id, slug, name, created_by) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'gallery-a-test', 'A', '55555555-5555-4555-8555-555555555555'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'gallery-b-test', 'B', '66666666-6666-4666-8666-666666666666');
insert into public.tenant_members (tenant_id, user_id, role) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '55555555-5555-4555-8555-555555555555', 'owner'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '66666666-6666-4666-8666-666666666666', 'owner');
insert into public.customers (id, tenant_id, name) values
 ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Cliente A'),
 ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Cliente B');
insert into public.galleries (id, tenant_id, customer_id, title, slug) values
 ('aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000001', 'Galeria A', 'ensaio'),
 ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000001', 'Galeria B', 'ensaio');

set local role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', true);
select lives_ok($$update public.customers set whatsapp_phone = '+5511987654321' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$, 'Member saves international WhatsApp');
select is((select whatsapp_phone from public.customers where id = 'aaaaaaaa-0000-4000-8000-000000000001'), '+5511987654321', 'WhatsApp is saved in normalized format');
select throws_ok($$update public.customers set whatsapp_phone = '11987654321' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$, '23514', null, 'Database rejects WhatsApp without country code');
select is((select count(*)::int from public.customers), 1, 'A só lê seus clientes');
select is((select count(*)::int from public.galleries), 1, 'A só lê suas galerias');
select lives_ok($$insert into public.customers (tenant_id, name, email) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Novo cliente', 'cliente@example.test')$$, 'Membro cadastra cliente');
select lives_ok($$insert into public.galleries (tenant_id, title, slug) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Sem cliente', 'sem-cliente')$$, 'Cliente da galeria é opcional');
select is((select status::text from public.galleries where slug = 'sem-cliente'), 'draft', 'Nova galeria começa em rascunho');
select lives_ok($$update public.galleries set status = 'published', title = 'Atualizada' where slug = 'ensaio'$$, 'Membro publica e edita galeria');
select is((select status::text from public.galleries where slug = 'ensaio'), 'published', 'Publicação persistida');
select lives_ok($$update public.galleries set status = 'archived' where slug = 'ensaio'$$, 'Membro arquiva galeria');
select is((select status::text from public.galleries where slug = 'ensaio'), 'archived', 'Arquivamento persistido');
select throws_ok($$insert into public.customers (tenant_id, name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Invasão')$$, '42501', null, 'Não cadastra cliente em outro workspace');
select throws_ok($$insert into public.galleries (tenant_id, title, slug) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Invasão', 'invasao')$$, '42501', null, 'Não cadastra galeria em outro workspace');
with changed as (update public.customers set name = 'Invadido' where tenant_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning id)
select is((select count(*)::int from changed), 0, 'Não altera cliente de outro workspace');
with changed as (update public.galleries set status = 'published' where tenant_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning id)
select is((select count(*)::int from changed), 0, 'Não altera galeria de outro workspace');
select throws_ok($$update public.galleries set customer_id = 'bbbbbbbb-0000-4000-8000-000000000001' where slug = 'ensaio'$$, '23503', null, 'FK impede vincular cliente de outro workspace');
select throws_ok($$insert into public.galleries (tenant_id, title, slug) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Duplicada', 'ensaio')$$, '23505', null, 'Endereço é único por workspace');
select throws_ok($$update public.galleries set tenant_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$, '42501', null, 'Workspace da galeria é imutável');
select throws_ok($$update public.customers set tenant_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$, '42501', null, 'Workspace do cliente é imutável');
select throws_ok($$delete from public.galleries$$, '42501', null, 'Exclusão de galerias não é permitida nesta etapa');
select throws_ok($$delete from public.customers where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$, '23503', null, 'Cliente vinculado não pode ser excluído');
select lives_ok($$delete from public.customers where name = 'Novo cliente'$$, 'Cliente sem galerias pode ser excluído');
select is((select count(*)::int from public.customers where name = 'Novo cliente'), 0, 'Exclusão do cliente confirmada');
select throws_ok($$insert into public.customers (tenant_id, name, email) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Inválido', 'sem-arroba')$$, '23514', null, 'Banco valida e-mail');

-- Mesmo com acesso aos dois workspaces, a relação não pode cruzar tenants.
reset role;
insert into public.tenant_members (tenant_id, user_id, role) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '55555555-5555-4555-8555-555555555555', 'editor');
set local role authenticated;
select throws_ok($$update public.galleries set customer_id = 'bbbbbbbb-0000-4000-8000-000000000001' where tenant_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and slug = 'ensaio'$$, '23503', null, 'Membro de ambos também não cruza clientes');
select lives_ok($$update public.galleries set title = 'Editada por editor' where tenant_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$, 'Editor pode editar');
select is((select title from public.galleries where tenant_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 'Editada por editor', 'Edição persistida');
set local role anon;
select throws_ok($$select whatsapp_phone from public.customers$$, '42501', null, 'Anonymous visitors cannot read private WhatsApp numbers');
select throws_ok($$select * from public.customers$$, '42501', null, 'Anônimo não lê clientes');
select throws_ok($$select * from public.galleries$$, '42501', null, 'Anônimo não lê galerias');
select throws_ok($$delete from public.customers$$, '42501', null, 'Anônimo não exclui clientes');
select * from finish();
rollback;

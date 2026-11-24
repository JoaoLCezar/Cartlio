begin;
select no_plan();

insert into auth.users (id, instance_id, aud, role, email) values
 ('77777777-7777-4777-8777-777777777777', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'photos-a@cartlio.test'),
 ('88888888-8888-4888-8888-888888888888', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'photos-b@cartlio.test');
insert into public.tenants (id, slug, name, created_by) values
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'photos-a-test', 'Fotos A', '77777777-7777-4777-8777-777777777777'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'photos-b-test', 'Fotos B', '88888888-8888-4888-8888-888888888888');
insert into public.tenant_members (tenant_id, user_id, role) values
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '77777777-7777-4777-8777-777777777777', 'owner'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '88888888-8888-4888-8888-888888888888', 'owner');
insert into public.galleries (id, tenant_id, title, slug, status) values
 ('cccccccc-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Rascunho A', 'rascunho-a', 'draft'),
 ('cccccccc-0000-4000-8000-000000000002', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Arquivada A', 'arquivada-a', 'archived'),
 ('dddddddd-0000-4000-8000-000000000001', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Rascunho B', 'rascunho-b', 'draft');

select lives_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('gallery-originals', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000011.png', '77777777-7777-4777-8777-777777777777')$$, 'Membro envia imagem ao rascunho do próprio workspace');
select lives_ok($$insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by) values ('cccccccc-0000-4000-8000-000000000011', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000011.png', 'foto.png', 'image/png', 128, '77777777-7777-4777-8777-777777777777')$$, 'Membro registra os metadados da imagem');
set local role authenticated;
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', true);
select is((select count(*)::int from storage.objects where name like '%/cccccccc-0000-4000-8000-000000000011.png'), 1, 'Membro autorizado consegue ler o objeto registrado');
select is((select count(*)::int from public.photos), 1, 'Membro lê os metadados da própria foto');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('gallery-originals', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000020.png', '77777777-7777-4777-8777-777777777777')$$, '42501', null, 'Upload sem reserva e rejeitado');

select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('gallery-originals', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/dddddddd-0000-4000-8000-000000000001/dddddddd-0000-4000-8000-000000000011.png', '77777777-7777-4777-8777-777777777777')$$, '42501', null, 'Membro não envia ao workspace de outra pessoa');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('gallery-originals', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000002/cccccccc-0000-4000-8000-000000000012.png', '77777777-7777-4777-8777-777777777777')$$, '42501', null, 'Membro não envia a galeria arquivada');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('gallery-originals', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000013.webp', '77777777-7777-4777-8777-777777777777')$$, '42501', null, 'Storage rejeita extensão não permitida');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('gallery-originals', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000099/cccccccc-0000-4000-8000-000000000014.png', '77777777-7777-4777-8777-777777777777')$$, '42501', null, 'Storage rejeita galeria inexistente');
select throws_ok($$insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by) values ('cccccccc-0000-4000-8000-000000000015', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000015.png', 'forjada.png', 'image/png', 128, '88888888-8888-4888-8888-888888888888')$$, '42501', null, 'Foto não pode forjar o autor do upload');
select throws_ok($$insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by) values ('cccccccc-0000-4000-8000-000000000016', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000002/cccccccc-0000-4000-8000-000000000016.png', 'arquivada.png', 'image/png', 128, '77777777-7777-4777-8777-777777777777')$$, '42501', null, 'Metadados não podem entrar numa galeria arquivada');
reset role;
select throws_ok($$insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by) values ('cccccccc-0000-4000-8000-000000000017', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000017.png', 'grande.png', 'image/png', 52428801, '77777777-7777-4777-8777-777777777777')$$, '23514', null, 'Banco aplica o limite de tamanho do arquivo');
select throws_ok($$insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by) values ('cccccccc-0000-4000-8000-000000000018', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000018.jpg', 'extensão.png', 'image/png', 128, '77777777-7777-4777-8777-777777777777')$$, '23514', null, 'Caminho do objeto deve corresponder ao tipo da imagem');
set local role authenticated;
select throws_ok($$insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by) values ('cccccccc-0000-4000-8000-000000000019', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'cccccccc-0000-4000-8000-000000000001', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000019.png', 'cruzada.png', 'image/png', 128, '77777777-7777-4777-8777-777777777777')$$, '42501', null, 'RLS rejeita foto que tenta cruzar workspaces');

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', true);
select is((select count(*)::int from public.photos), 0, 'Outro usuário não lê metadados de fotos');
select is((select count(*)::int from storage.objects where name like '%/cccccccc-0000-4000-8000-000000000011.png'), 0, 'Outro usuário não lê o objeto privado');
select throws_ok($$delete from storage.objects where name like '%/cccccccc-0000-4000-8000-000000000011.png'$$, '42501', null, 'Outro usuário não remove o objeto privado');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('gallery-originals', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/88888888-0000-4000-8000-000000000011.png', '88888888-8888-4888-8888-888888888888')$$, '42501', null, 'Outro usuário não envia ao workspace A');

select throws_ok('delete from public.photos where id = ''cccccccc-0000-4000-8000-000000000011''', '42501', null, 'Direct deletion is forbidden for another user');
select throws_ok($$select public.begin_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011')$$, '42501', null, 'Another user cannot start deletion');
select throws_ok($$select public.finish_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011')$$, '42501', null, 'Another user cannot finish deletion');
select is(public.begin_photo_deletion('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011'), null::text, 'Own gallery cannot be used to target another workspace photo');
select is(public.finish_photo_deletion('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'dddddddd-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011'), true, 'Completion in wrong scope does not affect the target photo');
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', true);
select is((select count(*)::int from public.photos), 1, 'Workspace member still sees the photo after another user tried deleting it');
select throws_ok('delete from public.photos where id = ''cccccccc-0000-4000-8000-000000000011''', '42501', null, 'Members must use the recoverable deletion flow');
select throws_ok($$update public.photos set deletion_requested_at = now()$$, '42501', null, 'Lifecycle state cannot be changed directly');
select is(public.begin_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000011'), null::text, 'Wrong gallery does not mark the photo');
select ok((select deletion_requested_at is null from public.photos where id = 'cccccccc-0000-4000-8000-000000000011'), 'Wrong scope leaves intent unchanged');
select is(public.finish_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011'), false, 'Completion requires recorded intent');
select is(public.begin_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011'), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000011.png', 'Authorized request returns the stored object path');
select ok((select deletion_requested_at is not null from public.photos where id = 'cccccccc-0000-4000-8000-000000000011'), 'Deletion intent is persisted');
select is(public.finish_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011'), false, 'Object still present prevents metadata deletion');
select is((select count(*)::int from public.photos), 1, 'Incomplete deletion retains its recovery record');

reset role;
update public.photos set deletion_requested_at = '2026-01-01T00:00:00Z' where id = 'cccccccc-0000-4000-8000-000000000011';
-- A missing object in an archived gallery models an interrupted Storage deletion.
insert into public.photos (id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, created_by) values
('cccccccc-0000-4000-8000-000000000021', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/cccccccc-0000-4000-8000-000000000002/cccccccc-0000-4000-8000-000000000021.png', 'interrupted.png', 'image/png', 128, '77777777-7777-4777-8777-777777777777');
set local role authenticated;
select lives_ok($$select public.begin_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011')$$, 'Beginning deletion again is safe');
select is((select deletion_requested_at from public.photos where id = 'cccccccc-0000-4000-8000-000000000011'), '2026-01-01T00:00:00Z'::timestamptz, 'Retries preserve the original deletion time');
select is(public.finish_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000021'), false, 'Even a missing object requires deletion intent');
select lives_ok($$select public.begin_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000021')$$, 'Deletion can be requested for an archived gallery');
select is(public.finish_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000021'), true, 'Missing object allows completion');
select is((select count(*)::int from public.photos where id = 'cccccccc-0000-4000-8000-000000000021'), 0, 'Completed deletion removes metadata');
select is(public.finish_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000021'), true, 'Repeated completion is idempotent');
select is(public.begin_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000021'), null::text, 'Already deleted photo is a harmless no-op');
set local role anon;
select throws_ok($$select public.begin_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011')$$, '42501', null, 'Anonymous cannot request deletion');
select throws_ok($$select public.finish_photo_deletion('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000011')$$, '42501', null, 'Anonymous cannot finalize deletion');
select throws_ok($$select * from public.photos$$, '42501', null, 'Anônimo não consulta metadados de fotos');
reset role;
select is((select count(*)::int from storage.objects where name like '%/cccccccc-0000-4000-8000-000000000011.png'), 1, 'Administrador pode conferir o objeto de teste');
select * from finish();
rollback;

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomer, parseGallery } from '../src/lib/gallery-validation.ts';
const form = values => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };
const gallery = { title: 'Ensaio', slug: 'ensaio', status: 'draft' };

test('cliente aceita e-mail opcional e normaliza espaços', () => {
  assert.deepEqual(parseCustomer(form({ name: '  Ana  ', email: '' })).value, { name: 'Ana', email: null, whatsapp_phone: null });
  assert.equal(parseCustomer(form({ name: 'Ana', email: ' ANA@EXAMPLE.TEST ' })).value.email, 'ana@example.test');
});
test('cliente normaliza WhatsApp internacional e pontuação comum', () => {
  assert.equal(parseCustomer(form({ name: 'Ana', whatsapp_phone: ' +55 (11) 98765-4321 ' })).value.whatsapp_phone, '+5511987654321');
});
test('cliente rejeita nome vazio e e-mail inválido', () => {
  for (const values of [{ name: ' ' }, { name: 'a'.repeat(121) }, { name: 'Ana', email: 'invalido' }]) assert.ok(parseCustomer(form(values)).error);
});
test('cliente rejeita WhatsApp sem código do país, inválido ou longo demais', () => {
  for (const whatsapp_phone of ['11987654321', '+0 11 98765-4321', '+5511abc', '+55' + '1'.repeat(15), '1'.repeat(33)]) {
    assert.ok(parseCustomer(form({ name: 'Ana', whatsapp_phone })).error);
  }
});
test('galeria normaliza endereço e permite ausência de cliente', () => {
  assert.deepEqual(parseGallery(form({ ...gallery, slug: ' ENSAIO ' })).value, { ...gallery, description: '', customer_id: null });
});
test('galeria rejeita status forjado e cliente inválido', () => {
  for (const status of ['__proto__', 'toString', 'deleted', '']) assert.ok(parseGallery(form({ ...gallery, status })).error);
  assert.ok(parseGallery(form({ ...gallery, customer_id: 'outro' })).error);
});
test('galeria valida limites, endereço e campos obrigatórios', () => {
  for (const change of [{ title: ' ' }, { title: 'a'.repeat(121) }, { slug: 'ab' }, { slug: 'a'.repeat(81) }, { slug: 'a--b' }, { slug: '../outro' }, { description: 'a'.repeat(2001) }]) assert.ok(parseGallery(form({ ...gallery, ...change })).error);
  for (const status of ['draft', 'published', 'archived']) assert.equal(parseGallery(form({ ...gallery, status })).value.status, status);
});

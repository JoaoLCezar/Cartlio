import assert from "node:assert/strict";
import test from "node:test";
import { customerSearchFilter, parseCustomerContactFilter } from "../src/lib/customer-search.ts";

test("searches customer names and e-mails with a contains match", () => {
  assert.equal(
    customerSearchFilter("  joao.silva@example.test  "),
    'name.ilike."%joao.silva@example.test%",email.ilike."%joao.silva@example.test%"',
  );
});

test("searches WhatsApp numbers by digits, ignoring common phone formatting", () => {
  assert.equal(
    customerSearchFilter(" +55 (11) 98765-4321 "),
    'name.ilike."%+55 (11) 98765-4321%",email.ilike."%+55 (11) 98765-4321%",whatsapp_phone.ilike."%5511987654321%"',
  );
  assert.equal(
    customerSearchFilter("21 9123"),
    'name.ilike."%21 9123%",email.ilike."%21 9123%",whatsapp_phone.ilike."%219123%"',
  );
});

test("does not interpret digits inside a name or short unrelated input as a phone search", () => {
  assert.doesNotMatch(customerSearchFilter("Ensaio 2026"), /whatsapp_phone/);
  assert.doesNotMatch(customerSearchFilter("1"), /whatsapp_phone/);
});

test("quotes reserved PostgREST punctuation inside the search term", () => {
  assert.equal(
    customerSearchFilter("Silva, (João): fotógrafo"),
    'name.ilike."%Silva, (João): fotógrafo%",email.ilike."%Silva, (João): fotógrafo%"',
  );
});

test("treats LIKE wildcards and backslashes as literal search characters", () => {
  assert.equal(
    customerSearchFilter("100%_foto\\ensaio"),
    'name.ilike."%100\\\\%\\\\_foto\\\\\\\\ensaio%",email.ilike."%100\\\\%\\\\_foto\\\\\\\\ensaio%"',
  );
});

test("escapes quotes and ignores an empty search", () => {
  assert.equal(customerSearchFilter('Ana "Jo"'), 'name.ilike."%Ana \\"Jo\\"%",email.ilike."%Ana \\"Jo\\"%"');
  assert.equal(customerSearchFilter("  "), null);
});

test("accepts only supported customer contact filters", () => {
  assert.equal(parseCustomerContactFilter("missing-email"), "missing-email");
  assert.equal(parseCustomerContactFilter("missing-whatsapp"), "missing-whatsapp");
  assert.equal(parseCustomerContactFilter("all"), "all");
  assert.equal(parseCustomerContactFilter("other-column"), "all");
});

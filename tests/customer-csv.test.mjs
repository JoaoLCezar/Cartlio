import assert from "node:assert/strict";
import test from "node:test";
import { customerCsv } from "../src/lib/customer-csv.ts";

test("customer CSV is BOM-prefixed, semicolon-delimited, and quotes contact fields", () => {
  const csv = customerCsv([{
    name: 'Ana; "Silva"',
    email: "ana@example.test",
    whatsapp_phone: "+5511987654321",
    created_at: "2026-10-28T12:00:00.000Z",
  }]);

  assert.equal(
    csv,
    `\uFEFF"Nome";"E-mail";"WhatsApp";"Criado em"\r\n"Ana; ""Silva""";"ana@example.test";"'+5511987654321";"2026-10-28T12:00:00.000Z"\r\n`,
  );
});

test("customer CSV neutralizes spreadsheet formulas and preserves blank optional fields", () => {
  const csv = customerCsv([{
    name: "  =HYPERLINK(\"https://example.test\")",
    email: null,
    whatsapp_phone: null,
    created_at: "2026-10-28T12:00:00.000Z",
  }]);

  assert.ok(csv.includes(`"'  =HYPERLINK(""https://example.test"")"`));
  assert.ok(csv.includes(`;"";"";`));
});

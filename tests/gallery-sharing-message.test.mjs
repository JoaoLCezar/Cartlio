import assert from "node:assert/strict";
import { test } from "node:test";
import { gallerySelectionRevisionWhatsAppUrl, whatsappMessageUrl } from "../src/lib/gallery-sharing-message.ts";

test("revision WhatsApp message includes the gallery, photographer's note, and existing-link instructions", () => {
  const url = new URL(gallerySelectionRevisionWhatsAppUrl("Ensaio de família", "Escolha outra foto da cerimônia.", false));
  const message = url.searchParams.get("text");

  assert.equal(`${url.origin}${url.pathname}`, "https://wa.me/");
  assert.match(message, /Ensaio de família/);
  assert.match(message, /Escolha outra foto da cerimônia\./);
  assert.match(message, /Abra novamente o mesmo link/);
  assert.match(message, /Se o link tiver vencido/);
});

test("revision WhatsApp message reminds PIN-protected clients without exposing a code", () => {
  const message = new URL(gallerySelectionRevisionWhatsAppUrl("Ensaio protegido", "Troque uma foto.", true)).searchParams.get("text");

  assert.match(message, /use o código que enviei separadamente/);
  assert.doesNotMatch(message, /\b\d{6,12}\b/);
});

test("WhatsApp messages target a valid saved number and keep the default contact picker otherwise", () => {
  const targeted = new URL(whatsappMessageUrl("Galeria pronta", "+5511987654321"));
  assert.equal(targeted.pathname, "/5511987654321");
  assert.equal(targeted.searchParams.get("text"), "Galeria pronta");

  const generic = new URL(whatsappMessageUrl("Galeria pronta", "+0 invalid"));
  assert.equal(generic.pathname, "/");
  assert.equal(generic.searchParams.get("text"), "Galeria pronta");
});

test("revision WhatsApp message targets the saved customer without including their phone in the text", () => {
  const url = new URL(gallerySelectionRevisionWhatsAppUrl("Ensaio", "Troque uma foto.", false, "+5511987654321"));
  assert.equal(url.pathname, "/5511987654321");
  assert.match(url.searchParams.get("text") ?? "", /Troque uma foto/);
  assert.doesNotMatch(url.searchParams.get("text") ?? "", /5511987654321/);
});

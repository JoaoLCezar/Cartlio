import assert from "node:assert/strict";
import test from "node:test";
import { contrastTextColor } from "../src/lib/brand-color.ts";

test("chooses readable text for light and dark studio colors", () => {
  assert.equal(contrastTextColor("#ffffff"), "#171815");
  assert.equal(contrastTextColor("#000000"), "#fffefa");
  assert.equal(contrastTextColor("#4a8068"), "#fffefa");
});

test("uses a safe fallback for invalid color values", () => {
  assert.equal(contrastTextColor("white"), "#171815");
  assert.equal(contrastTextColor("#123"), "#171815");
});

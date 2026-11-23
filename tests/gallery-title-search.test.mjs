import assert from "node:assert/strict";
import test from "node:test";
import { galleryTitleSearchPattern } from "../src/lib/gallery-title-search.ts";

test("builds a contains pattern and ignores whitespace-only searches", () => {
  assert.equal(galleryTitleSearchPattern("  Ensaio  "), "%Ensaio%");
  assert.equal(galleryTitleSearchPattern("  "), null);
});

test("treats LIKE wildcard characters and backslashes as literal title text", () => {
  assert.equal(galleryTitleSearchPattern("100%_foto\\ensaio"), "%100\\%\\_foto\\\\ensaio%");
});

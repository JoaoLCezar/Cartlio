import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { renderWatermarkedImages, watermarkSvg } from "../scripts/lib/image-processing.mjs";

test("preview and thumbnail derivatives include an escaped workspace watermark", async () => {
  const source = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#777777" } }).png().toBuffer();
  const rendered = await renderWatermarkedImages(source, "image/png", "Luz & <Afeto>");
  const preview = await sharp(rendered.preview).raw().toBuffer({ resolveWithObject: true });
  const thumbnail = await sharp(rendered.thumbnail).raw().toBuffer({ resolveWithObject: true });
  const changedPreviewPixels = Array.from({ length: preview.info.width * preview.info.height }, (_, index) => index)
    .filter(index => preview.data[index * preview.info.channels] > 140).length;
  const changedThumbnailPixels = Array.from({ length: thumbnail.info.width * thumbnail.info.height }, (_, index) => index)
    .filter(index => thumbnail.data[index * thumbnail.info.channels] > 140).length;

  assert.ok(changedPreviewPixels > 500, "preview contains visible watermark marks");
  assert.ok(changedThumbnailPixels > 100, "thumbnail contains visible watermark marks");
  assert.deepEqual([rendered.width, rendered.height], [900, 600]);
  assert.match(watermarkSvg("Luz & <Afeto>", 100, 80).toString(), /Luz &amp; &lt;Afeto&gt;/);
});

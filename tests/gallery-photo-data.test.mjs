import assert from "node:assert/strict";
import test from "node:test";
import { fetchAllGalleryPhotoIds, fetchAllPhotoPages, signPhotoPathsInBatches } from "../src/lib/gallery-photo-data.ts";

test("fetches all gallery photo IDs in small pages and validates a stable total", async () => {
  const requests = [];
  const result = await fetchAllGalleryPhotoIds(async offset => {
    requests.push(offset);
    const ids = ["a", "b", "c", "d", "e"].slice(offset, offset + 2);
    return { ids, totalCount: offset === 0 ? 5 : null, error: null };
  }, 2);

  assert.deepEqual(requests, [0, 2, 4]);
  assert.deepEqual(result, ["a", "b", "c", "d", "e"]);
});

test("rejects a changing or inconsistent gallery ID list", async () => {
  await assert.rejects(fetchAllGalleryPhotoIds(async offset => ({
    ids: offset === 0 ? ["a", "b"] : ["c"],
    totalCount: offset === 0 ? 4 : null,
    error: null,
  }), 2), /list changed/i);

  await assert.rejects(fetchAllGalleryPhotoIds(async offset => ({
    ids: offset === 0 ? ["a", "b"] : ["b", "c"],
    totalCount: offset === 0 ? 4 : null,
    error: null,
  }), 2), /list changed/i);
});

test("fetches every row in stable bounded pages, including when the last page is partial", async () => {
  const requestedRanges = [];
  const result = await fetchAllPhotoPages(async (from, to) => {
    requestedRanges.push([from, to]);
    return { data: Array.from({ length: Math.max(0, Math.min(3, 7 - from)) }, (_, index) => from + index), error: null };
  }, 3);

  assert.deepEqual(requestedRanges, [[0, 2], [3, 5], [6, 8]]);
  assert.deepEqual(result, { data: [0, 1, 2, 3, 4, 5, 6], error: null });
});

test("stops after a page error and returns the original error", async () => {
  const failure = new Error("page unavailable");
  let calls = 0;
  const result = await fetchAllPhotoPages(async () => {
    calls += 1;
    return { data: null, error: failure };
  }, 5);

  assert.equal(calls, 1);
  assert.equal(result.data, null);
  assert.equal(result.error, failure);
});

test("signs unique photo paths in bounded concurrent batches and skips individual failures", async () => {
  const paths = [...Array.from({ length: 205 }, (_, index) => `photo/${index}.webp`), "photo/0.webp"];
  const batchSizes = [];
  let activeBatches = 0;
  let maximumActiveBatches = 0;
  const signed = await signPhotoPathsInBatches(paths, async batch => {
    batchSizes.push(batch.length);
    activeBatches += 1;
    maximumActiveBatches = Math.max(maximumActiveBatches, activeBatches);
    await new Promise(resolve => setTimeout(resolve, 1));
    activeBatches -= 1;
    return {
      error: null,
      data: batch.map(path => ({
        path,
        error: path === "photo/150.webp" ? "Object missing" : null,
        signedUrl: path === "photo/150.webp" ? null : `https://storage.test/${path}`,
      })),
    };
  }, 50, 3);

  assert.deepEqual(batchSizes.sort((a, b) => b - a), [50, 50, 50, 50, 5]);
  assert.ok(maximumActiveBatches <= 3);
  assert.equal(signed.size, 204);
  assert.equal(signed.has("photo/150.webp"), false);
  assert.equal(signed.get("photo/204.webp"), "https://storage.test/photo/204.webp");
});

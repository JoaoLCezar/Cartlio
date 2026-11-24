import assert from "node:assert/strict";
import test from "node:test";
import { listR2StorageObjects } from "../scripts/lib/r2-storage-inventory.mjs";

test("R2 inventory walks every page and preserves object size and ETag", async () => {
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command.input);
      if (calls.length === 1) return {
        Contents: [
          { Key: "tenant/gallery/photo-a.jpg", Size: 12, ETag: '"etag-a"' },
          { Key: "tenant/gallery/photo-b.png", Size: 34, ETag: '"etag-b"' },
        ],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      };
      return {
        Contents: [{ Key: "tenant/gallery/photo-c.jpg", Size: 56, ETag: '"etag-c"' }],
        IsTruncated: false,
      };
    },
  };

  const objects = await listR2StorageObjects(client, "quadrics-test");

  assert.deepEqual(calls, [
    { Bucket: "quadrics-test" },
    { Bucket: "quadrics-test", ContinuationToken: "next-page" },
  ]);
  assert.deepEqual([...objects], [
    ["tenant/gallery/photo-a.jpg", { size: 12, etag: '"etag-a"' }],
    ["tenant/gallery/photo-b.png", { size: 34, etag: '"etag-b"' }],
    ["tenant/gallery/photo-c.jpg", { size: 56, etag: '"etag-c"' }],
  ]);
});

test("R2 inventory fails closed on invalid or repeated pagination", async () => {
  await assert.rejects(
    listR2StorageObjects({ async send() { return { Contents: [{ Key: "", Size: 1 }], IsTruncated: false }; } }, "quadrics-test"),
    { message: "R2_INVENTORY_INVALID" },
  );

  let calls = 0;
  await assert.rejects(listR2StorageObjects({
    async send() {
      calls += 1;
      return { Contents: [], IsTruncated: true, NextContinuationToken: "same-token" };
    },
  }, "quadrics-test"), { message: "R2_INVENTORY_INVALID" });
  assert.equal(calls, 2);
});

test("R2 inventory hides SDK errors and rejects duplicate keys", async () => {
  await assert.rejects(
    listR2StorageObjects({ async send() { throw new Error("sensitive account and bucket details"); } }, "quadrics-test"),
    { message: "R2_INVENTORY_UNAVAILABLE" },
  );
  await assert.rejects(listR2StorageObjects({
    async send() {
      return { Contents: [{ Key: "same.jpg", Size: 1 }, { Key: "same.jpg", Size: 1 }], IsTruncated: false };
    },
  }, "quadrics-test"), { message: "R2_INVENTORY_INVALID" });
});

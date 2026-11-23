import assert from "node:assert/strict";
import test from "node:test";
import { cleanupPendingPhotoDeletions } from "../scripts/lib/photo-deletion-cleanup.mjs";

const photo = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  tenant_id: "123e4567-e89b-12d3-a456-426614174001",
  gallery_id: "123e4567-e89b-12d3-a456-426614174002",
  object_path: "original.png",
};

test("removes every derivative and original before asking the database to finalize deletion", async () => {
  const calls = [];
  const client = {
    storage: { from: bucket => ({ remove: async paths => { calls.push(["remove", bucket, ...paths]); return { error: null }; } }) },
    rpc: async (name, args) => { calls.push(["rpc", name, args]); return { data: true, error: null }; },
  };

  const counts = await cleanupPendingPhotoDeletions(client, [photo]);

  assert.deepEqual(counts, { examined: 1, deleted: 1, failed: 0 });
  assert.deepEqual(calls.map(([kind, bucket]) => [kind, bucket]), [
    ["remove", "gallery-thumbnails"],
    ["remove", "gallery-previews"],
    ["remove", "gallery-originals"],
    ["rpc", "finish_photo_deletion_worker"],
  ]);
});

test("keeps the durable deletion intent when Storage cleanup fails", async () => {
  const calls = [];
  const client = {
    storage: { from: bucket => ({ remove: async () => {
      calls.push(bucket);
      return bucket === "gallery-previews" ? { error: new Error("Storage unavailable") } : { error: null };
    } }) },
    rpc: async () => { throw new Error("Must not finalize while an object may remain"); },
  };

  const counts = await cleanupPendingPhotoDeletions(client, [photo]);

  assert.deepEqual(counts, { examined: 1, deleted: 0, failed: 1 });
  assert.deepEqual(calls, ["gallery-thumbnails", "gallery-previews"]);
});

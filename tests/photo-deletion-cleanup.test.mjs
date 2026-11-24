import assert from "node:assert/strict";
import test from "node:test";
import { cleanupPendingPhotoDeletions } from "../scripts/lib/photo-deletion-cleanup.mjs";

const photo = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  tenant_id: "123e4567-e89b-12d3-a456-426614174001",
  gallery_id: "123e4567-e89b-12d3-a456-426614174002",
  object_path: "original.png",
};
const r2Photo = {
  ...photo,
  id: "123e4567-e89b-12d3-a456-426614174010",
  object_path: "123e4567-e89b-12d3-a456-426614174001/123e4567-e89b-12d3-a456-426614174002/123e4567-e89b-12d3-a456-426614174010.png",
  storage_provider: "r2",
  storage_etag: '"original-1"',
  content_type: "image/png",
  byte_size: 128,
  created_at: "2026-01-01T00:00:00.000Z",
  deletion_requested_at: "2026-01-02T00:00:00.000Z",
  storage_delete_absent_at: null,
};

test("removes every derivative and original before asking the database to finalize deletion", async () => {
  const calls = [];
  const client = {
    storage: { from: bucket => ({ remove: async paths => { calls.push(["remove", bucket, ...paths]); return { error: null }; } }) },
    rpc: async (name, args) => { calls.push(["rpc", name, args]); return { data: true, error: null }; },
  };

  const counts = await cleanupPendingPhotoDeletions(client, [photo]);

  assert.deepEqual(counts, { examined: 1, deleted: 1, deferred: 0, failed: 0 });
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

  assert.deepEqual(counts, { examined: 1, deleted: 0, deferred: 0, failed: 1 });
  assert.deepEqual(calls, ["gallery-thumbnails", "gallery-previews"]);
});

test("defers R2 cleanup until every upload capability has expired and settled", async () => {
  const calls = [];
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const counts = await cleanupPendingPhotoDeletions({
    storage: { from: bucket => ({ remove: async paths => { calls.push(["remove", bucket, ...paths]); return { error: null }; } }) },
    rpc: async name => { calls.push(["rpc", name]); return { data: true, error: null }; },
  }, [r2Photo], {
    now,
    uploadSessions: [{ id: r2Photo.id, expires_at: "2026-02-01T00:01:00.000Z" }],
    r2Access: { deleteVerifiedOriginal: async () => { throw new Error("Must wait for signed URLs to expire"); } },
  });

  assert.deepEqual(counts, { examined: 1, deleted: 0, deferred: 1, failed: 0 });
  assert.deepEqual(calls.map(([kind, bucket]) => [kind, bucket]), [
    ["remove", "gallery-thumbnails"],
    ["remove", "gallery-previews"],
  ]);
});

test("R2 cleanup records absence, waits through the confirmation window, then finalizes", async () => {
  const calls = [];
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  let absentAt = null;
  const client = {
    storage: { from: bucket => ({ remove: async paths => { calls.push(["remove", bucket, ...paths]); return { error: null }; } }) },
    rpc: async (name, args) => {
      calls.push(["rpc", name, args]);
      if (name === "record_r2_photo_deletion_absence") {
        absentAt = args.p_object_absent ? absentAt ?? new Date(now).toISOString() : null;
        return { data: true, error: null };
      }
      return { data: true, error: null };
    },
  };
  const r2Access = { deleteVerifiedOriginal: async () => ({ absent: true, wasPresent: true }) };
  const session = { id: r2Photo.id, expires_at: "2026-01-01T00:00:00.000Z" };

  const first = await cleanupPendingPhotoDeletions(client, [r2Photo], { now, uploadSessions: [session], r2Access });
  assert.deepEqual(first, { examined: 1, deleted: 0, deferred: 1, failed: 0 });
  assert.equal(absentAt, new Date(now).toISOString());

  const second = await cleanupPendingPhotoDeletions(client, [{ ...r2Photo, storage_delete_absent_at: absentAt }], {
    now: now + 6 * 60 * 1000,
    uploadSessions: [session],
    r2Access: { deleteVerifiedOriginal: async () => ({ absent: true, wasPresent: false }) },
  });
  assert.deepEqual(second, { examined: 1, deleted: 1, deferred: 0, failed: 0 });
  assert(calls.some(([kind, name]) => kind === "rpc" && name === "finish_r2_photo_deletion_worker"));
  assert(!calls.some(([kind, bucket]) => kind === "remove" && bucket === "gallery-originals"));
});

test("R2 metadata conflicts clear the absence timer and keep the deletion queued", async () => {
  const calls = [];
  const client = {
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    rpc: async (name, args) => { calls.push([name, args]); return { data: true, error: null }; },
  };
  const counts = await cleanupPendingPhotoDeletions(client, [{
    ...r2Photo,
    storage_delete_absent_at: "2026-01-01T00:00:00.000Z",
  }], {
    now: Date.parse("2026-02-01T00:00:00.000Z"),
    uploadSessions: [{ id: r2Photo.id, expires_at: "2026-01-01T00:00:00.000Z" }],
    r2Access: { deleteVerifiedOriginal: async () => { throw new Error("R2_ORIGINAL_CHANGED"); } },
  });

  assert.deepEqual(counts, { examined: 1, deleted: 0, deferred: 0, failed: 1 });
  assert.equal(calls[0][0], "record_r2_photo_deletion_absence");
  assert.equal(calls[0][1].p_object_absent, false);
  assert(!calls.some(([name]) => name === "finish_r2_photo_deletion_worker"));
});

import assert from "node:assert/strict";
import test from "node:test";
import { cleanupStorageOrphans, parseStorageCleanupArguments } from "../scripts/lib/storage-orphan-cleanup.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenantId = "22222222-2222-4222-8222-222222222222";
const galleryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const photoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const oldDate = "2026-10-18T00:00:00.000Z";
const now = new Date("2026-10-27T12:00:00.000Z");

function createClient({ photos = [], uploadSessions = [], tenants = [], onPhotoRead } = {}) {
  const objects = new Map([
    ["gallery-originals", new Map([
      [`${tenantId}/${galleryId}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg`, { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
      [`${tenantId}/${galleryId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png`, { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
      [`${tenantId}/${galleryId}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png`, { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
      [`${tenantId}/${galleryId}/ffffffff-ffff-4fff-8fff-ffffffffffff.jpg`, { created_at: "2026-10-26T00:00:00.000Z", updated_at: "2026-10-26T00:00:00.000Z", metadata: { size: 10 } }],
      [`${tenantId}/${galleryId}/12121212-1212-4121-8121-121212121212.png`, { created_at: oldDate, updated_at: "2026-10-26T00:00:00.000Z", metadata: { size: 10 } }],
      [`${tenantId}/${galleryId}/99999999-9999-4999-8999-999999999999.png`, { updated_at: oldDate, metadata: { size: 10 } }],
      [`${tenantId}/not-a-gallery/88888888-8888-4888-8888-888888888888.png`, { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
      [`${otherTenantId}/${galleryId}/77777777-7777-4777-8777-777777777777.jpg`, { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
    ])],
    ["gallery-previews", new Map([
      [`${tenantId}/${galleryId}/${photoId}.webp`, { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
      [`${tenantId}/${galleryId}/66666666-6666-4666-8666-666666666666.webp`, { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
    ])],
    ["gallery-thumbnails", new Map([
      [`${tenantId}/${galleryId}/55555555-5555-4555-8555-555555555555.webp`, { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
    ])],
    ["gallery-brand-assets", new Map([
      [tenantId + "/61616161-6161-4161-8161-616161616161.webp", { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
      [tenantId + "/62626262-6262-4262-8262-626262626262.webp", { created_at: "2026-10-26T00:00:00.000Z", updated_at: "2026-10-26T00:00:00.000Z", metadata: { size: 10 } }],
      [tenantId + "/not-a-uuid.webp", { created_at: oldDate, updated_at: oldDate, metadata: { size: 10 } }],
    ])],
  ]);
  const removals = [];
  let photoReadCount = 0;
  const client = {
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        order() { return query; },
        async range() {
          if (table === "photos") {
            photoReadCount += 1;
            return { data: onPhotoRead ? onPhotoRead(photoReadCount, photos) : photos, error: null };
          }
          if (table === "upload_sessions") return { data: uploadSessions, error: null };
          return { data: tenants, error: null };
        },
      };
      return query;
    },
    storage: {
      from(bucket) {
        return {
          async list(prefix, { limit, offset }) {
            const immediate = new Map();
            for (const [path, object] of objects.get(bucket)) {
              if (prefix && !path.startsWith(`${prefix}/`)) continue;
              const remainder = prefix ? path.slice(prefix.length + 1) : path;
              const slash = remainder.indexOf("/");
              const name = slash < 0 ? remainder : remainder.slice(0, slash);
              immediate.set(name, slash < 0 ? { name, ...object } : { name, metadata: null });
            }
            const items = [...immediate.values()].sort((left, right) => left.name.localeCompare(right.name));
            return { data: items.slice(offset, offset + limit), error: null };
          },
          async remove(paths) {
            removals.push([bucket, ...paths]);
            for (const path of paths) objects.get(bucket).delete(path);
            return { error: null };
          },
        };
      },
    },
  };
  return { client, objects, removals };
}

test("storage cleanup requires a local workspace and exact confirmation before applying", () => {
  assert.throws(() => parseStorageCleanupArguments([]), /exige o Supabase local/);
  assert.throws(() => parseStorageCleanupArguments(["--local"]), /UUID de workspace válido/);
  assert.throws(() => parseStorageCleanupArguments(["--local", "--tenant", "not-a-uuid"]), /UUID de workspace válido/);
  assert.throws(() => parseStorageCleanupArguments(["--local", "--tenant", tenantId, "--older-than-hours", "23"]), /entre 24 e 8760/);
  assert.throws(() => parseStorageCleanupArguments(["--local", "--tenant", tenantId, "--apply"]), /repita o UUID exato/);
  assert.throws(() => parseStorageCleanupArguments(["--local", "--tenant", tenantId, "--confirm-tenant", tenantId]), /junto com --apply/);
  assert.deepEqual(parseStorageCleanupArguments(["--local", "--tenant", tenantId.toUpperCase()]), {
    mode: "--local", tenantId, olderThanHours: 168, apply: false, includePaths: false,
  });
  assert.equal(parseStorageCleanupArguments([
    "--local", "--tenant", tenantId, "--older-than-hours", "72", "--apply", "--confirm-tenant", tenantId,
  ]).apply, true);
});

test("dry run reports only old, unreferenced, well-formed objects and never removes them", async () => {
  const photo = {
    id: photoId, tenant_id: tenantId, gallery_id: galleryId,
    object_path: `${tenantId}/${galleryId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png`,
  };
  const session = {
    object_path: `${tenantId}/${galleryId}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png`, state: "reserved",
  };
  const { client, removals } = createClient({
    photos: [photo],
    uploadSessions: [session],
    tenants: [{ id: tenantId, brand_logo_path: tenantId + "/77777777-7777-4777-8777-777777777777.webp" }],
  });
  const summary = await cleanupStorageOrphans(client, tenantId, { includePaths: true, now });

  assert.equal(summary.action, "dry_run");
  assert.equal(summary.buckets["gallery-originals"].objects_examined, 7);
  assert.equal(summary.buckets["gallery-originals"].candidates, 1);
  assert.equal(summary.buckets["gallery-originals"].skipped_recent_or_unknown_timestamp, 3);
  assert.equal(summary.buckets["gallery-originals"].skipped_unsafe_path, 1);
  assert.equal(summary.buckets["gallery-previews"].candidates, 1);
  assert.equal(summary.buckets["gallery-thumbnails"].candidates, 1);
  assert.equal(summary.buckets["gallery-brand-assets"].candidates, 1);
  assert.equal(summary.buckets["gallery-brand-assets"].skipped_recent_or_unknown_timestamp, 1);
  assert.equal(summary.buckets["gallery-brand-assets"].skipped_unsafe_path, 1);
  assert.equal(summary.details.length, 4);
  assert.equal(removals.length, 0);
});

test("apply rechecks database references and object age before removing scoped candidates", async () => {
  const existingPhoto = {
    id: photoId, tenant_id: tenantId, gallery_id: galleryId,
    object_path: `${tenantId}/${galleryId}/11111111-1111-4111-8111-111111111111.jpg`,
  };
  const newlyReferenced = {
    id: "44444444-4444-4444-8444-444444444444", tenant_id: tenantId, gallery_id: galleryId,
    object_path: `${tenantId}/${galleryId}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg`,
  };
  const { client, removals, objects } = createClient({
    tenants: [{ id: tenantId, brand_logo_path: tenantId + "/61616161-6161-4161-8161-616161616161.webp" }],
    photos: [existingPhoto],
    uploadSessions: [
      { object_path: `${tenantId}/${galleryId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png`, state: "reserved" },
      { object_path: `${tenantId}/${galleryId}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png`, state: "reserved" },
    ],
    onPhotoRead(readNumber, rows) { return readNumber > 1 ? [...rows, newlyReferenced] : rows; },
  });
  const summary = await cleanupStorageOrphans(client, tenantId, { apply: true, now });

  assert.equal(summary.action, "applied");
  assert.equal(summary.skipped_referenced_on_recheck, 1);
  assert.equal(summary.removed["gallery-originals"], 0);
  assert.equal(summary.removed["gallery-previews"], 1);
  assert.equal(summary.removed["gallery-thumbnails"], 1);
  assert.equal(summary.removed["gallery-brand-assets"], 0);
  assert.equal(objects.get("gallery-originals").has(newlyReferenced.object_path), true);
  assert(removals.every(batch => batch[0] !== "gallery-originals"));
});

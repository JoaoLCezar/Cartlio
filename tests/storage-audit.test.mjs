import assert from "node:assert/strict";
import test from "node:test";
import { auditStorage, compareStorageInventory, compareStorageUsage, listStorageObjectPaths, listStorageObjects, parseStorageAuditArguments } from "../scripts/lib/storage-audit.mjs";

test("storage audit requires the local target and validates a workspace scope", () => {
  assert.throws(() => parseStorageAuditArguments([]), /exige o Supabase local/);
  assert.throws(() => parseStorageAuditArguments(["--remote"]), /Uso:/);
  assert.throws(() => parseStorageAuditArguments(["--local", "--tenant", "not-a-uuid"]), /Workspace inválido/);
  assert.deepEqual(parseStorageAuditArguments(["--local", "--tenant", "123e4567-e89b-12d3-a456-426614174000"]), {
    mode: "--local", tenantId: "123e4567-e89b-12d3-a456-426614174000", includePaths: false, includeUsage: false, includeR2: false,
    snapshotPath: null, comparePath: null,
  });
  assert.equal(parseStorageAuditArguments(["--local", "--details"]).includePaths, true);
  assert.equal(parseStorageAuditArguments(["--local", "--usage"]).includeUsage, true);
  assert.equal(parseStorageAuditArguments(["--local", "--r2"]).includeR2, true);
  assert.equal(parseStorageAuditArguments(["--local", "--tenant", "123E4567-E89B-12D3-A456-426614174000"]).tenantId,
    "123e4567-e89b-12d3-a456-426614174000");
  assert.deepEqual(parseStorageAuditArguments(["--local", "--usage", "--snapshot", "current.json", "--compare", "baseline.json"]), {
    mode: "--local", tenantId: null, includePaths: false, includeUsage: true, includeR2: false,
    snapshotPath: "current.json", comparePath: "baseline.json",
  });
  assert.throws(() => parseStorageAuditArguments(["--local", "--compare", "baseline.json"]), /exigem --usage/);
  assert.throws(() => parseStorageAuditArguments(["--local", "--snapshot", "current.json"]), /exigem --usage/);
  assert.throws(() => parseStorageAuditArguments(["--local", "--usage", "--snapshot", "same.json", "--compare", "same.json"]), /arquivos diferentes/);
});

test("usage snapshots compare byte growth only for matching scopes and complete sizes", () => {
  const tenantId = "123e4567-e89b-12d3-a456-426614174000";
  const makeSnapshot = ({ generatedAt, originals, previews, thumbnails, brandAssets = 0, r2 = 0, r2Included = false, r2Photos = 0, r2Sessions = 0, committed, complete = true, scope = "all_workspaces" }) => {
    const physicalTotal = originals + previews + thumbnails + brandAssets + (r2Included ? r2 : 0);
    const bucket = bytes => ({ objects: 1, bytes, unknown_size_objects: complete ? 0 : 1, size_complete: complete });
    return {
      schema_version: 2,
      generated_at: generatedAt,
      mode: "--local",
      read_only: true,
      scope,
      tenant_id: scope === "workspace" ? tenantId : null,
      include_usage: true,
      buckets: {
        "gallery-originals": bucket(originals),
        "gallery-previews": bucket(previews),
        "gallery-thumbnails": bucket(thumbnails),
        "gallery-brand-assets": bucket(brandAssets),
      },
      provider_inventory: { r2: {
        photos: r2Photos,
        upload_sessions: r2Sessions,
        physical_objects_included: r2Included,
        objects: r2Included ? (r2 ? 1 : 0) : null,
        bytes: r2Included ? r2 : null,
        unknown_size_objects: r2Included ? 0 : null,
        size_complete: r2Included,
      } },
      usage: {
        total_physical_bytes: complete ? physicalTotal : null,
        unassigned_physical_bytes: 0,
        size_complete: complete,
        workspaces: [{
          tenant_id: tenantId,
          quota: { committed_bytes: committed },
          physical_storage: { total_bytes: complete ? physicalTotal : null, size_complete: complete },
        }],
      },
    };
  };
  const baseline = makeSnapshot({ generatedAt: "2026-10-27T10:00:00.000Z", originals: 100, previews: 30, thumbnails: 10, committed: 90 });
  const current = makeSnapshot({ generatedAt: "2026-10-28T10:00:00.000Z", originals: 120, previews: 60, thumbnails: 10, committed: 100 });
  current.usage.workspaces[0].tenant_id = tenantId;
  baseline.usage.workspaces[0].tenant_id = tenantId;

  const comparison = compareStorageUsage(current, baseline);
  assert.equal(comparison.elapsed_ms, 24 * 60 * 60 * 1000);
  assert.equal(comparison.size_complete, true);
  assert.deepEqual(comparison.total_physical_storage, { current_bytes: 190, baseline_bytes: 140, delta_bytes: 50 });
  assert.equal(comparison.buckets["gallery-originals"].delta_bytes, 20);
  assert.equal(comparison.buckets["gallery-previews"].delta_bytes, 30);
  assert.equal(comparison.workspaces[0].physical_storage.delta_bytes, 50);
  assert.equal(comparison.workspaces[0].quota_committed.delta_bytes, 10);

  const baselineWorkspace = { ...baseline, scope: "workspace", tenant_id: tenantId };
  baselineWorkspace.usage.workspaces = [{ ...baseline.usage.workspaces[0] }];
  const otherWorkspaceId = "223e4567-e89b-12d3-a456-426614174000";
  const differentWorkspace = {
    ...baselineWorkspace,
    generated_at: "2026-10-28T10:00:00.000Z",
    tenant_id: otherWorkspaceId,
    usage: { ...baselineWorkspace.usage, workspaces: [{ ...baselineWorkspace.usage.workspaces[0], tenant_id: otherWorkspaceId }] },
  };
  assert.throws(() => compareStorageUsage(differentWorkspace, baselineWorkspace), /mesmo escopo/);

  const incomplete = makeSnapshot({ generatedAt: "2026-10-28T10:00:00.000Z", originals: 120, previews: 60, thumbnails: 10, committed: 100, complete: false });
  const partialComparison = compareStorageUsage(incomplete, baseline);
  assert.equal(partialComparison.size_complete, false);
  assert.equal(partialComparison.total_physical_storage.delta_bytes, null);
  assert.equal(partialComparison.buckets["gallery-originals"].delta_bytes, null);
  assert.equal(partialComparison.workspaces[0].physical_storage.delta_bytes, null);
  assert.equal(partialComparison.workspaces[0].quota_committed.delta_bytes, 10);

  const baselineR2 = makeSnapshot({
    generatedAt: "2026-10-27T10:00:00.000Z", originals: 100, previews: 30, thumbnails: 10,
    r2: 70, r2Included: true, r2Photos: 1, committed: 90,
  });
  const currentR2 = makeSnapshot({
    generatedAt: "2026-10-28T10:00:00.000Z", originals: 100, previews: 30, thumbnails: 10,
    r2: 95, r2Included: true, r2Photos: 1, committed: 90,
  });
  const r2Comparison = compareStorageUsage(currentR2, baselineR2);
  assert.equal(r2Comparison.size_complete, true);
  assert.deepEqual(r2Comparison.buckets["r2-originals"], { current_bytes: 95, baseline_bytes: 70, delta_bytes: 25 });
  assert.equal(r2Comparison.total_physical_storage.delta_bytes, 25);
  assert.equal(compareStorageUsage(currentR2, baseline).size_complete, false);

  const missingR2Inventory = makeSnapshot({
    generatedAt: "2026-10-28T10:00:00.000Z", originals: 100, previews: 30, thumbnails: 10,
    r2Photos: 1, committed: 90, complete: false,
  });
  assert.equal(compareStorageUsage(missingR2Inventory, baselineR2).size_complete, false);

  assert.throws(() => compareStorageUsage({ ...current, scope: "workspace", tenant_id: tenantId }, baseline), /mesmo escopo/);
  assert.throws(() => compareStorageUsage({ ...current, generated_at: "2026-10-26T10:00:00.000Z" }, baseline), /anterior/);
  assert.throws(() => compareStorageUsage({ ...current, schema_version: 1 }, baseline), /snapshot de uso compatível/);
});

test("storage listing walks nested folders and every page without changing objects", async () => {
  const calls = [];
  const storage = {
    from(bucket) {
      assert.equal(bucket, "gallery-originals");
      return {
        async list(prefix, options) {
          calls.push([prefix, options.offset]);
          if (prefix === "" && options.offset === 0) {
            return { data: [
              { name: "tenant", metadata: null },
              { name: "root.jpg", metadata: { size: 1 } },
              ...Array.from({ length: 98 }, (_, index) => ({ name: `root-${index}.jpg`, metadata: { size: 1 } })),
            ], error: null };
          }
          if (prefix === "" && options.offset === 100) return { data: [], error: null };
          if (prefix === "tenant" && options.offset === 0) return { data: [{ name: "gallery", metadata: null }], error: null };
          if (prefix === "tenant/gallery" && options.offset === 0) return { data: [{ name: "photo.png", metadata: { size: 1 } }], error: null };
          return { data: [], error: null };
        },
      };
    },
  };
  const objects = await listStorageObjects(storage, "gallery-originals");
  assert.equal(objects.size, 100);
  assert(objects.has("tenant/gallery/photo.png"));
  assert(objects.has("root.jpg"));
  assert.equal(objects.get("root.jpg").size, 1);
  assert.equal(objects.get("tenant/gallery/photo.png").size, 1);
  assert.deepEqual(calls.slice(0, 2), [["", 0], ["", 100]]);
  assert.equal((await listStorageObjectPaths(storage, "gallery-originals")).size, 100);
});

test("usage report compares physical bucket bytes with registered quota without counting canceled reservations", () => {
  const tenantId = "123e4567-e89b-12d3-a456-426614174000";
  const photo = {
    id: "photo", tenant_id: tenantId, gallery_id: "gallery", object_path: `${tenantId}/gallery/photo.jpg`,
    byte_size: 100, processing_status: "ready", deletion_requested_at: null,
  };
  const derivativePath = `${tenantId}/gallery/photo.webp`;
  const result = compareStorageInventory({
    photos: [photo],
    uploadSessions: [
      { tenant_id: tenantId, object_path: `${tenantId}/gallery/reserved.jpg`, state: "reserved", reserved_bytes: 50 },
      { tenant_id: tenantId, object_path: `${tenantId}/gallery/canceled.jpg`, state: "canceled", reserved_bytes: 50 },
    ],
    tenants: [{ id: tenantId, storage_limit_bytes: 1000 }],
    objectsByBucket: {
      "gallery-originals": new Map([[photo.object_path, { size: 90 }]]),
      "gallery-previews": new Map([[derivativePath, { size: 30 }]]),
      "gallery-thumbnails": new Map([[derivativePath, { size: 10 }]]),
      "gallery-brand-assets": new Map(),
    },
  }, false, true);

  assert.equal(result.buckets["gallery-originals"].bytes, 90);
  assert.equal(result.buckets["gallery-previews"].bytes, 30);
  assert.equal(result.buckets["gallery-thumbnails"].bytes, 10);
  assert.equal(result.buckets["gallery-brand-assets"].bytes, 0);
  assert.equal(result.usage.total_physical_bytes, 130);
  assert.equal(result.usage.size_complete, true);
  assert.equal(result.findings.total, 0);
  assert.equal(result.usage.workspaces.length, 1);
  assert.deepEqual(result.usage.workspaces[0].quota, {
    limit_bytes: 1000,
    registered_original_bytes: 100,
    reserved_bytes: 50,
    committed_bytes: 150,
    available_bytes: 850,
    utilization_percent: 15,
  });
  assert.equal(result.usage.workspaces[0].physical_storage.derived_bytes, 40);
  assert.equal(result.usage.workspaces[0].physical_storage.total_bytes, 130);

  const unknown = compareStorageInventory({
    photos: [], uploadSessions: [], tenants: [{ id: tenantId, storage_limit_bytes: 1000 }],
    objectsByBucket: {
      "gallery-originals": new Map(),
      "gallery-previews": new Map([[`${tenantId}/gallery/unknown.webp`, { size: null }]]),
      "gallery-thumbnails": new Map(),
      "gallery-brand-assets": new Map(),
    },
  }, false, true);
  assert.equal(unknown.usage.size_complete, false);
  assert.equal(unknown.usage.workspaces[0].physical_storage.unknown_size_objects, 1);

  const unassigned = compareStorageInventory({
    photos: [], uploadSessions: [], tenants: [{ id: tenantId, storage_limit_bytes: 1000 }],
    objectsByBucket: {
      "gallery-originals": new Map([["orphan.jpg", { size: 7 }]]),
      "gallery-previews": new Map(),
      "gallery-thumbnails": new Map(),
      "gallery-brand-assets": new Map(),
    },
  }, false, true);
  assert.equal(unassigned.usage.total_physical_bytes, 7);
  assert.equal(unassigned.usage.unassigned_physical_bytes, 7);
  assert.equal(unassigned.usage.unassigned_unknown_size_objects, 0);
});

test("inventory comparison ignores active deletions and recognizes upload reservations", () => {
  const ready = {
    id: "photo-ready", tenant_id: "tenant", gallery_id: "gallery", object_path: "tenant/gallery/ready.jpg",
    processing_status: "ready", deletion_requested_at: null,
  };
  const pending = {
    id: "photo-pending", tenant_id: "tenant", gallery_id: "gallery", object_path: "tenant/gallery/pending.png",
    processing_status: "pending", deletion_requested_at: null,
  };
  const deleting = {
    id: "photo-deleting", tenant_id: "tenant", gallery_id: "gallery", object_path: "tenant/gallery/deleting.jpg",
    processing_status: "ready", deletion_requested_at: "2026-10-24T00:00:00Z",
  };
  const derivative = "tenant/gallery/photo-ready.webp";
  const inventory = compareStorageInventory({
    photos: [ready, pending, deleting],
    uploadSessions: [{ object_path: "tenant/gallery/reserved.jpg", state: "reserved" }],
    objectsByBucket: {
      "gallery-originals": new Set([ready.object_path, deleting.object_path, "tenant/gallery/reserved.jpg", "orphan.jpg"]),
      "gallery-previews": new Set([derivative, "orphan.webp"]),
      "gallery-thumbnails": new Set(["orphan-thumb.webp"]),
    },
  });
  assert.deepEqual(inventory.findings, {
    orphaned_originals: 1,
    orphaned_previews: 1,
    orphaned_thumbnails: 1,
    orphaned_brand_assets: 0,
    photos_missing_originals: 1,
    ready_photos_missing_previews: 0,
    ready_photos_missing_thumbnails: 1,
    workspaces_missing_brand_assets: 0,
    orphaned_r2_originals: 0,
    r2_photos_missing_originals: 0,
    r2_original_identity_mismatches: 0,
    r2_upload_session_identity_mismatches: 0,
    total: 5,
  });
  assert.equal(inventory.database.photos_examined, 3);
  const detailed = compareStorageInventory({
    photos: [ready], uploadSessions: [], objectsByBucket: {
      "gallery-originals": new Set([ready.object_path]),
      "gallery-previews": new Set(), "gallery-thumbnails": new Set(),
    },
  }, true);
  assert(detailed.details.some(item => item.finding === "ready_photos_missing_previews" && item.object_path === derivative));
});

test("audit does not treat R2 originals as Supabase objects and marks the inventory incomplete", () => {
  const r2Photo = {
    id: "photo-r2", tenant_id: "tenant", gallery_id: "gallery", object_path: "tenant/gallery/photo.png",
    storage_provider: "r2", byte_size: 100, processing_status: "ready", deletion_requested_at: null,
  };
  const result = compareStorageInventory({
    photos: [r2Photo],
    uploadSessions: [{ tenant_id: "tenant", object_path: r2Photo.object_path, storage_provider: "r2", state: "completed" }],
    objectsByBucket: {
      "gallery-originals": new Set(),
      "gallery-previews": new Set(),
      "gallery-thumbnails": new Set(),
      "gallery-brand-assets": new Set(),
    },
  }, false, true);

  assert.equal(result.findings.photos_missing_originals, 0);
  assert.equal(result.audit_complete, false);
  assert.equal(result.provider_inventory.r2.photos, 1);
  assert.equal(result.provider_inventory.r2.upload_sessions, 1);
  assert.equal(result.provider_inventory.r2.physical_objects_included, false);
  assert.equal(result.usage.total_physical_bytes, null);
  assert.equal(result.usage.size_complete, false);
});

test("audit compares an included R2 inventory and accounts for its bytes", () => {
  const tenantId = "123e4567-e89b-12d3-a456-426614174000";
  const photo = {
    id: "223e4567-e89b-12d3-a456-426614174000",
    tenant_id: tenantId,
    gallery_id: "323e4567-e89b-12d3-a456-426614174000",
    object_path: `${tenantId}/323e4567-e89b-12d3-a456-426614174000/223e4567-e89b-12d3-a456-426614174000.jpg`,
    storage_provider: "r2",
    byte_size: 90,
    storage_etag: '"photo-etag"',
    processing_status: "ready",
    deletion_requested_at: null,
  };
  const result = compareStorageInventory({
    photos: [photo],
    uploadSessions: [{ tenant_id: tenantId, object_path: photo.object_path, storage_provider: "r2", state: "completed" }],
    tenants: [{ id: tenantId, storage_limit_bytes: 1000 }],
    objectsByBucket: {
      "gallery-originals": new Map(),
      "gallery-previews": new Map(),
      "gallery-thumbnails": new Map(),
      "gallery-brand-assets": new Map(),
    },
    r2Objects: new Map([
      [photo.object_path, { size: 90, etag: '"photo-etag"' }],
      [`${tenantId}/323e4567-e89b-12d3-a456-426614174000/orphan.jpg`, { size: 7, etag: '"orphan-etag"' }],
    ]),
  }, true, true);

  assert.equal(result.audit_complete, true);
  assert.equal(result.provider_inventory.r2.physical_objects_included, true);
  assert.equal(result.provider_inventory.r2.objects, 2);
  assert.equal(result.provider_inventory.r2.bytes, 97);
  assert.equal(result.findings.orphaned_r2_originals, 1);
  assert.equal(result.findings.r2_photos_missing_originals, 0);
  assert.equal(result.findings.r2_original_identity_mismatches, 0);
  assert.equal(result.usage.total_physical_bytes, 97);
  assert.equal(result.usage.unassigned_physical_bytes, 0);
  assert.equal(result.usage.workspaces[0].physical_storage.total_bytes, 97);
  assert.equal(result.usage.workspaces[0].physical_storage.buckets["r2-originals"].bytes, 97);
  assert(result.details.some(item => item.finding === "orphaned_r2_originals" && item.object_path.endsWith("/orphan.jpg")));
});

test("storage audit loads R2 only when explicitly requested", async () => {
  const tenantId = "123e4567-e89b-12d3-a456-426614174000";
  const photo = {
    id: "223e4567-e89b-12d3-a456-426614174000",
    tenant_id: tenantId,
    gallery_id: "323e4567-e89b-12d3-a456-426614174000",
    object_path: `${tenantId}/323e4567-e89b-12d3-a456-426614174000/223e4567-e89b-12d3-a456-426614174000.jpg`,
    storage_provider: "r2",
    byte_size: 100,
    processing_status: "ready",
  };
  const rows = { photos: [photo], upload_sessions: [], tenants: [{ id: tenantId, storage_limit_bytes: 1000 }] };
  let r2Reads = 0;
  const client = {
    from(table) {
      return {
        select() { return this; },
        order() { return this; },
        range() { return Promise.resolve({ data: rows[table], error: null }); },
      };
    },
    storage: { from() { return { async list() { return { data: [], error: null }; } }; } },
  };
  const r2Inventory = async () => {
    r2Reads += 1;
    return new Map([[photo.object_path, { size: 100, etag: '"photo-etag"' }]]);
  };

  const withoutR2 = await auditStorage(client, null, { r2Inventory });
  assert.equal(withoutR2.audit_complete, false);
  assert.equal(r2Reads, 0);

  const withR2 = await auditStorage(client, null, { includeR2: true, r2Inventory });
  assert.equal(withR2.audit_complete, true);
  assert.equal(withR2.provider_inventory.r2.physical_objects_included, true);
  assert.equal(r2Reads, 1);
});

test("audit reports R2 originals whose listed size or ETag differs from the photo record", () => {
  const tenantId = "123e4567-e89b-12d3-a456-426614174000";
  const photo = {
    id: "223e4567-e89b-12d3-a456-426614174000",
    tenant_id: tenantId,
    gallery_id: "323e4567-e89b-12d3-a456-426614174000",
    object_path: `${tenantId}/323e4567-e89b-12d3-a456-426614174000/223e4567-e89b-12d3-a456-426614174000.jpg`,
    storage_provider: "r2",
    byte_size: 100,
    storage_etag: '"expected-etag"',
    processing_status: "ready",
  };
  const result = compareStorageInventory({
    photos: [photo],
    uploadSessions: [],
    tenants: [],
    objectsByBucket: {
      "gallery-originals": new Map(),
      "gallery-previews": new Map(),
      "gallery-thumbnails": new Map(),
      "gallery-brand-assets": new Map(),
    },
    r2Objects: new Map([[photo.object_path, { size: 99, etag: '"different-etag"' }]]),
  }, true);

  assert.equal(result.findings.r2_original_identity_mismatches, 1);
  assert.equal(result.findings.r2_photos_missing_originals, 0);
  assert(result.details.some(item => item.finding === "r2_original_identity_mismatches"
    && item.mismatch_fields.includes("size") && item.mismatch_fields.includes("etag")));
});

test("audit reports listed R2 upload objects whose size differs from the reservation", () => {
  const tenantId = "123e4567-e89b-12d3-a456-426614174000";
  const galleryId = "323e4567-e89b-12d3-a456-426614174000";
  const uploadId = "223e4567-e89b-12d3-a456-426614174000";
  const objectPath = `${tenantId}/${galleryId}/${uploadId}.png`;
  const result = compareStorageInventory({
    photos: [],
    uploadSessions: [{
      id: uploadId,
      tenant_id: tenantId,
      object_path: objectPath,
      storage_provider: "r2",
      state: "reserved",
      byte_size: 100,
    }],
    tenants: [],
    objectsByBucket: {
      "gallery-originals": new Map(),
      "gallery-previews": new Map(),
      "gallery-thumbnails": new Map(),
      "gallery-brand-assets": new Map(),
    },
    r2Objects: new Map([[objectPath, { size: 99, etag: '"uploaded-etag"' }]]),
  }, true);

  assert.equal(result.findings.r2_upload_session_identity_mismatches, 1);
  assert.equal(result.findings.total, 1);
  assert(result.details.some(item => item.finding === "r2_upload_session_identity_mismatches"
    && item.object_path === objectPath && item.mismatch_fields.includes("size")));
});

test("storage audit tracks workspace logo references and missing logo files", () => {
  const existingTenant = {
    id: "11111111-1111-4111-8111-111111111111",
    brand_logo_path: "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.webp",
  };
  const missingTenant = {
    id: "22222222-2222-4222-8222-222222222222",
    brand_logo_path: "22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444.webp",
  };
  const result = compareStorageInventory({
    photos: [],
    uploadSessions: [],
    tenants: [existingTenant, missingTenant],
    objectsByBucket: {
      "gallery-originals": new Set(),
      "gallery-previews": new Set(),
      "gallery-thumbnails": new Set(),
      "gallery-brand-assets": new Set([existingTenant.brand_logo_path, "11111111-1111-4111-8111-111111111111/55555555-5555-4555-8555-555555555555.webp"]),
    },
  }, true);

  assert.equal(result.findings.orphaned_brand_assets, 1);
  assert.equal(result.findings.workspaces_missing_brand_assets, 1);
  assert.equal(result.findings.total, 2);
  assert(result.details.some(item => item.finding === "workspaces_missing_brand_assets" && item.tenant_id === missingTenant.id));
});

import { createR2StorageInventory } from "./r2-storage-inventory.mjs";

export const storageAuditBuckets = ["gallery-originals", "gallery-previews", "gallery-thumbnails", "gallery-brand-assets"];
const pageSize = 100;
const databasePageSize = 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseStorageAuditArguments(argv) {
  let tenantId = null;
  let mode = null;
  let includePaths = false;
  let includeUsage = false;
  let includeR2 = false;
  let snapshotPath = null;
  let comparePath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--local" && mode === null) mode = argument;
    else if (argument === "--tenant" && !tenantId && argv[index + 1]) tenantId = argv[++index];
    else if (argument === "--details" && !includePaths) includePaths = true;
    else if (argument === "--usage" && !includeUsage) includeUsage = true;
    else if (argument === "--r2" && !includeR2) includeR2 = true;
    else if (argument === "--snapshot" && !snapshotPath && argv[index + 1]) snapshotPath = argv[++index];
    else if (argument === "--compare" && !comparePath && argv[index + 1]) comparePath = argv[++index];
    else throw new Error("Uso: npm run storage:audit -- --local [--tenant UUID] [--details] [--usage] [--r2] [--snapshot FILE] [--compare FILE]");
  }
  if (mode !== "--local") throw new Error("A auditoria exige o Supabase local: informe --local.");
  if (tenantId && !uuidPattern.test(tenantId)) throw new Error("Workspace inválido.");
  if ((comparePath || snapshotPath) && !includeUsage) throw new Error("Snapshots e comparações exigem --usage.");
  if (snapshotPath && comparePath && snapshotPath === comparePath) throw new Error("Snapshot e referência devem usar arquivos diferentes.");
  return { mode, tenantId: tenantId?.toLowerCase() ?? null, includePaths, includeUsage, includeR2, snapshotPath, comparePath };
}

export function compareStorageUsage(current, baseline) {
  validateUsageSnapshot(current, "relatório atual");
  validateUsageSnapshot(baseline, "snapshot de referência");
  if (current.mode !== baseline.mode || current.scope !== baseline.scope ||
      (current.tenant_id ?? "").toLowerCase() !== (baseline.tenant_id ?? "").toLowerCase()) {
    throw new Error("O snapshot de referência precisa ter o mesmo escopo da auditoria atual.");
  }

  const currentTime = Date.parse(current.generated_at);
  const baselineTime = Date.parse(baseline.generated_at);
  if (currentTime < baselineTime) throw new Error("A auditoria atual não pode ser anterior ao snapshot de referência.");

  const r2Current = current.provider_inventory?.r2;
  const r2Baseline = baseline.provider_inventory?.r2;
  const r2InventoryRequired = r2Current?.physical_objects_included === true || r2Baseline?.physical_objects_included === true ||
    (r2Current?.photos ?? 0) > 0 || (r2Current?.upload_sessions ?? 0) > 0 ||
    (r2Baseline?.photos ?? 0) > 0 || (r2Baseline?.upload_sessions ?? 0) > 0;
  const r2InventoryComparable = !r2InventoryRequired ||
    r2Current?.physical_objects_included === true && r2Baseline?.physical_objects_included === true;
  const sizesComplete = current.usage.size_complete && baseline.usage.size_complete && r2InventoryComparable &&
    storageAuditBuckets.every(bucket => current.buckets[bucket].size_complete && baseline.buckets[bucket].size_complete) &&
    [...current.usage.workspaces, ...baseline.usage.workspaces].every(workspace => workspace.physical_storage.size_complete);
  const compareBytes = (currentBytes, baselineBytes) => ({
    current_bytes: currentBytes,
    baseline_bytes: baselineBytes,
    delta_bytes: sizesComplete && Number.isSafeInteger(currentBytes) && Number.isSafeInteger(baselineBytes)
      ? currentBytes - baselineBytes
      : null,
  });
  const buckets = Object.fromEntries([...storageAuditBuckets, "r2-originals"].map(bucket => [bucket, compareBytes(
    bucket === "r2-originals" ? r2Current?.bytes ?? null : current.buckets[bucket].bytes,
    bucket === "r2-originals" ? r2Baseline?.bytes ?? null : baseline.buckets[bucket].bytes,
  )]));
  const baselineWorkspaces = new Map(baseline.usage.workspaces.map(workspace => [workspace.tenant_id.toLowerCase(), workspace]));
  const workspaces = current.usage.workspaces.map(workspace => {
    const previous = baselineWorkspaces.get(workspace.tenant_id.toLowerCase());
    const baselinePhysicalBytes = previous ? previous.physical_storage.total_bytes : 0;
    const baselineCommittedBytes = previous ? previous.quota.committed_bytes : 0;
    return {
      tenant_id: workspace.tenant_id,
      baseline_workspace_exists: Boolean(previous),
      physical_storage: compareBytes(workspace.physical_storage.total_bytes, baselinePhysicalBytes),
      quota_committed: {
        current_bytes: workspace.quota.committed_bytes,
        baseline_bytes: baselineCommittedBytes,
        delta_bytes: Number.isSafeInteger(workspace.quota.committed_bytes) && Number.isSafeInteger(baselineCommittedBytes)
          ? workspace.quota.committed_bytes - baselineCommittedBytes
          : null,
      },
    };
  });

  return {
    baseline_generated_at: baseline.generated_at,
    elapsed_ms: currentTime - baselineTime,
    size_complete: sizesComplete,
    total_physical_storage: compareBytes(current.usage.total_physical_bytes, baseline.usage.total_physical_bytes),
    unassigned_physical_storage: compareBytes(current.usage.unassigned_physical_bytes, baseline.usage.unassigned_physical_bytes),
    buckets,
    workspaces,
  };
}

function validateUsageSnapshot(snapshot, label) {
  const validTimestamp = typeof snapshot?.generated_at === "string" && Number.isFinite(Date.parse(snapshot.generated_at));
  const validScope = snapshot?.scope === "all_workspaces"
    ? snapshot.tenant_id == null
    : snapshot?.scope === "workspace" && typeof snapshot.tenant_id === "string" && uuidPattern.test(snapshot.tenant_id);
  const validBuckets = storageAuditBuckets.every(bucket => {
    const summary = snapshot?.buckets?.[bucket];
    return (Number.isSafeInteger(summary?.bytes) && summary.bytes >= 0 || summary?.bytes === null) &&
      typeof summary?.size_complete === "boolean";
  });
  const validWorkspaces = Array.isArray(snapshot?.usage?.workspaces) && snapshot.usage.workspaces.every(workspace =>
    typeof workspace?.tenant_id === "string" && uuidPattern.test(workspace.tenant_id) &&
    (Number.isSafeInteger(workspace?.quota?.committed_bytes) && workspace.quota.committed_bytes >= 0 || workspace?.quota?.committed_bytes === null) &&
    (Number.isSafeInteger(workspace?.physical_storage?.total_bytes) && workspace.physical_storage.total_bytes >= 0 || workspace?.physical_storage?.total_bytes === null) &&
    typeof workspace?.physical_storage?.size_complete === "boolean");
  const validTenantScope = snapshot?.scope !== "workspace" ||
    validWorkspaces && snapshot.usage.workspaces.length === 1 &&
      snapshot.usage.workspaces[0].tenant_id.toLowerCase() === snapshot.tenant_id.toLowerCase();
  if (snapshot?.schema_version !== 2 || snapshot?.read_only !== true || snapshot?.include_usage !== true || !validTimestamp || !validBuckets ||
      snapshot?.mode !== "--local" || !validScope || !validTenantScope ||
      typeof snapshot?.usage?.size_complete !== "boolean" ||
      !(Number.isSafeInteger(snapshot?.usage?.total_physical_bytes) && snapshot.usage.total_physical_bytes >= 0 || snapshot?.usage?.total_physical_bytes === null) ||
      !(Number.isSafeInteger(snapshot?.usage?.unassigned_physical_bytes) && snapshot.usage.unassigned_physical_bytes >= 0 || snapshot?.usage?.unassigned_physical_bytes === null) ||
      !validWorkspaces) {
    throw new Error(`O ${label} não é um snapshot de uso compatível.`);
  }
}

export async function listStorageObjects(storage, bucket) {
  const bucketStorage = storage.from(bucket);
  const objects = new Map();
  const pendingFolders = [""];
  while (pendingFolders.length) {
    const prefix = pendingFolders.pop();
    for (let offset = 0; ; offset += pageSize) {
      const { data: items, error } = await bucketStorage.list(prefix, {
        limit: pageSize,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`Falha ao listar o bucket ${bucket}.`);
      if (!items?.length) break;
      for (const item of items) {
        if (!item.name || item.name === "." || item.name === ".." || item.name.includes("/") || item.name.includes("\\")) {
          throw new Error(`O bucket ${bucket} contém um caminho inválido.`);
        }
        const objectPath = prefix ? `${prefix}/${item.name}` : item.name;
        if (!item.metadata) pendingFolders.push(objectPath);
        else objects.set(objectPath, {
          createdAt: item.created_at ?? null,
          updatedAt: item.updated_at ?? null,
          size: Number.isSafeInteger(item.metadata.size) && item.metadata.size >= 0 ? item.metadata.size : null,
        });
      }
      if (items.length < pageSize) break;
    }
  }
  return objects;
}

export async function listStorageObjectPaths(storage, bucket) {
  return new Set((await listStorageObjects(storage, bucket)).keys());
}

async function listRows(client, table, columns, tenantId, tenantColumn = "tenant_id") {
  const rows = [];
  for (let offset = 0; ; offset += databasePageSize) {
    let query = client.from(table).select(columns);
    if (tenantId) query = query.eq(tenantColumn, tenantId);
    query = query.order("id").range(offset, offset + databasePageSize - 1);
    const { data, error } = await query;
    if (error) throw new Error(`Falha ao consultar ${table} para auditoria.`);
    rows.push(...(data ?? []));
    if (!data || data.length < databasePageSize) break;
  }
  return rows;
}

export function compareStorageInventory({ photos, uploadSessions, objectsByBucket, tenants = [], r2Objects = null }, includePaths = false, includeUsage = false) {
  const providerOf = row => row.storage_provider ?? "supabase";
  const r2InventoryIncluded = r2Objects instanceof Map;
  const unsupportedProviders = new Set([
    ...photos.map(providerOf),
    ...uploadSessions.map(providerOf),
  ].filter(provider => provider !== "supabase" && !(provider === "r2" && r2InventoryIncluded)));
  const providerCounts = provider => ({
    photos: photos.filter(photo => providerOf(photo) === provider).length,
    upload_sessions: uploadSessions.filter(session => providerOf(session) === provider).length,
  });
  const supabasePhotos = photos.filter(photo => providerOf(photo) === "supabase");
  const r2Photos = photos.filter(photo => providerOf(photo) === "r2");
  const supabaseSessions = uploadSessions.filter(session => providerOf(session) === "supabase");
  const r2Sessions = uploadSessions.filter(session => providerOf(session) === "r2");
  const originalReferences = new Set([
    ...supabasePhotos.map(photo => photo.object_path),
    ...supabaseSessions.filter(session => session.state !== "canceled").map(session => session.object_path),
  ]);
  const brandAssetReferences = new Set(tenants.map(tenant => tenant.brand_logo_path).filter(Boolean));
  const derivativeReferences = new Set(photos.map(photo => `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`));
  const originals = objectsByBucket["gallery-originals"];
  const previews = objectsByBucket["gallery-previews"];
  const thumbnails = objectsByBucket["gallery-thumbnails"];
  const brandAssets = objectsByBucket["gallery-brand-assets"] ?? new Set();
  const activePhotos = supabasePhotos.filter(photo => !photo.deletion_requested_at);
  const activeR2Photos = r2Photos.filter(photo => !photo.deletion_requested_at);
  const readyPhotos = activePhotos.filter(photo => photo.processing_status === "ready");
  const details = [];
  let detailsTruncated = false;
  const addDetail = detail => {
    if (!includePaths) return;
    if (details.length < 100) details.push(detail);
    else detailsTruncated = true;
  };

  const findings = {
    orphaned_originals: countUnreferenced(originals, originalReferences, "gallery-originals", addDetail),
    orphaned_previews: countUnreferenced(previews, derivativeReferences, "gallery-previews", addDetail),
    orphaned_thumbnails: countUnreferenced(thumbnails, derivativeReferences, "gallery-thumbnails", addDetail),
    orphaned_brand_assets: countUnreferenced(brandAssets, brandAssetReferences, "gallery-brand-assets", addDetail),
    photos_missing_originals: countMissingPhotos(activePhotos, originals, "photos_missing_originals", addDetail, photo => photo.object_path),
    ready_photos_missing_previews: countMissingPhotos(readyPhotos, previews, "ready_photos_missing_previews", addDetail,
      photo => `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`, "gallery-previews"),
    ready_photos_missing_thumbnails: countMissingPhotos(readyPhotos, thumbnails, "ready_photos_missing_thumbnails", addDetail,
      photo => `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`, "gallery-thumbnails"),
    orphaned_r2_originals: r2InventoryIncluded
      ? countUnreferenced(r2Objects, new Set([
        ...r2Photos.map(photo => photo.object_path),
        ...r2Sessions.filter(session => session.state !== "canceled").map(session => session.object_path),
      ]), "r2-originals", addDetail, "orphaned_r2_originals")
      : 0,
    r2_photos_missing_originals: r2InventoryIncluded
      ? countMissingPhotos(activeR2Photos, r2Objects, "r2_photos_missing_originals", addDetail, photo => photo.object_path, "r2-originals")
      : 0,
    r2_original_identity_mismatches: r2InventoryIncluded
      ? countR2OriginalIdentityMismatches(r2Photos, r2Objects, addDetail)
      : 0,
  };
  findings.r2_upload_session_identity_mismatches = r2InventoryIncluded
    ? countR2UploadSessionIdentityMismatches(r2Sessions, r2Objects, addDetail)
    : 0;
  findings.workspaces_missing_brand_assets = countMissingBrandAssets(tenants, brandAssets, addDetail);
  findings.total = Object.values(findings).reduce((sum, count) => sum + count, 0);

  const result = {
    database: { photos_examined: photos.length, upload_sessions_examined: uploadSessions.length, workspaces_examined: tenants.length },
    provider_inventory: {
      supabase: providerCounts("supabase"),
      r2: {
        ...providerCounts("r2"),
        physical_objects_included: r2InventoryIncluded,
        ...(r2InventoryIncluded ? summarizeBucket(r2Objects) : { objects: null, bytes: null, unknown_size_objects: null, size_complete: false }),
      },
      unsupported: [...unsupportedProviders].filter(provider => provider !== "r2").map(provider => ({
        provider,
        ...providerCounts(provider),
      })),
    },
    audit_complete: unsupportedProviders.size === 0,
    buckets: {
      "gallery-originals": summarizeBucket(originals),
      "gallery-previews": summarizeBucket(previews),
      "gallery-thumbnails": summarizeBucket(thumbnails),
      "gallery-brand-assets": summarizeBucket(brandAssets),
    },
    findings,
  };
  if (includeUsage) result.usage = summarizeWorkspaceUsage({
    photos, uploadSessions, tenants,
    objectsByBucket: { ...objectsByBucket, "gallery-brand-assets": brandAssets },
    r2Objects,
  });
  if (includeUsage && !result.audit_complete) {
    result.usage.total_physical_bytes = null;
    result.usage.size_complete = false;
    for (const workspace of result.usage.workspaces) {
      workspace.physical_storage.total_bytes = null;
      workspace.physical_storage.size_complete = false;
    }
  }
  if (includePaths) {
    result.details = details;
    result.details_truncated = detailsTruncated;
  }
  return result;
}

function summarizeBucket(objects) {
  let bytes = 0;
  let unknownSizeObjects = 0;
  if (objects instanceof Map) {
    for (const object of objects.values()) {
      if (Number.isSafeInteger(object?.size) && object.size >= 0) bytes = addBytes(bytes, object.size);
      else unknownSizeObjects += 1;
    }
  } else {
    unknownSizeObjects = objects.size;
  }
  return { objects: objects.size, bytes, unknown_size_objects: unknownSizeObjects, size_complete: unknownSizeObjects === 0 && bytes !== null };
}

function safeBytes(value) {
  const bytes = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function addBytes(current, next) {
  return current === null || next === null || !Number.isSafeInteger(current + next) ? null : current + next;
}

function summarizeWorkspaceUsage({ photos, uploadSessions, tenants, objectsByBucket, r2Objects = null }) {
  const usageBuckets = [...storageAuditBuckets, "r2-originals"];
  const workspaceRows = new Map(tenants.map(tenant => [tenant.id.toLowerCase(), {
    tenant_id: tenant.id,
    quota_limit_bytes: safeBytes(tenant.storage_limit_bytes),
    registered_original_bytes: 0,
    reserved_bytes: 0,
    photo_count: 0,
    active_upload_count: 0,
    physical_buckets: Object.fromEntries(usageBuckets.map(bucket => [bucket, { objects: 0, bytes: 0, unknown_size_objects: 0 }])),
  }]));

  for (const photo of photos) {
    const workspace = workspaceRows.get(photo.tenant_id.toLowerCase());
    if (!workspace) continue;
    workspace.photo_count += 1;
    workspace.registered_original_bytes = addBytes(workspace.registered_original_bytes, safeBytes(photo.byte_size));
  }
  for (const session of uploadSessions) {
    if (!["reserved", "canceling"].includes(session.state)) continue;
    const workspace = workspaceRows.get(session.tenant_id.toLowerCase());
    if (!workspace) continue;
    workspace.active_upload_count += 1;
    workspace.reserved_bytes = addBytes(workspace.reserved_bytes, safeBytes(session.reserved_bytes));
  }

  let unassignedPhysicalBytes = 0;
  let unassignedUnknownSizeObjects = 0;
  for (const bucket of storageAuditBuckets) {
    const objects = objectsByBucket[bucket];
    const entries = objects instanceof Map ? objects.entries() : [...objects].map(path => [path, null]);
    for (const [path, object] of entries) {
      const tenantId = path.split("/")[0].toLowerCase();
      const workspace = workspaceRows.get(tenantId);
      const size = Number.isSafeInteger(object?.size) && object.size >= 0 ? object.size : null;
      if (!workspace) {
        if (size === null) unassignedUnknownSizeObjects += 1;
        else unassignedPhysicalBytes = addBytes(unassignedPhysicalBytes, size);
        continue;
      }
      const physical = workspace.physical_buckets[bucket];
      physical.objects += 1;
      if (size === null) physical.unknown_size_objects += 1;
      else physical.bytes = addBytes(physical.bytes, size);
    }
  }

  if (r2Objects instanceof Map) {
    for (const [path, object] of r2Objects) {
      const tenantId = path.split("/")[0].toLowerCase();
      const workspace = workspaceRows.get(tenantId);
      const size = Number.isSafeInteger(object?.size) && object.size >= 0 ? object.size : null;
      if (!workspace) {
        if (size === null) unassignedUnknownSizeObjects += 1;
        else unassignedPhysicalBytes = addBytes(unassignedPhysicalBytes, size);
        continue;
      }
      const physical = workspace.physical_buckets["r2-originals"];
      physical.objects += 1;
      if (size === null) physical.unknown_size_objects += 1;
      else physical.bytes = addBytes(physical.bytes, size);
    }
  }

  const workspaces = [...workspaceRows.values()].map(workspace => {
    const physicalValues = Object.values(workspace.physical_buckets);
    const physicalStorageBytes = physicalValues.reduce((total, bucket) => addBytes(total, bucket.bytes), 0);
    const unknownSizeObjects = physicalValues.reduce((total, bucket) => total + bucket.unknown_size_objects, 0);
    const derivedBytes = addBytes(workspace.physical_buckets["gallery-previews"].bytes, workspace.physical_buckets["gallery-thumbnails"].bytes);
    const quotaCommittedBytes = addBytes(workspace.registered_original_bytes, workspace.reserved_bytes);
    return {
      tenant_id: workspace.tenant_id,
      photo_count: workspace.photo_count,
      active_upload_count: workspace.active_upload_count,
      quota: {
        limit_bytes: workspace.quota_limit_bytes,
        registered_original_bytes: workspace.registered_original_bytes,
        reserved_bytes: workspace.reserved_bytes,
        committed_bytes: quotaCommittedBytes,
        available_bytes: workspace.quota_limit_bytes === null || quotaCommittedBytes === null
          ? null
          : Math.max(0, workspace.quota_limit_bytes - quotaCommittedBytes),
        utilization_percent: workspace.quota_limit_bytes === null || workspace.quota_limit_bytes === 0 || quotaCommittedBytes === null
          ? null
          : Math.round((quotaCommittedBytes / workspace.quota_limit_bytes) * 10000) / 100,
      },
      physical_storage: {
        buckets: workspace.physical_buckets,
        total_bytes: physicalStorageBytes,
        derived_bytes: derivedBytes,
        unknown_size_objects: unknownSizeObjects,
        size_complete: unknownSizeObjects === 0 && physicalStorageBytes !== null,
      },
    };
  }).sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));

  const totalPhysicalBytes = workspaces.reduce((total, workspace) => addBytes(total, workspace.physical_storage.total_bytes), unassignedPhysicalBytes);
  const unknownSizeObjects = workspaces.reduce((total, workspace) => total + workspace.physical_storage.unknown_size_objects, unassignedUnknownSizeObjects);
  return {
    total_physical_bytes: totalPhysicalBytes,
    unassigned_physical_bytes: unassignedPhysicalBytes,
    unassigned_unknown_size_objects: unassignedUnknownSizeObjects,
    unknown_size_objects: unknownSizeObjects,
    size_complete: unknownSizeObjects === 0 && totalPhysicalBytes !== null,
    workspaces,
  };
}

function countUnreferenced(paths, references, bucket, addDetail, findingOverride = null) {
  let count = 0;
  const objectPaths = paths instanceof Map ? paths.keys() : paths;
  for (const path of objectPaths) {
    if (references.has(path)) continue;
    count += 1;
    const finding = findingOverride ?? (bucket === "gallery-brand-assets" ? "orphaned_brand_assets" : `orphaned_${bucket.replace("gallery-", "")}`);
    addDetail({ finding, bucket, object_path: path });
  }
  return count;
}

function countMissingPhotos(photos, objects, finding, addDetail, getPath, bucket = "gallery-originals") {
  let count = 0;
  for (const photo of photos) {
    const path = getPath(photo);
    if (objects.has(path)) continue;
    count += 1;
    addDetail({ finding, bucket, photo_id: photo.id, object_path: path });
  }
  return count;
}

function countR2OriginalIdentityMismatches(photos, objects, addDetail) {
  let count = 0;
  for (const photo of photos) {
    const object = objects.get(photo.object_path);
    if (!object) continue;
    const mismatchFields = [];
    if (!Number.isSafeInteger(object.size) || object.size !== photo.byte_size) mismatchFields.push("size");
    if (typeof photo.storage_etag !== "string" || object.etag !== photo.storage_etag) mismatchFields.push("etag");
    if (!mismatchFields.length) continue;
    count += 1;
    addDetail({
      finding: "r2_original_identity_mismatches",
      bucket: "r2-originals",
      photo_id: photo.id,
      object_path: photo.object_path,
      mismatch_fields: mismatchFields,
    });
  }
  return count;
}

function countR2UploadSessionIdentityMismatches(sessions, objects, addDetail) {
  let count = 0;
  for (const session of sessions) {
    const object = objects.get(session.object_path);
    if (!object) continue;
    const expectedBytes = safeBytes(session.byte_size);
    if (expectedBytes !== null && object.size === expectedBytes) continue;
    count += 1;
    addDetail({
      finding: "r2_upload_session_identity_mismatches",
      bucket: "r2-originals",
      upload_session_id: session.id,
      object_path: session.object_path,
      mismatch_fields: ["size"],
    });
  }
  return count;
}

function countMissingBrandAssets(tenants, objects, addDetail) {
  let count = 0;
  for (const tenant of tenants) {
    if (!tenant.brand_logo_path || objects.has(tenant.brand_logo_path)) continue;
    count += 1;
    addDetail({
      finding: "workspaces_missing_brand_assets",
      bucket: "gallery-brand-assets",
      tenant_id: tenant.id,
      object_path: tenant.brand_logo_path,
    });
  }
  return count;
}

export async function listStorageReferenceRows(client, tenantId = null) {
  const [photos, uploadSessions, tenants] = await Promise.all([
    listRows(client, "photos", "id,tenant_id,gallery_id,object_path,byte_size,storage_provider,storage_etag,processing_status,deletion_requested_at", tenantId),
    listRows(client, "upload_sessions", "id,tenant_id,object_path,state,byte_size,reserved_bytes,storage_provider", tenantId),
    listRows(client, "tenants", "id,brand_logo_path,storage_limit_bytes", tenantId, "id"),
  ]);
  return { photos, uploadSessions, tenants };
}

export async function auditStorage(client, tenantId = null, { includePaths = false, includeUsage = false, includeR2 = false, r2Inventory = null } = {}) {
  const [references, bucketObjects, r2Objects] = await Promise.all([
    listStorageReferenceRows(client, tenantId),
    Promise.all(storageAuditBuckets.map(bucket => listStorageObjects(client.storage, bucket))),
    includeR2 ? (r2Inventory ?? createR2StorageInventory())() : Promise.resolve(null),
  ]);
  const objectsByBucket = Object.fromEntries(storageAuditBuckets.map((bucket, index) => [bucket, bucketObjects[index]]));
  if (tenantId) {
    for (const bucket of storageAuditBuckets) {
      objectsByBucket[bucket] = new Map([...objectsByBucket[bucket]].filter(([path]) => path.startsWith(`${tenantId}/`)));
    }
  }
  const scopedR2Objects = tenantId && r2Objects instanceof Map
    ? new Map([...r2Objects].filter(([path]) => path.startsWith(`${tenantId}/`)))
    : r2Objects;
  return compareStorageInventory({ ...references, objectsByBucket, r2Objects: scopedR2Objects }, includePaths, includeUsage);
}

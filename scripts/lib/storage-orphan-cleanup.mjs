import { listStorageObjects, listStorageReferenceRows, storageAuditBuckets } from "./storage-audit.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const detailLimit = 100;
const removeBatchSize = 100;

export function parseStorageCleanupArguments(argv) {
  let mode = null;
  let tenantId = null;
  let confirmTenantId = null;
  let olderThanHours = 168;
  let ageProvided = false;
  let apply = false;
  let includePaths = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--local" && mode === null) mode = argument;
    else if (argument === "--tenant" && tenantId === null && argv[index + 1]) tenantId = argv[++index];
    else if (argument === "--confirm-tenant" && confirmTenantId === null && argv[index + 1]) confirmTenantId = argv[++index];
    else if (argument === "--older-than-hours" && !ageProvided && argv[index + 1]) {
      const value = argv[++index];
      if (!/^\d+$/.test(value)) throw new Error("A idade mínima deve ser um número inteiro de horas.");
      olderThanHours = Number(value);
      ageProvided = true;
    } else if (argument === "--apply" && !apply) apply = true;
    else if (argument === "--details" && !includePaths) includePaths = true;
    else throw new Error("Uso: npm run storage:cleanup -- --local --tenant UUID [--older-than-hours 168] [--details] [--apply --confirm-tenant UUID]");
  }

  if (mode !== "--local") throw new Error("A limpeza de órfãos exige o Supabase local: informe --local.");
  if (!tenantId || !uuidPattern.test(tenantId)) throw new Error("Informe um UUID de workspace válido com --tenant.");
  if (olderThanHours < 24 || olderThanHours > 8760) throw new Error("A idade mínima deve ficar entre 24 e 8760 horas.");
  if (confirmTenantId !== null && !uuidPattern.test(confirmTenantId)) throw new Error("Confirmação de workspace inválida.");
  if (apply && confirmTenantId?.toLowerCase() !== tenantId.toLowerCase()) {
    throw new Error("Para remover objetos, repita o UUID exato em --confirm-tenant.");
  }
  if (!apply && confirmTenantId !== null) throw new Error("--confirm-tenant só pode ser usado junto com --apply.");

  return { mode, tenantId: tenantId.toLowerCase(), olderThanHours, apply, includePaths };
}

function referencedPaths({ photos, uploadSessions, tenants }) {
  return {
    "gallery-originals": new Set([
      ...photos.map(photo => photo.object_path),
      ...uploadSessions.filter(session => session.state !== "canceled").map(session => session.object_path),
    ]),
    "gallery-previews": new Set(photos.map(photo => `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`)),
    "gallery-thumbnails": new Set(photos.map(photo => `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`)),
    "gallery-brand-assets": new Set(tenants.map(tenant => tenant.brand_logo_path).filter(Boolean)),
  };
}

function isManagedObjectPath(bucket, tenantId, objectPath) {
  const segments = objectPath.split("/");
  if (bucket === "gallery-brand-assets") {
    return segments.length === 2 && segments[0] === tenantId
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i.test(segments[1]);
  }
  if (segments.length !== 3 || segments[0] !== tenantId || !uuidPattern.test(segments[1])) return false;
  if (bucket === "gallery-originals") return /^[0-9a-f-]{36}\.(jpg|png)$/i.test(segments[2])
    && uuidPattern.test(segments[2].slice(0, -4));
  return /^[0-9a-f-]{36}\.webp$/i.test(segments[2]) && uuidPattern.test(segments[2].slice(0, -5));
}

function isOlderThan(metadata, cutoff) {
  const createdAt = Date.parse(metadata?.createdAt ?? "");
  const updatedAt = Date.parse(metadata?.updatedAt ?? "");
  return Number.isFinite(createdAt) && createdAt <= cutoff
    && Number.isFinite(updatedAt) && updatedAt <= cutoff;
}

function scopedObjects(objects, tenantId) {
  return new Map([...objects].filter(([path]) => path.startsWith(`${tenantId}/`)));
}

function summarizeCandidates({ objectsByBucket, referencesByBucket, tenantId, cutoff }) {
  const candidatesByBucket = Object.fromEntries(storageAuditBuckets.map(bucket => [bucket, []]));
  const countsByBucket = Object.fromEntries(storageAuditBuckets.map(bucket => [bucket, {
    objects_examined: 0,
    candidates: 0,
    skipped_recent_or_unknown_timestamp: 0,
    skipped_unsafe_path: 0,
  }]));

  for (const bucket of storageAuditBuckets) {
    const objects = scopedObjects(objectsByBucket[bucket], tenantId);
    countsByBucket[bucket].objects_examined = objects.size;
    for (const [objectPath, metadata] of objects) {
      if (referencesByBucket[bucket].has(objectPath)) continue;
      if (!isManagedObjectPath(bucket, tenantId, objectPath)) {
        countsByBucket[bucket].skipped_unsafe_path += 1;
        continue;
      }
      if (!isOlderThan(metadata, cutoff)) {
        countsByBucket[bucket].skipped_recent_or_unknown_timestamp += 1;
        continue;
      }
      candidatesByBucket[bucket].push({
        object_path: objectPath,
        created_at: metadata.createdAt,
        updated_at: metadata.updatedAt,
      });
    }
    countsByBucket[bucket].candidates = candidatesByBucket[bucket].length;
  }
  return { candidatesByBucket, countsByBucket };
}

async function loadInventory(client, tenantId) {
  const [{ photos, uploadSessions, tenants }, ...objects] = await Promise.all([
    listStorageReferenceRows(client, tenantId),
    ...storageAuditBuckets.map(bucket => listStorageObjects(client.storage, bucket)),
  ]);
  return {
    photos,
    uploadSessions,
    tenants,
    objectsByBucket: Object.fromEntries(storageAuditBuckets.map((bucket, index) => [bucket, objects[index]])),
  };
}

export async function cleanupStorageOrphans(client, tenantId, {
  olderThanHours = 168,
  apply = false,
  includePaths = false,
  now = new Date(),
} = {}) {
  if (!uuidPattern.test(tenantId ?? "")) throw new Error("Tenant UUID is required for storage cleanup.");
  tenantId = tenantId.toLowerCase();
  if (!Number.isInteger(olderThanHours) || olderThanHours < 24 || olderThanHours > 8760) {
    throw new Error("Storage cleanup age must be between 24 and 8760 hours.");
  }
  const nowTimestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTimestamp)) throw new Error("Storage cleanup clock is invalid.");
  const cutoff = nowTimestamp - olderThanHours * 60 * 60 * 1000;
  const inventory = await loadInventory(client, tenantId);
  const { candidatesByBucket, countsByBucket } = summarizeCandidates({
    objectsByBucket: inventory.objectsByBucket,
    referencesByBucket: referencedPaths(inventory),
    tenantId,
    cutoff,
  });
  const details = [];
  let detailsTruncated = false;
  const addDetail = detail => {
    if (!includePaths) return;
    if (details.length < detailLimit) details.push(detail);
    else detailsTruncated = true;
  };
  for (const bucket of storageAuditBuckets) {
    for (const candidate of candidatesByBucket[bucket]) addDetail({ bucket, ...candidate });
  }

  const result = {
    action: apply ? "applied" : "dry_run",
    scope: "workspace",
    tenant_id: tenantId,
    minimum_age_hours: olderThanHours,
    database: { photos_examined: inventory.photos.length, upload_sessions_examined: inventory.uploadSessions.length },
    buckets: countsByBucket,
    removed: Object.fromEntries(storageAuditBuckets.map(bucket => [bucket, 0])),
    skipped_referenced_on_recheck: 0,
    skipped_changed_before_remove: 0,
  };

  if (apply) {
    const freshReferences = referencedPaths(await listStorageReferenceRows(client, tenantId));
    const freshObjects = Object.fromEntries(await Promise.all(storageAuditBuckets.map(async bucket =>
      [bucket, scopedObjects(await listStorageObjects(client.storage, bucket), tenantId)])));
    for (const bucket of storageAuditBuckets) {
      const safeToRemove = [];
      for (const candidate of candidatesByBucket[bucket]) {
        if (freshReferences[bucket].has(candidate.object_path)) {
          result.skipped_referenced_on_recheck += 1;
          continue;
        }
        const current = freshObjects[bucket].get(candidate.object_path);
        if (!current || current.createdAt !== candidate.created_at || current.updatedAt !== candidate.updated_at
          || !isOlderThan(current, cutoff)) {
          result.skipped_changed_before_remove += 1;
          continue;
        }
        safeToRemove.push(candidate.object_path);
      }
      for (let offset = 0; offset < safeToRemove.length; offset += removeBatchSize) {
        const batch = safeToRemove.slice(offset, offset + removeBatchSize);
        const { error } = await client.storage.from(bucket).remove(batch);
        if (error) throw new Error(`Storage removal stopped in ${bucket}; previously confirmed batches may already be removed.`);
        result.removed[bucket] += batch.length;
      }
    }
  }

  if (includePaths) {
    result.details = details;
    result.details_truncated = detailsTruncated;
  }
  return result;
}

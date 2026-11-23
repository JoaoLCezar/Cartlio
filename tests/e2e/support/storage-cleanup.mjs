const buckets = ["gallery-originals", "gallery-previews", "gallery-thumbnails", "gallery-brand-assets"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pageSize = 100;

export async function cleanupTenantStorage(client, tenantId) {
  if (!uuidPattern.test(tenantId)) throw new Error("Tenant UUID is required to clean E2E Storage.");
  const removedByBucket = {};
  for (const bucket of buckets) {
    const storage = client.storage.from(bucket);
    const objectPaths = await listTenantObjects(storage, tenantId);
    for (let offset = 0; offset < objectPaths.length; offset += pageSize) {
      const { error } = await storage.remove(objectPaths.slice(offset, offset + pageSize));
      if (error) throw new Error(`E2E Storage cleanup failed for ${bucket}.`);
    }
    if ((await listTenantObjects(storage, tenantId)).length) {
      throw new Error(`E2E Storage cleanup left objects in ${bucket}.`);
    }
    removedByBucket[bucket] = objectPaths.length;
  }
  return removedByBucket;
}

async function listTenantObjects(storage, tenantId) {
  const pendingFolders = [tenantId];
  const visitedFolders = new Set();
  const objectPaths = [];
  while (pendingFolders.length) {
    const prefix = pendingFolders.pop();
    if (visitedFolders.has(prefix)) continue;
    visitedFolders.add(prefix);
    for (let offset = 0; ; offset += pageSize) {
      const { data: items, error } = await storage.list(prefix, {
        limit: pageSize,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error("E2E Storage inventory failed.");
      if (!items?.length) break;
      for (const item of items) {
        if (!item.name || item.name === "." || item.name === ".." || item.name.includes("/") || item.name.includes("\\")) {
          throw new Error("E2E Storage contains an invalid path.");
        }
        const objectPath = `${prefix}/${item.name}`;
        if (!objectPath.startsWith(`${tenantId}/`)) throw new Error("E2E Storage path escaped its tenant.");
        if (item.metadata) objectPaths.push(objectPath);
        else pendingFolders.push(objectPath);
      }
      if (items.length < pageSize) break;
    }
  }
  return objectPaths;
}

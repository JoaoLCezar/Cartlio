import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createR2StorageClient } from "./r2-storage-client.mjs";

export async function listR2StorageObjects(client, bucket) {
  const objects = new Map();
  const seenTokens = new Set();
  let continuationToken;

  for (;;) {
    let response;
    try {
      response = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }), { abortSignal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error("R2_INVENTORY_UNAVAILABLE");
    }

    if (!response || (response.Contents != null && !Array.isArray(response.Contents))) {
      throw new Error("R2_INVENTORY_INVALID");
    }
    for (const item of response.Contents ?? []) {
      if (!item || typeof item.Key !== "string" || item.Key.length === 0 || objects.has(item.Key)) {
        throw new Error("R2_INVENTORY_INVALID");
      }
      objects.set(item.Key, {
        size: Number.isSafeInteger(item.Size) && item.Size >= 0 ? item.Size : null,
        etag: typeof item.ETag === "string" ? item.ETag : null,
      });
    }

    if (response.IsTruncated === true) {
      const nextToken = response.NextContinuationToken;
      if (typeof nextToken !== "string" || nextToken.length === 0 || seenTokens.has(nextToken)) {
        throw new Error("R2_INVENTORY_INVALID");
      }
      seenTokens.add(nextToken);
      continuationToken = nextToken;
    } else if (response.IsTruncated === false || response.IsTruncated == null) {
      break;
    } else {
      throw new Error("R2_INVENTORY_INVALID");
    }
  }

  return objects;
}

export function createR2StorageInventory(env = process.env, { requestHandler } = {}) {
  const { client, bucket } = createR2StorageClient(env, requestHandler);
  return () => listR2StorageObjects(client, bucket);
}

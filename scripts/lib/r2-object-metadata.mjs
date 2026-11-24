import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createR2StorageClient, r2OriginalIdentity } from "./r2-storage-client.mjs";

// Node only. The caller must load an authorized reservation from PostgreSQL.
// Never build a reservation or destination from the browser's metadata.
export function createR2ObjectMetadataReader(env = process.env, { requestHandler } = {}) {
  const { client, bucket } = createR2StorageClient(env, requestHandler);

  return async function readReservedR2Object(reservation) {
    const { path, bytes, type } = r2OriginalIdentity(reservation);
    let result;
    try {
      result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: path }), {
        abortSignal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404) return null;
      // Do not expose SDK messages, signed headers or bucket details.
      throw new Error("R2_METADATA_UNAVAILABLE");
    }

    if (result.ContentLength !== bytes || result.ContentType !== type) {
      throw new Error("UPLOAD_MISMATCH");
    }
    return {
      provider: "r2",
      path,
      byteSize: result.ContentLength,
      contentType: result.ContentType,
      etag: result.ETag ?? null,
    };
  };
}

import { S3Client } from "@aws-sdk/client-s3";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const extensions = new Map([["image/jpeg", "jpg"], ["image/png", "png"]]);
const maxOriginalBytes = 50 * 1024 * 1024;

export function r2OriginalIdentity(record) {
  if (record?.storage_provider !== "r2") throw new Error("UPLOAD_PROVIDER_UNSUPPORTED");
  const { id, tenant_id: tenantId, gallery_id: galleryId, object_path: path, byte_size: bytes, content_type: type } = record;
  const extension = extensions.get(type);
  if (![id, tenantId, galleryId].every(value => typeof value === "string" && uuid.test(value))
    || !extension || path !== `${tenantId}/${galleryId}/${id}.${extension}`
    || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxOriginalBytes) {
    throw new Error("UPLOAD_MISMATCH");
  }
  return { path, bytes, type };
}

export function isStrongR2Etag(value) {
  return typeof value === "string" && /^"[A-Za-z0-9_-]{1,128}"$/.test(value);
}

// Configure only from server environment values. Keep the endpoint on R2.
export function createR2StorageClient(env, requestHandler) {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET?.trim();
  if (!accountId || !/^[a-f0-9]{32}$/.test(accountId) || !accessKeyId || !secretAccessKey
    || !bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("R2_STORAGE_NOT_CONFIGURED");
  }
  const client = new S3Client({
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    maxAttempts: 1,
    ...(requestHandler ? { requestHandler } : {}),
  });
  return { client, bucket };
}

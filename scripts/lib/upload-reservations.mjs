import { createR2StorageClient } from "./r2-storage-client.mjs";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const maxPhotoBytes = 50 * 1024 * 1024;
const reservationErrors = new Set([
  "UPLOAD_INVALID", "UPLOAD_ID_CONFLICT", "UPLOAD_CLOSED", "UPLOAD_PROVIDER_UNSUPPORTED",
  "UPLOAD_NOT_FOUND", "STORAGE_QUOTA_EXCEEDED", "GALLERY_ARCHIVED",
]);

export function resolveOriginalStorageProvider(env = process.env) {
  const provider = (env.CARTLIO_ORIGINAL_STORAGE_PROVIDER ?? "supabase").trim().toLowerCase();
  if (provider === "supabase") return provider;
  if (provider !== "r2") throw new Error("ORIGINAL_STORAGE_PROVIDER_INVALID");
  if (!env.SUPABASE_SERVER_SECRET_KEY?.trim()) throw new Error("R2_UPLOAD_SERVER_NOT_CONFIGURED");
  createR2StorageClient(env);
  return provider;
}

function validateReservation(input) {
  if (!input || ![input.tenantId, input.galleryId, input.uploadId].every(value => typeof value === "string" && uuid.test(value))
    || typeof input.filename !== "string" || input.filename.trim().length < 1 || input.filename.trim().length > 255
    || !["image/jpeg", "image/png"].includes(input.contentType)
    || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > maxPhotoBytes) {
    throw new Error("UPLOAD_INVALID");
  }
}

export async function reservePhotoUpload(provider, input, { userClient, serviceClient } = {}) {
  validateReservation(input);
  const baseArgs = {
    p_tenant_id: input.tenantId,
    p_gallery_id: input.galleryId,
    p_upload_id: input.uploadId,
    p_filename: input.filename.trim(),
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
  };
  let client;
  let rpc;
  let args;
  if (provider === "supabase") {
    client = userClient;
    rpc = "reserve_photo_upload";
    args = baseArgs;
  } else if (provider === "r2" && typeof input.actorId === "string" && uuid.test(input.actorId)) {
    client = serviceClient;
    rpc = "reserve_r2_photo_upload";
    args = { p_actor_id: input.actorId, ...baseArgs };
  } else {
    throw new Error("UPLOAD_INVALID");
  }
  if (!client || typeof client.rpc !== "function") throw new Error("UPLOAD_RESERVATION_UNAVAILABLE");

  let result;
  try {
    result = await client.rpc(rpc, args);
  } catch {
    throw new Error("UPLOAD_RESERVATION_UNAVAILABLE");
  }
  if (result?.error) {
    const message = result.error.message;
    throw new Error(reservationErrors.has(message) ? message : "UPLOAD_RESERVATION_UNAVAILABLE");
  }
  const session = result?.data;
  if (!session || session.storage_provider !== provider) throw new Error("UPLOAD_RESERVATION_UNAVAILABLE");
  return session;
}

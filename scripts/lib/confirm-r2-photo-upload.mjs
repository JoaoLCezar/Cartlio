import { createR2ObjectMetadataReader } from "./r2-object-metadata.mjs";
import { isStrongR2Etag } from "./r2-storage-client.mjs";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const publicErrors = new Set([
  "UPLOAD_CONFIRMATION_DENIED", "UPLOAD_NOT_FOUND", "UPLOAD_PROVIDER_UNSUPPORTED",
  "UPLOAD_CLOSED", "UPLOAD_MISMATCH", "GALLERY_ARCHIVED",
]);
let configuredReader;

// Server only. userClient must use the request's session; serviceClient must be
// a separate client with the service role. The public upload flow still uses
// Supabase and does not expose this function.
export async function confirmR2PhotoUpload(
  { tenantId, galleryId, uploadId },
  { userClient, serviceClient, readObject },
) {
  if (![tenantId, galleryId, uploadId].every(id => typeof id === "string" && uuid.test(id))) {
    throw new Error("UPLOAD_NOT_FOUND");
  }
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth?.user) throw new Error("UPLOAD_CONFIRMATION_DENIED");

  const { data: reservation, error: reservationError } = await userClient.from("upload_sessions")
    .select("id, tenant_id, gallery_id, object_path, storage_provider, content_type, byte_size, state")
    .eq("id", uploadId).eq("tenant_id", tenantId).eq("gallery_id", galleryId).maybeSingle();
  if (reservationError) throw new Error("UPLOAD_CONFIRMATION_UNAVAILABLE");
  if (!reservation) throw new Error("UPLOAD_NOT_FOUND");
  if (reservation.storage_provider !== "r2") throw new Error("UPLOAD_PROVIDER_UNSUPPORTED");
  if (reservation.state !== "reserved" && reservation.state !== "completed") throw new Error("UPLOAD_CLOSED");

  const reader = readObject ?? (configuredReader ??= createR2ObjectMetadataReader());
  const object = await reader(reservation);
  if (!object) throw new Error("UPLOAD_MISSING");
  if (!isStrongR2Etag(object.etag)) throw new Error("UPLOAD_MISMATCH");

  const { data: photoId, error } = await serviceClient.rpc("complete_r2_photo_upload", {
    p_actor_id: auth.user.id,
    p_tenant_id: reservation.tenant_id,
    p_gallery_id: reservation.gallery_id,
    p_upload_id: reservation.id,
    p_object_path: object.path,
    p_object_bytes: object.byteSize,
    p_object_content_type: object.contentType,
    p_object_etag: object.etag,
  });
  if (error || photoId !== reservation.id) {
    throw new Error(publicErrors.has(error?.message) ? error.message : "UPLOAD_CONFIRMATION_UNAVAILABLE");
  }
  return photoId;
}

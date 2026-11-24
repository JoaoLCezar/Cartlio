import { createR2OriginalAccess } from "./r2-originals.mjs";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const publicErrors = new Set([
  "UPLOAD_CONFIRMATION_DENIED", "UPLOAD_NOT_FOUND", "UPLOAD_PROVIDER_UNSUPPORTED",
  "UPLOAD_CLOSED", "GALLERY_ARCHIVED",
]);
let originalAccess;

// The caller must pass the authenticated request client separately from the
// privileged client. Never give out a URL without recording authorization first.
export async function issueR2Upload({ tenantId, galleryId, uploadId }, { userClient, serviceClient, signUpload }) {
  if (![tenantId, galleryId, uploadId].every(value => typeof value === "string" && uuid.test(value))) {
    throw new Error("UPLOAD_NOT_FOUND");
  }
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth?.user) throw new Error("UPLOAD_CONFIRMATION_DENIED");

  const { data: reservation, error } = await serviceClient.rpc("prepare_r2_upload_put", {
    p_actor_id: auth.user.id,
    p_tenant_id: tenantId,
    p_gallery_id: galleryId,
    p_upload_id: uploadId,
  });
  if (error || !reservation) {
    throw new Error(publicErrors.has(error?.message) ? error.message : "UPLOAD_AUTHORIZATION_UNAVAILABLE");
  }
  const signer = signUpload ?? (originalAccess ??= createR2OriginalAccess()).signUpload;
  return signer(reservation);
}

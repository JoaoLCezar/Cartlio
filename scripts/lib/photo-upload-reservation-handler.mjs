import { reservePhotoUpload, resolveOriginalStorageProvider } from "./upload-reservations.mjs";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const maxRequestBytes = 8 * 1024;
const maxPhotoBytes = 50 * 1024 * 1024;
const conflictErrors = new Set(["STORAGE_QUOTA_EXCEEDED", "UPLOAD_CLOSED", "UPLOAD_ID_CONFLICT", "GALLERY_ARCHIVED"]);

function response(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function validPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && [value.tenantId, value.galleryId, value.uploadId].every(item => typeof item === "string" && uuid.test(item))
    && typeof value.filename === "string" && value.filename.trim().length > 0 && value.filename.trim().length <= 255
    && ["image/jpeg", "image/png"].includes(value.contentType)
    && Number.isSafeInteger(value.byteSize) && value.byteSize > 0 && value.byteSize <= maxPhotoBytes;
}

function errorStatus(code) {
  if (code === "UPLOAD_INVALID") return 400;
  if (code === "UPLOAD_CONFIRMATION_DENIED") return 403;
  if (conflictErrors.has(code)) return 409;
  return 503;
}

export async function handlePhotoUploadReservation(request, {
  userClient,
  env = process.env,
  isTrustedOrigin = false,
} = {}) {
  if (!isTrustedOrigin) return response(403, { error: "UPLOAD_REQUEST_DENIED" });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return response(415, { error: "UPLOAD_INVALID" });
  }
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxRequestBytes) {
    return response(413, { error: "UPLOAD_INVALID" });
  }

  let authResult;
  try {
    authResult = await userClient.auth.getUser();
  } catch {
    return response(503, { error: "UPLOAD_RESERVATION_UNAVAILABLE" });
  }
  const { data: auth, error: authError } = authResult;
  if (authError || !auth?.user?.id) return response(401, { error: "UPLOAD_AUTHENTICATION_REQUIRED" });

  let text;
  try {
    text = await request.text();
  } catch {
    return response(400, { error: "UPLOAD_INVALID" });
  }
  if (Buffer.byteLength(text, "utf8") > maxRequestBytes) return response(413, { error: "UPLOAD_INVALID" });

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return response(400, { error: "UPLOAD_INVALID" });
  }
  if (!validPayload(payload)) return response(400, { error: "UPLOAD_INVALID" });

  try {
    if ((env.CARTLIO_ORIGINAL_STORAGE_PROVIDER ?? "supabase").trim().toLowerCase() === "r2") {
      return response(503, { error: "UPLOAD_PROVIDER_UNSUPPORTED" });
    }
    const provider = resolveOriginalStorageProvider(env);
    // Do not create R2 reservations until signing, retry, cancellation and
    // reconciliation are all connected to this authenticated upload flow.
    if (provider !== "supabase") return response(503, { error: "UPLOAD_PROVIDER_UNSUPPORTED" });
    const session = await reservePhotoUpload(provider, payload, { userClient });
    return response(201, session);
  } catch (error) {
    const knownCodes = new Set([
      "UPLOAD_INVALID", "UPLOAD_CONFIRMATION_DENIED", "UPLOAD_ID_CONFLICT", "UPLOAD_CLOSED",
      "UPLOAD_PROVIDER_UNSUPPORTED", "UPLOAD_NOT_FOUND", "STORAGE_QUOTA_EXCEEDED", "GALLERY_ARCHIVED",
    ]);
    const code = knownCodes.has(error?.message) ? error.message : "UPLOAD_RESERVATION_UNAVAILABLE";
    return response(errorStatus(code), { error: code });
  }
}

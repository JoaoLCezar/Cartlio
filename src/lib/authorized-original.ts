import type { R2Original } from "../../scripts/lib/r2-originals.mjs";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const originalPath = new RegExp(`^${uuid}/${uuid}/${uuid}\\.(?:jpg|png)$`, "i");

export type AuthorizedOriginal =
  | { provider: "supabase"; path: string; filename: string; byteSize: number | null }
  | { provider: "r2"; filename: string; byteSize: number; original: R2Original };

export function parseAuthorizedOriginal(value: unknown): AuthorizedOriginal | null {
  if (!value || typeof value !== "object") return null;
  const file = value as Record<string, unknown>;
  if (typeof file.path !== "string" || !originalPath.test(file.path) || typeof file.filename !== "string") return null;
  const size = typeof file.byte_size === "number" && Number.isSafeInteger(file.byte_size)
    && file.byte_size > 0 && file.byte_size <= 50 * 1024 * 1024 ? file.byte_size : null;
  if ((file.storage_provider === "supabase" || file.storage_provider === undefined) && file.storage_etag == null) {
    return { provider: "supabase", path: file.path, filename: file.filename, byteSize: size };
  }
  if (file.storage_provider !== "r2" || size === null
    || typeof file.tenant_id !== "string" || typeof file.gallery_id !== "string" || typeof file.photo_id !== "string"
    || typeof file.storage_etag !== "string" || !/^"[A-Za-z0-9_-]{1,128}"$/.test(file.storage_etag)
    || (file.content_type !== "image/jpeg" && file.content_type !== "image/png")) return null;
  const extension = file.content_type === "image/png" ? "png" : "jpg";
  if (file.path !== `${file.tenant_id}/${file.gallery_id}/${file.photo_id}.${extension}`) return null;
  return {
    provider: "r2", filename: file.filename, byteSize: size,
    original: {
      id: file.photo_id, tenant_id: file.tenant_id, gallery_id: file.gallery_id,
      object_path: file.path, content_type: file.content_type, byte_size: size,
      storage_provider: "r2", storage_etag: file.storage_etag,
    },
  };
}

export function originalAttachmentHeader(filename: string, contentType: R2Original["content_type"]) {
  const fallback = contentType === "image/png" ? "foto.png" : "foto.jpg";
  const safe = filename.replaceAll("\\", "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "_").trim() || fallback;
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

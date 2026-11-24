export const mediaStorageProviders = Object.freeze({
  original: "recorded-per-photo",
  preview: "supabase",
  thumbnail: "supabase",
  studioLogo: "supabase",
} as const);

export type StorageProvider = "supabase" | "r2";

export function photoOriginalProvider(photo: unknown): StorageProvider | null {
  if (!photo || typeof photo !== "object") return null;
  const provider = (photo as Record<string, unknown>).storage_provider;
  if (provider === undefined || provider === "supabase") return "supabase";
  if (provider === "r2") return "r2";
  return null;
}

export function panelOriginalUrl(tenantId: string, galleryId: string, photoId: string) {
  return `/painel/${encodeURIComponent(tenantId)}/galerias/${encodeURIComponent(galleryId)}`
    + `/fotos/${encodeURIComponent(photoId)}/original`;
}

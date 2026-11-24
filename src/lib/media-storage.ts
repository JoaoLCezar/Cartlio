import "server-only";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { createR2OriginalAccess, R2Original } from "../../scripts/lib/r2-originals.mjs";
import { signPhotoPathsInBatches } from "./gallery-photo-data";

const buckets = {
  original: "gallery-originals",
  preview: "gallery-previews",
  thumbnail: "gallery-thumbnails",
  studioLogo: "gallery-brand-assets",
} as const;

type MediaKind = keyof typeof buckets;
type DisplayMediaKind = Exclude<MediaKind, "original">;
type StorageClient = Pick<SupabaseClient, "storage">;
let r2Access: ReturnType<typeof createR2OriginalAccess> | undefined;

export async function openR2Original(original: R2Original, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  if (!r2Access) {
    const { createR2OriginalAccess } = await import("../../scripts/lib/r2-originals.mjs");
    r2Access ??= createR2OriginalAccess();
  }
  const stream = await r2Access.openVerifiedOriginal(original, { signal });
  // Node and the DOM use the same Web Stream at runtime but declare different interfaces.
  return Readable.toWeb(stream, {
    strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
  }) as unknown as ReadableStream<Uint8Array>;
}

export async function mediaStorageReady({ storage }: StorageClient) {
  const results = await Promise.all(Object.values(buckets).map(bucket => storage.getBucket(bucket)));
  return results.every(result => !result.error);
}

// The caller authorizes the object first. Keep the supplied Supabase session
// so dashboard reads still use the member's storage policies.
export function createMediaReader({ storage }: StorageClient) {
  async function signOriginal(path: string, expiresIn: number, filename?: string) {
    const options = filename === undefined ? undefined : { download: filename };
    const { data, error } = await storage.from(buckets.original).createSignedUrl(path, expiresIn, options);
    return error ? null : data?.signedUrl ?? null;
  }

  return {
    async readImage(kind: DisplayMediaKind, path: string) {
      const { data, error } = await storage.from(buckets[kind]).download(path);
      return error ? null : data;
    },

    signPaths(kind: MediaKind, paths: readonly string[], expiresIn: number) {
      return signPhotoPathsInBatches(paths, batch => storage.from(buckets[kind]).createSignedUrls(batch, expiresIn));
    },

    signOriginal,

    async openOriginal(path: string, expiresIn: number) {
      const url = await signOriginal(path, expiresIn);
      if (!url) throw new Error("Não foi possível preparar o original autorizado.");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok || !response.body) throw new Error("O original autorizado não está disponível no armazenamento.");
      return response.body;
    },
  };
}

import type { Readable } from "node:stream";

export type R2Original = {
  id: string;
  tenant_id: string;
  gallery_id: string;
  storage_provider: "r2";
  object_path: string;
  content_type: "image/jpeg" | "image/png";
  byte_size: number;
  storage_etag: string;
};

export function createR2OriginalAccess(): {
  openVerifiedOriginal(photo: R2Original, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Readable>;
  readVerifiedOriginal(photo: R2Original): Promise<Buffer>;
};

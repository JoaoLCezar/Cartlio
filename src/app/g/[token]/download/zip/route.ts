import { galleryPinSession } from "@/lib/gallery-pin";
import { parseAuthorizedOriginal, type AuthorizedOriginal } from "@/lib/authorized-original";
import { createMediaReader, openR2Original } from "@/lib/media-storage";
import { shareStorageClient } from "@/lib/supabase/share";
import { createZipStream, type ZipEntry } from "@/lib/zip-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const maxBundleBytes = 500 * 1024 * 1024;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuidValue = new RegExp(`^${uuid}$`, "i");
const noStore = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function textResponse(message: string, status: number) {
  return new Response(message, { status, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
}

async function releaseIncompleteBatch(
  supabase: ReturnType<typeof shareStorageClient>,
  token: string,
  batchId: string,
  completedCount: number,
) {
  try {
    const released = await supabase.rpc("release_interrupted_gallery_download_bundle", {
      p_token: token,
      p_download_batch_id: batchId,
      p_completed_count: completedCount,
    });
    if (released.error) console.error("Unable to reconcile interrupted gallery ZIP download.", released.error.message);
  } catch {
    console.error("Unable to reconcile interrupted gallery ZIP download.");
  }
}

function isBundleFile(file: AuthorizedOriginal | null): file is AuthorizedOriginal & { byteSize: number } {
  return file !== null && file.byteSize !== null;
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    try { await reader.cancel(); } catch { /* Ignore cancellation after a completed or failed read. */ }
    reader.releaseLock();
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) return textResponse("Link inválido.", 404);

  let supabase: ReturnType<typeof shareStorageClient>;
  try { supabase = shareStorageClient(); } catch {
    return textResponse("O download não está configurado neste servidor.", 503);
  }
  const authorization = await supabase.rpc("authorize_gallery_download_bundle", {
    p_token: token,
    p_access_token: await galleryPinSession(token),
    p_max_bytes: maxBundleBytes,
  });
  if (authorization.error?.message.includes("DOWNLOAD_LIMIT_REACHED")) {
    return textResponse("Uma ou mais fotos atingiram o limite de downloads.", 429);
  }
  if (authorization.error?.message.includes("DOWNLOAD_BUNDLE_TOO_LARGE")) {
    return textResponse("O pacote excede 500 MiB. Baixe as fotos individualmente.", 413);
  }
  if (authorization.error?.message.includes("DOWNLOAD_BUNDLE_TOO_MANY_FILES")) {
    return textResponse("O pacote pode conter no máximo 500 fotos. Baixe as fotos individualmente.", 413);
  }
  if (authorization.error || !authorization.data || typeof authorization.data !== "object") {
    return textResponse("Este link não permite baixar um pacote.", 404);
  }

  const manifest = authorization.data as { files?: unknown; total_bytes?: unknown; count?: unknown; download_batch_id?: unknown };
  const batchId = typeof manifest.download_batch_id === "string" && uuidValue.test(manifest.download_batch_id)
    ? manifest.download_batch_id : null;
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 500
    || typeof manifest.count !== "number" || manifest.count !== manifest.files.length
    || typeof manifest.total_bytes !== "number" || manifest.total_bytes < 1 || manifest.total_bytes > maxBundleBytes
    || !batchId) {
    if (batchId) await releaseIncompleteBatch(supabase, token, batchId, 0);
    return textResponse("Não foi possível preparar este pacote.", 500);
  }

  const files = manifest.files.map(parseAuthorizedOriginal);
  if (!files.every(isBundleFile) || files.reduce((total, file) => total + file.byteSize, 0) !== manifest.total_bytes) {
    await releaseIncompleteBatch(supabase, token, batchId, 0);
    return textResponse("Não foi possível preparar este pacote.", 500);
  }

  const media = createMediaReader(supabase);
  const entries: AsyncIterable<ZipEntry> = (async function* () {
    for (const file of files) {
      yield {
        name: file.filename,
        size: file.byteSize,
        open: async function* () {
          const body = file.provider === "r2"
            ? await openR2Original(file.original, request.signal)
            : await media.openOriginal(file.path, 60);
          yield* responseChunks(body);
        },
      };
    }
  })();

  return new Response(createZipStream(entries, (completedCount) =>
    releaseIncompleteBatch(supabase, token, batchId, completedCount)), {
    headers: {
      ...noStore,
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=\"quadrics-galeria.zip\"",
    },
  });
}

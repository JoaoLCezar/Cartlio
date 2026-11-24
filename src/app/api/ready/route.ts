import { shareLookupClient, shareStorageClient } from "@/lib/supabase/share";
import { galleryClientIpConfigurationReady } from "@/lib/gallery-pin-client";
import { mediaStorageReady } from "@/lib/media-storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const timeoutFetch: typeof fetch = (input, init) => fetch(input, {
  ...init, signal: AbortSignal.timeout(3000),
});
const noStore = { "Cache-Control": "no-store" };

async function databaseReady() {
  try {
    const result = await shareLookupClient(timeoutFetch)
      .rpc("get_shared_gallery", { p_token: "0".repeat(64) })
      .abortSignal(AbortSignal.timeout(3000));
    return !result.error;
  } catch { return false; }
}

async function storageReady() {
  try {
    return await mediaStorageReady(shareStorageClient(timeoutFetch));
  } catch { return false; }
}

export async function GET() {
  const [database, storage] = await Promise.all([databaseReady(), storageReady()]);
  const clientIp = galleryClientIpConfigurationReady();
  const ready = database && storage && clientIp;
  return Response.json({
    status: ready ? "ready" : "not_ready",
    checks: {
      database: database ? "ok" : "unavailable",
      storage: storage ? "ok" : "unavailable",
      clientIp: clientIp ? "ok" : "misconfigured",
    },
  }, { status: ready ? 200 : 503, headers: noStore });
}

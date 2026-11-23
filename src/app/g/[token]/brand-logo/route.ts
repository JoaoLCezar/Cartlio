import { galleryPinSession } from "@/lib/gallery-pin";
import { galleryPinClientFingerprint } from "@/lib/gallery-pin-client";
import { createMediaReader } from "@/lib/media-storage";
import { shareStorageClient } from "@/lib/supabase/share";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) return new Response(null, { status: 404, headers: noStore });
  let storage: ReturnType<typeof shareStorageClient>;
  try { storage = shareStorageClient(); } catch {
    return new Response("O armazenamento de marca não está configurado neste servidor.", { status: 503, headers: noStore });
  }
  const clientFingerprint = galleryPinClientFingerprint(request);
  if (!clientFingerprint && process.env.NODE_ENV === "production") {
    return new Response("Não foi possível validar a origem da solicitação.", { status: 503, headers: noStore });
  }
  const resolved = await storage.rpc("authorize_shared_brand_logo", {
    p_token: token,
    p_access_token: await galleryPinSession(token),
    p_client_fingerprint: clientFingerprint,
  });
  if (resolved.error || !resolved.data || typeof resolved.data !== "object") {
    return new Response(null, { status: 404, headers: noStore });
  }
  if (resolved.data.rate_limited === true) {
    const retryAfter = typeof resolved.data.retry_after === "number"
      ? Math.max(1, Math.min(60, Math.ceil(resolved.data.retry_after)))
      : 60;
    return new Response("Muitas solicitações de imagem. Aguarde um minuto e tente novamente.", {
      status: 429,
      headers: { ...noStore, "Retry-After": String(retryAfter) },
    });
  }
  if (typeof resolved.data.path !== "string"
    || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}[.]webp$/.test(resolved.data.path)) {
    return new Response(null, { status: 404, headers: noStore });
  }
  const image = await createMediaReader(storage).readImage("studioLogo", resolved.data.path);
  if (!image) return new Response(null, { status: 404, headers: noStore });
  return new Response(await image.arrayBuffer(), { status: 200, headers: { ...noStore, "Content-Type": "image/webp" } });
}

import { shareStorageClient } from "@/lib/supabase/share";
import { galleryPinSession } from "@/lib/gallery-pin";
import { createMediaReader, openR2Original } from "@/lib/media-storage";
import { originalAttachmentHeader, parseAuthorizedOriginal } from "@/lib/authorized-original";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request, { params }: { params: Promise<{ token: string; photoId: string }> }) {
  const { token, photoId } = await params;
  if (!/^[0-9a-f]{64}$/.test(token) || !/^[0-9a-f-]{36}$/.test(photoId)) {
    return new Response(null, { status: 404, headers: noStore });
  }

  const supabase = shareStorageClient();
  const authorized = await supabase.rpc("authorize_gallery_download", {
    p_token: token, p_photo_id: photoId, p_access_token: await galleryPinSession(token),
  });
  if (authorized.error?.message.includes("DOWNLOAD_LIMIT_REACHED")) {
    return new Response("Limite de downloads atingido para esta foto.", { status: 429, headers: noStore });
  }
  const file = authorized.error ? null : parseAuthorizedOriginal(authorized.data);
  if (!file) return new Response(null, { status: 404, headers: noStore });
  if (file.provider === "r2") {
    let body;
    try {
      body = await openR2Original(file.original, request.signal);
    } catch {
      return new Response(null, { status: 404, headers: noStore });
    }
    return new Response(body, { headers: {
      ...noStore,
      "Content-Type": file.original.content_type,
      "Content-Length": String(file.byteSize),
      "Content-Disposition": originalAttachmentHeader(file.filename, file.original.content_type),
    } });
  }

  const url = await createMediaReader(supabase).signOriginal(file.path, 60, file.filename);
  if (!url) return new Response(null, { status: 404, headers: noStore });
  return new Response(null, { status: 302, headers: { ...noStore, Location: url } });
}

import { isUuid } from "@/lib/gallery-validation";
import { originalAttachmentHeader, parseAuthorizedOriginal } from "@/lib/authorized-original";
import { createMediaReader, openR2Original } from "@/lib/media-storage";
import { photoOriginalProvider } from "@/lib/media-storage-policy";
import { requireWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; galleryId: string; photoId: string }> },
) {
  const { id: tenantId, galleryId, photoId } = await params;
  if (![tenantId, galleryId, photoId].every(isUuid)) return new Response(null, { status: 404, headers: noStore });

  const { supabase } = await requireWorkspace(tenantId);
  const { data, error } = await supabase.from("photos")
    .select("id, tenant_id, gallery_id, object_path, original_filename, content_type, byte_size, storage_provider, storage_etag")
    .eq("tenant_id", tenantId).eq("gallery_id", galleryId).eq("id", photoId)
    .is("deletion_requested_at", null).maybeSingle();
  if (error) return new Response(null, { status: 500, headers: noStore });
  if (!data) return new Response(null, { status: 404, headers: noStore });
  const provider = photoOriginalProvider(data);
  if (!provider) return new Response(null, { status: 404, headers: noStore });

  const file = parseAuthorizedOriginal({
    tenant_id: data.tenant_id,
    gallery_id: data.gallery_id,
    photo_id: data.id,
    path: data.object_path,
    filename: data.original_filename,
    content_type: data.content_type,
    byte_size: data.byte_size,
    storage_provider: data.storage_provider,
    storage_etag: data.storage_etag,
  });
  if (!file || file.provider !== provider) return new Response(null, { status: 404, headers: noStore });

  if (file.provider === "r2") {
    try {
      const body = await openR2Original(file.original, request.signal);
      return new Response(body, { headers: {
        ...noStore,
        "Content-Type": file.original.content_type,
        "Content-Length": String(file.byteSize),
        "Content-Disposition": originalAttachmentHeader(file.filename, file.original.content_type),
      } });
    } catch {
      return new Response(null, { status: 404, headers: noStore });
    }
  }

  const url = await createMediaReader(supabase).signSupabaseOriginal(file.path, 60, file.filename);
  if (!url) return new Response(null, { status: 404, headers: noStore });
  return new Response(null, { status: 302, headers: { ...noStore, Location: url } });
}

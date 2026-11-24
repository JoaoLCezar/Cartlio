import { NextResponse } from "next/server";
import { isUuid } from "@/lib/gallery-validation";
import { createMediaReader } from "@/lib/media-storage";
import { panelOriginalUrl } from "@/lib/media-storage-policy";
import { readLimitedJson } from "@/lib/request-json";
import { requireWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const responseHeaders = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
const photoPageSize = 60;
const photoIdPageSize = 1000;
const maxPhotoOffset = 1_000_000;
const maxSelectedPhotoIds = 200;
const maxRequestBodyBytes = 16 * 1024;

function responseError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: responseHeaders });
}

async function authorizeGallery(tenantId: string, galleryId: string) {
  if (!isUuid(galleryId)) return { response: responseError("Galeria indisponível.", 404) };
  const { supabase } = await requireWorkspace(tenantId);
  const { data, error } = await supabase.from("galleries").select("id")
    .eq("tenant_id", tenantId).eq("id", galleryId).maybeSingle();
  if (error) return { response: responseError("Não foi possível carregar a galeria.", 500) };
  if (!data) return { response: responseError("Galeria indisponível.", 404) };
  return { supabase };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; galleryId: string }> }) {
  const { id: tenantId, galleryId } = await params;
  const authorized = await authorizeGallery(tenantId, galleryId);
  if ("response" in authorized) return authorized.response;

  const search = new URL(request.url).searchParams;
  const offset = Number(search.get("offset") ?? "0");
  const idsOnly = search.get("ids") === "1";
  const requestedIdPageSize = search.has("limit") ? Number(search.get("limit")) : photoIdPageSize;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maxPhotoOffset
    || (search.has("ids") && !idsOnly)
    || (search.has("limit") && (!idsOnly || !Number.isSafeInteger(requestedIdPageSize)
      || requestedIdPageSize < 1 || requestedIdPageSize > photoIdPageSize))) {
    return responseError("Consulta inválida.", 400);
  }

  if (idsOnly) {
    const query = authorized.supabase.from("photos")
      .select("id", offset === 0 ? { count: "exact" } : {})
      .eq("tenant_id", tenantId).eq("gallery_id", galleryId).is("deletion_requested_at", null)
      .order("sort_order", { ascending: true }).order("created_at", { ascending: false }).order("id", { ascending: true })
      .range(offset, offset + requestedIdPageSize - 1);
    const { data, count, error } = await query;
    if (error || !data) return responseError("Não foi possível carregar a lista de fotos.", 500);
    return NextResponse.json({ ids: data.map(photo => photo.id), totalCount: offset === 0 ? count ?? 0 : null }, { headers: responseHeaders });
  }

  const { data, count, error } = await authorized.supabase.from("photos")
    .select("id, object_path, storage_provider, original_filename, byte_size, deletion_requested_at, processing_status, sort_order, created_at", offset === 0 ? { count: "exact" } : {})
    .eq("tenant_id", tenantId).eq("gallery_id", galleryId).is("deletion_requested_at", null)
    .order("sort_order", { ascending: true }).order("created_at", { ascending: false }).order("id", { ascending: true })
    .range(offset, offset + photoPageSize - 1);
  if (error || !data) return responseError("Não foi possível carregar as fotos.", 500);

  const ready = data.filter(photo => photo.processing_status === "ready");
  const derivedPaths = ready.map(photo => `${tenantId}/${galleryId}/${photo.id}.webp`);
  const media = createMediaReader(authorized.supabase);
  const [thumbnailUrls, previewUrls] = await Promise.all([
    media.signPaths("thumbnail", derivedPaths, 900),
    media.signPaths("preview", derivedPaths, 900),
  ]);
  const photos = data.map((photo, index) => {
    if (photo.processing_status !== "ready") return { ...photo, position: offset + index, thumbnailUrl: null, previewUrl: null, originalUrl: null };
    const derivedPath = `${tenantId}/${galleryId}/${photo.id}.webp`;
    return {
      ...photo,
      position: offset + index,
      thumbnailUrl: thumbnailUrls.get(derivedPath) ?? null,
      previewUrl: previewUrls.get(derivedPath) ?? null,
      originalUrl: panelOriginalUrl(tenantId, galleryId, photo.id),
    };
  });
  return NextResponse.json({ photos, totalCount: offset === 0 ? count ?? 0 : null }, { headers: responseHeaders });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; galleryId: string }> }) {
  const { id: tenantId, galleryId } = await params;
  const authorized = await authorizeGallery(tenantId, galleryId);
  if ("response" in authorized) return authorized.response;

  const parsed = await readLimitedJson(request, maxRequestBodyBytes);
  if (!parsed.ok) return responseError(parsed.reason === "too-large" ? "Solicitação muito grande." : "Solicitação inválida.",
    parsed.reason === "too-large" ? 413 : 400);
  const body = parsed.value;
  if (!body || typeof body !== "object" || !Array.isArray((body as { ids?: unknown }).ids)) {
    return responseError("Solicitação inválida.", 400);
  }
  const ids = (body as { ids: unknown[] }).ids;
  if (ids.length < 1 || ids.length > maxSelectedPhotoIds || ids.some(id => typeof id !== "string" || !isUuid(id))
    || new Set(ids).size !== ids.length) {
    return responseError("A lista de fotos é inválida.", 400);
  }

  const { data, error } = await authorized.supabase.from("photos")
    .select("id, object_path, storage_provider, original_filename, deletion_requested_at")
    .eq("tenant_id", tenantId).eq("gallery_id", galleryId).is("deletion_requested_at", null).in("id", ids as string[]);
  if (error) return responseError("Não foi possível preparar a exclusão das fotos.", 500);
  if (!data || data.length !== ids.length) return responseError("A galeria mudou. Atualize a página e tente novamente.", 409);
  return NextResponse.json({ photos: data }, { headers: responseHeaders });
}

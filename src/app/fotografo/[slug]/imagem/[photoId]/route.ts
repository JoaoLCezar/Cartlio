import { isUuid } from "@/lib/gallery-validation";
import { createMediaReader } from "@/lib/media-storage";
import { isPortfolioSlug } from "@/lib/portfolio";
import { shareStorageClient } from "@/lib/supabase/share";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; photoId: string }> }) {
  const { slug, photoId } = await params;
  if (!isPortfolioSlug(slug) || !isUuid(photoId)) return new Response(null, { status: 404, headers });

  const supabase = shareStorageClient();
  const { data: path, error } = await supabase.rpc("resolve_public_portfolio_image", {
    p_slug: slug, p_photo_id: photoId,
  });
  if (error) return new Response(null, { status: 503, headers });
  if (typeof path !== "string") return new Response(null, { status: 404, headers });

  const image = await createMediaReader(supabase).readImage("preview", path);
  if (!image) return new Response(null, { status: 404, headers });
  return new Response(image.stream(), { headers: { ...headers, "Content-Type": "image/webp" } });
}

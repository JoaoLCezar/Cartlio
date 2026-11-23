import { requireWorkspace } from "@/lib/workspace";
import { createMediaReader } from "@/lib/media-storage";
import { workspaceAssetStorageClient } from "@/lib/supabase/workspace-assets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireWorkspace(id);
  const [membership, workspace] = await Promise.all([
    supabase.from("tenant_members").select("role").eq("tenant_id", id).eq("user_id", user.id).maybeSingle(),
    supabase.from("tenants").select("brand_logo_path").eq("id", id).maybeSingle(),
  ]);
  if (membership.error || workspace.error || !membership.data || !workspace.data?.brand_logo_path) {
    return new Response(null, { status: 404, headers: noStore });
  }
  if (!new RegExp("^" + id + "/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]webp$").test(workspace.data.brand_logo_path)) {
    return new Response(null, { status: 404, headers: noStore });
  }
  try {
    const storage = workspaceAssetStorageClient();
    const image = await createMediaReader(storage).readImage("studioLogo", workspace.data.brand_logo_path);
    if (!image) return new Response(null, { status: 404, headers: noStore });
    return new Response(await image.arrayBuffer(), { status: 200, headers: { ...noStore, "Content-Type": "image/webp" } });
  } catch {
    return new Response(null, { status: 503, headers: noStore });
  }
}

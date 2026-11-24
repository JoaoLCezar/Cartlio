import { NextResponse } from "next/server";
import { galleryPinSession } from "@/lib/gallery-pin";
import { shareLookupClient } from "@/lib/supabase/share";

export const dynamic = "force-dynamic";

const responseHeaders = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ error: "Link inválido." }, { status: 404, headers: responseHeaders });
  }

  const search = new URL(request.url).searchParams;
  const offset = Number(search.get("offset") ?? "0");
  const query = search.get("q") ?? "";
  const selected = search.get("selected") ?? "0";
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000 || query.length > 120
    || (selected !== "0" && selected !== "1")) {
    return NextResponse.json({ error: "Consulta inválida." }, { status: 400, headers: responseHeaders });
  }

  try {
    const accessToken = await galleryPinSession(token);
    const { data, error } = await shareLookupClient().rpc("get_shared_gallery_photo_page", {
      p_token: token,
      p_access_token: accessToken,
      p_offset: offset,
      p_limit: 60,
      p_search: query,
      p_selected_only: selected === "1",
    });
    if (error) {
      return NextResponse.json({ error: "Não foi possível carregar as fotos." }, { status: 500, headers: responseHeaders });
    }
    if (!data) return NextResponse.json({ error: "Galeria indisponível." }, { status: 404, headers: responseHeaders });
    if (data.pin_required === true) {
      return NextResponse.json({ error: "A autorização da galeria expirou. Atualize a página e informe o PIN." }, { status: 401, headers: responseHeaders });
    }
    if (!Array.isArray(data.photos) || typeof data.total_count !== "number") {
      return NextResponse.json({ error: "Não foi possível carregar as fotos." }, { status: 500, headers: responseHeaders });
    }
    return NextResponse.json({ photos: data.photos, totalCount: data.total_count }, { headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: "Não foi possível carregar as fotos." }, { status: 500, headers: responseHeaders });
  }
}

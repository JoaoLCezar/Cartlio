import { NextResponse } from "next/server";
import { galleryPinSession } from "@/lib/gallery-pin";
import { readLimitedJson } from "@/lib/request-json";
import { shareLookupClient } from "@/lib/supabase/share";

export const dynamic = "force-dynamic";
const maxRequestBodyBytes = 16 * 1024;

function selectionRateLimitResponse(error: { code: string; message: string; details: string | null }) {
  if (error.code !== "PT429" && !error.message.includes("SELECTION_RATE_LIMITED")) return null;
  const requestedDelay = Number.parseInt(error.details ?? "", 10);
  const retryAfter = Number.isInteger(requestedDelay) && requestedDelay > 0 && requestedDelay <= 60 ? requestedDelay : 60;
  return NextResponse.json({ error: "Muitas altera\u00e7\u00f5es em pouco tempo. Aguarde antes de tentar novamente.", retryAfter }, {
    status: 429, headers: { "Cache-Control": "private, no-store, max-age=0", "Retry-After": String(retryAfter) },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) return NextResponse.json({ error: "Link inválido." }, { status: 404 });
  const parsed = await readLimitedJson(request, maxRequestBodyBytes);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason === "too-large" ? "Solicitação muito grande." : "Solicitação inválida." }, {
    status: parsed.reason === "too-large" ? 413 : 400,
  });
  const body = parsed.value;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Solicitação inválida." }, { status: 400 });
  const input = body as Record<string, unknown>;
  const accessToken = await galleryPinSession(token);
  const supabase = shareLookupClient();

  if (input.action === "clear") {
    const result = await supabase.rpc("clear_gallery_selection", {
      p_token: token, p_access_token: accessToken,
    });
    if (result.error) {
      const rateLimited = selectionRateLimitResponse(result.error);
      if (rateLimited) return rateLimited;
      const message = result.error.message;
      const status = message.includes("SELECTION_SUBMITTED") || message.includes("SELECTION_MODE_DISABLED") ? 409 : 400;
      const error = message.includes("SELECTION_SUBMITTED") ? "Esta sele\u00e7\u00e3o j\u00e1 foi enviada e n\u00e3o aceita altera\u00e7\u00f5es."
        : message.includes("SELECTION_MODE_DISABLED") ? "Este link n\u00e3o aceita sele\u00e7\u00f5es."
          : "N\u00e3o foi poss\u00edvel limpar a sele\u00e7\u00e3o. Atualize a p\u00e1gina e tente novamente.";
      return NextResponse.json({ error }, { status });
    }
    if (typeof result.data !== "number" || result.data < 0) {
      return NextResponse.json({ error: "Acesso protegido. Atualize a galeria e informe o PIN novamente." }, { status: 401 });
    }
    return NextResponse.json({ removedCount: result.data });
  }

  if (input.action === "toggle" && typeof input.photoId === "string" && /^[0-9a-f-]{36}$/.test(input.photoId) && typeof input.selected === "boolean") {
    const result = await supabase.rpc("set_gallery_selection", {
      p_token: token, p_photo_id: input.photoId, p_selected: input.selected, p_access_token: accessToken,
    });
    if (result.error) {
      const rateLimited = selectionRateLimitResponse(result.error);
      if (rateLimited) return rateLimited;
      const message = result.error.message;
      const status = message.includes("SELECTION_LIMIT") ? 422 : message.includes("SELECTION_SUBMITTED") ? 409 : 400;
      return NextResponse.json({ error: message }, { status });
    }
    if (typeof result.data !== "number" || result.data < 0) return NextResponse.json({ error: "Acesso protegido. Atualize a galeria e informe o PIN novamente." }, { status: 401 });
    return NextResponse.json({ count: result.data });
  }

  if (input.action === "note" && typeof input.photoId === "string" && /^[0-9a-f-]{36}$/.test(input.photoId)
    && typeof input.note === "string") {
    if (Array.from(input.note.trim()).length > 500) {
      return NextResponse.json({ error: "A observação deve ter no máximo 500 caracteres." }, { status: 422 });
    }
    const result = await supabase.rpc("set_gallery_selection_photo_note", {
      p_token: token, p_photo_id: input.photoId, p_note: input.note, p_access_token: accessToken,
    });
    if (result.error) {
      const rateLimited = selectionRateLimitResponse(result.error);
      if (rateLimited) return rateLimited;
      const message = result.error.message;
      const status = message.includes("PHOTO_NOTE_DENIED") ? 401
        : message.includes("SELECTION_SUBMITTED") || message.includes("PHOTO_NOT_SELECTED") ? 409
          : message.includes("SELECTION_MODE_DISABLED") ? 409
            : message.includes("PHOTO_NOTE_INVALID") ? 422 : 400;
      const error = message.includes("PHOTO_NOTE_DENIED") ? "Acesso protegido. Atualize a galeria e informe o PIN novamente."
        : message.includes("SELECTION_SUBMITTED") ? "Esta seleção já foi enviada e não aceita alterações."
          : message.includes("PHOTO_NOT_SELECTED") ? "Selecione a foto antes de adicionar uma observação."
            : message.includes("SELECTION_MODE_DISABLED") ? "Este link não aceita observações de seleção."
              : message.includes("PHOTO_NOTE_INVALID") ? "A observação deve ter no máximo 500 caracteres."
                : "Não foi possível salvar a observação. Atualize a página e tente novamente.";
      return NextResponse.json({ error }, { status });
    }
    if (typeof result.data !== "string" && result.data !== null) {
      return NextResponse.json({ error: "Não foi possível salvar a observação." }, { status: 400 });
    }
    return NextResponse.json({ note: result.data });
  }

  if (input.action === "submit" && typeof input.clientName === "string") {
    const result = await supabase.rpc("submit_gallery_selection", {
      p_token: token, p_client_name: input.clientName, p_access_token: accessToken,
    });
    if (result.error) {
      const rateLimited = selectionRateLimitResponse(result.error);
      if (rateLimited) return rateLimited;
      return NextResponse.json({ error: result.error.message }, { status: 400 });
    }
    if (result.data === false) return NextResponse.json({ submitted: false });
    if (result.data !== true) return NextResponse.json({ error: "Não foi possível enviar a seleção." }, { status: 400 });
    return NextResponse.json({ submitted: true });
  }

  return NextResponse.json({ error: "Solicitação inválida." }, { status: 400 });
}

import { NextResponse } from "next/server";
import { galleryPinCookieName } from "@/lib/gallery-pin";
import { galleryPinClientFingerprint } from "@/lib/gallery-pin-client";
import { sharePinClient } from "@/lib/supabase/share";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) return NextResponse.json({ error: "Link inválido." }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Informe o PIN." }, { status: 400 }); }
  const pin = typeof body === "object" && body !== null && "pin" in body ? body.pin : null;
  if (typeof pin !== "string" || !/^[0-9]{6,12}$/.test(pin)) {
    return NextResponse.json({ error: "O PIN deve ter de 6 a 12 números." }, { status: 400 });
  }

  const clientFingerprint = galleryPinClientFingerprint(request);
  if (!clientFingerprint) {
    return NextResponse.json({ error: "Não foi possível validar a origem da solicitação." }, { status: 503 });
  }

  let client;
  try { client = sharePinClient(); } catch {
    return NextResponse.json({ error: "O acesso protegido não está configurado." }, { status: 503 });
  }
  const result = await client.rpc("create_gallery_pin_session", {
    p_token: token, p_pin: pin, p_client_fingerprint: clientFingerprint,
  });
  if (result.error) return NextResponse.json({ error: "Não foi possível verificar o PIN." }, { status: 503 });
  if (result.data === "PIN_RATE_LIMITED") {
    return NextResponse.json(
      { error: "Muitas tentativas incorretas deste endereço de acesso. Aguarde uma hora e tente novamente." },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }
  if (typeof result.data !== "string" || !/^[0-9a-f]{64}$/.test(result.data)) {
    return NextResponse.json({ error: "PIN incorreto." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(galleryPinCookieName(token), result.data, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/g/${token}`,
    maxAge: 12 * 60 * 60,
  });
  return response;
}

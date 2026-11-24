import { createClient } from "@/lib/supabase/server";
import { trustedAppOrigin } from "@/lib/app-origin";
import { handlePhotoUploadReservation } from "../../../../../scripts/lib/photo-upload-reservation-handler.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const trustedOrigin = trustedAppOrigin(request.headers);
  const isTrustedOrigin = Boolean(origin && trustedOrigin && origin === trustedOrigin);
  if (!isTrustedOrigin) {
    return handlePhotoUploadReservation(request, { userClient: null, isTrustedOrigin: false });
  }
  const userClient = await createClient();

  return handlePhotoUploadReservation(request, {
    userClient,
    env: process.env,
    isTrustedOrigin,
  });
}

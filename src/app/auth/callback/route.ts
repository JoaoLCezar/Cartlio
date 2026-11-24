import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfig } from "@/lib/supabase/config";
import { safeInvitationReturnPath } from "@/lib/auth-redirect";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  if (code && supabaseConfig()) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const next = requestUrl.searchParams.get("next");
      redirect(next === "/redefinir-senha" ? next : safeInvitationReturnPath(next) ?? "/painel");
    }
  }
  redirect("/login");
}

import { randomBytes } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseConfig } from "@/lib/supabase/config";
import { contentSecurityPolicy } from "@/lib/security-policy";

export async function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const csp = contentSecurityPolicy(nonce, {
    development: process.env.NODE_ENV === "development",
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    storageUrl: process.env.NEXT_PUBLIC_SUPABASE_STORAGE_URL,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const config = supabaseConfig();
  const pathname = request.nextUrl.pathname;
  const refreshSession = config && (
    pathname === "/login" || pathname === "/cadastro" ||
    pathname === "/recuperar-senha" || pathname === "/redefinir-senha" ||
    pathname === "/painel" || pathname.startsWith("/painel/")
  );

  if (refreshSession) {
    const supabase = createServerClient(config.url, config.key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values) {
          values.forEach(({ name, value }) => request.cookies.set(name, value));
          requestHeaders.set("cookie", request.cookies.toString());
          response = NextResponse.next({ request: { headers: requestHeaders } });
          values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    await supabase.auth.getUser();
  }

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/", "/login", "/cadastro", "/recuperar-senha", "/redefinir-senha", "/convite/:path*", "/g/:path*", "/fotografo/:path*", "/painel/:path*"],
};

"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfig } from "@/lib/supabase/config";
import type { FormState } from "@/components/action-form";
import { authReturnPath, safeInvitationReturnPath } from "@/lib/auth-redirect";
import { trustedAppOrigin } from "@/lib/app-origin";
import { passwordResetFeedback } from "@/lib/password-reset-feedback";

async function authenticate(data: FormData, signup: boolean): Promise<FormState> {
  if (!supabaseConfig()) return { error: "O acesso ainda não foi configurado. Tente novamente mais tarde." };
  const email = String(data.get("email") ?? "").trim();
  const password = String(data.get("password") ?? "");
  const next = safeInvitationReturnPath(data.get("next"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < (signup ? 8 : 1) || password.length > 128) {
    return { error: "Informe um e-mail válido e uma senha válida" + (signup ? " com 8 a 128 caracteres." : ".") };
  }
  const supabase = await createClient();
  if (signup) {
    const emailRedirectTo = await authCallbackUrl(next);
    if (!emailRedirectTo) return { error: "Não foi possível iniciar a confirmação. Atualize a página e tente novamente." };
    const options = { options: { emailRedirectTo } };
    const { data: result, error } = await supabase.auth.signUp({ email, password, ...options });
    if (error) return { error: "Não foi possível criar a conta. Verifique os dados e tente novamente." };
    if (!result.session) return { success: "Confira seu e-mail para confirmar o cadastro. Depois, entre com sua senha." };
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: "Não foi possível entrar. Confira e-mail, senha e confirmação do cadastro." };
  }
  redirect(authReturnPath(next));
}

async function authCallbackUrl(next: string | null) {
  const origin = trustedAppOrigin(await headers());
  if (!origin) return null;
  const callback = new URL("/auth/callback", origin);
  if (next) callback.searchParams.set("next", next);
  return callback.toString();
}

export async function login(_state: FormState, data: FormData) { return authenticate(data, false); }
export async function signup(_state: FormState, data: FormData) { return authenticate(data, true); }

export async function requestPasswordReset(_state: FormState, data: FormData): Promise<FormState> {
  if (!supabaseConfig()) return { error: "O acesso ainda não foi configurado. Tente novamente mais tarde." };
  const email = String(data.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { error: "Informe um e-mail válido." };
  }
  const origin = trustedAppOrigin(await headers());
  if (!origin) {
    return { error: "Não foi possível iniciar a recuperação. Atualize a página e tente novamente." };
  }
  const callbackUrl = new URL("/auth/callback?next=/redefinir-senha", origin).toString();
  try {
    const { error } = await (await createClient()).auth.resetPasswordForEmail(email, { redirectTo: callbackUrl });
    return passwordResetFeedback(!!error);
  } catch {
    return passwordResetFeedback(true);
  }
}

export async function updatePassword(_state: FormState, data: FormData): Promise<FormState> {
  const password = String(data.get("password") ?? "");
  const confirmation = String(data.get("password_confirmation") ?? "");
  if (password.length < 8 || password.length > 128) return { error: "Use uma senha com 8 a 128 caracteres." };
  if (password !== confirmation) return { error: "As senhas não conferem." };
  const { error } = await (await createClient()).auth.updateUser({ password });
  if (error) return { error: "O link expirou ou não é válido. Solicite uma nova recuperação." };
  redirect("/painel");
}

export async function logout() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error("Não foi possível sair. Tente novamente.");
  redirect("/login");
}

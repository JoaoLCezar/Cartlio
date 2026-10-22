"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfig } from "@/lib/supabase/config";
import type { FormState } from "@/components/action-form";

async function authenticate(data: FormData, signup: boolean): Promise<FormState> {
  if (!supabaseConfig()) return { error: "O acesso ainda não foi configurado. Tente novamente mais tarde." };
  const email = String(data.get("email") ?? "").trim();
  const password = String(data.get("password") ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < (signup ? 8 : 1) || password.length > 128) {
    return { error: "Informe um e-mail válido e uma senha válida" + (signup ? " com 8 a 128 caracteres." : ".") };
  }
  const supabase = await createClient();
  if (signup) {
    const { data: result, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error: "Não foi possível criar a conta. Verifique os dados e tente novamente." };
    if (!result.session) return { success: "Confira seu e-mail para confirmar o cadastro. Depois, entre com sua senha." };
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: "Não foi possível entrar. Confira e-mail, senha e confirmação do cadastro." };
  }
  redirect("/painel");
}

export async function login(_state: FormState, data: FormData) { return authenticate(data, false); }
export async function signup(_state: FormState, data: FormData) { return authenticate(data, true); }

export async function logout() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error("Não foi possível sair. Tente novamente.");
  redirect("/login");
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import type { FormState } from "@/components/action-form";

export async function saveProfile(_state: FormState, data: FormData): Promise<FormState> {
  const { supabase, user } = await requireUser();
  const name = String(data.get("display_name") ?? "").trim();
  if (!name || [...name].length > 120) return { error: "Informe um nome de até 120 caracteres." };
  const { data: existing, error: readError } = await supabase.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (readError) return { error: "Não foi possível carregar seu perfil. Tente novamente." };
  const { error } = existing
    ? await supabase.from("profiles").update({ display_name: name }).eq("id", user.id)
    : await supabase.from("profiles").insert({ id: user.id, display_name: name });
  if (error) return { error: "Não foi possível salvar seu perfil. Tente novamente." };
  revalidatePath("/painel");
  return { success: "Perfil salvo." };
}

export async function createWorkspace(_state: FormState, data: FormData): Promise<FormState> {
  const { supabase } = await requireUser();
  const name = String(data.get("name") ?? "").trim();
  const slug = String(data.get("slug") ?? "").trim().toLowerCase();
  if (!name || [...name].length > 120 || slug.length < 3 || slug.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { error: "Informe um nome e um endereço de 3 a 48 caracteres, usando letras minúsculas, números e hífens entre palavras." };
  }
  const { data: id, error } = await supabase.rpc("create_workspace", { p_name: name, p_slug: slug });
  if (error) return { error: error.code === "23505" ? "Este endereço já está em uso. Escolha outro." : "Não foi possível criar seu workspace. Tente novamente." };
  revalidatePath("/painel");
  redirect(`/painel/${id}`);
}

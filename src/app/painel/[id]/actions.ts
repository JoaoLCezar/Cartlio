"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/action-form";
import { requireWorkspace } from "@/lib/workspace";
import { isUuid, parseCustomer, parseGallery } from "@/lib/gallery-validation";

export async function saveCustomer(tenantId: string, customerId: string | null, _state: FormState, data: FormData): Promise<FormState> {
  const { supabase } = await requireWorkspace(tenantId);
  const parsed = parseCustomer(data);
  if (parsed.error) return { error: parsed.error };
  if (customerId && !isUuid(customerId)) return { error: "Cliente inválido." };
  const query = customerId
    ? supabase.from("customers").update(parsed.value).eq("tenant_id", tenantId).eq("id", customerId)
    : supabase.from("customers").insert({ ...parsed.value, tenant_id: tenantId });
  const { data: saved, error } = await query.select("id").maybeSingle();
  if (error || !saved) return { error: "Não foi possível salvar o cliente. Atualize a página e tente novamente." };
  revalidatePath(`/painel/${tenantId}`, "layout");
  return { success: customerId ? "Cliente atualizado." : "Cliente cadastrado." };
}
export async function saveGallery(tenantId: string, galleryId: string | null, _state: FormState, data: FormData): Promise<FormState> {
  const { supabase } = await requireWorkspace(tenantId);
  const parsed = parseGallery(data);
  if (parsed.error) return { error: parsed.error };
  if (galleryId && !isUuid(galleryId)) return { error: "Galeria inválida." };
  const query = galleryId
    ? supabase.from("galleries").update(parsed.value).eq("tenant_id", tenantId).eq("id", galleryId)
    : supabase.from("galleries").insert({ ...parsed.value, tenant_id: tenantId });
  const { data: saved, error } = await query.select("id").maybeSingle();
  if (error?.code === "23505") return { error: "Este endereço já está em uso neste workspace." };
  if (error?.code === "23503") return { error: "Selecione um cliente deste workspace." };
  if (error || !saved) return { error: "Não foi possível salvar a galeria. Atualize a página e tente novamente." };
  revalidatePath(`/painel/${tenantId}`, "layout");
  if (!galleryId) redirect(`/painel/${tenantId}/galerias/${saved.id}`);
  return { success: "Galeria atualizada." };
}

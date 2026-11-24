"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/action-form";
import { isUuid } from "@/lib/gallery-validation";
import { requireWorkspace } from "@/lib/workspace";

function refreshPortfolio(tenantId: string, slug: string) {
  revalidatePath(`/painel/${tenantId}/portfolio`);
  revalidatePath(`/fotografo/${slug}`);
}

export async function savePortfolio(tenantId: string, _state: FormState, data: FormData): Promise<FormState> {
  const { supabase, tenant } = await requireWorkspace(tenantId);
  const name = String(data.get("name") ?? "").trim();
  const bio = String(data.get("bio") ?? "").trim();
  const email = String(data.get("email") ?? "").trim();
  const published = data.get("published") === "on";
  if (!name || name.length > 120 || bio.length > 1200 ||
    (email && (email.length > 254 || !/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)))) {
    return { error: "Confira o nome público, o tamanho da apresentação e o e-mail." };
  }

  const { error } = await supabase.rpc("save_portfolio", {
    p_tenant_id: tenantId,
    p_display_name: name,
    p_bio: bio,
    p_contact_email: email || null,
    p_published: published,
  });
  if (error) return { error: "Não foi possível salvar. Apenas o proprietário pode gerenciar o portfólio." };
  refreshPortfolio(tenantId, tenant.slug);
  return { success: published ? "Portfólio publicado." : "Rascunho salvo. O endereço está indisponível ao público." };
}

export async function setPortfolioPhoto(
  tenantId: string, photoId: string, include: boolean,
): Promise<FormState> {
  if (!isUuid(photoId)) return { error: "Foto inválida." };
  const { supabase, tenant } = await requireWorkspace(tenantId);
  const { data, error } = await supabase.rpc("set_portfolio_photo", {
    p_tenant_id: tenantId, p_photo_id: photoId, p_include: include,
  });
  if (error?.message === "PORTFOLIO_PHOTO_LIMIT") return { error: "O portfólio aceita até 12 fotos." };
  if (error || !data) return { error: "Não foi possível alterar a seleção de fotos do portfólio." };

  refreshPortfolio(tenantId, tenant.slug);
  return { success: include ? "Foto adicionada." : "Foto removida." };
}

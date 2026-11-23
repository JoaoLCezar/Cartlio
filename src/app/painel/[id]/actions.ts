"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import sharp from "sharp";
import type { FormState } from "@/components/action-form";
import { requireWorkspace } from "@/lib/workspace";
import { isUuid, parseCustomer, parseGallery } from "@/lib/gallery-validation";
import { workspaceAssetStorageClient } from "@/lib/supabase/workspace-assets";

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

export async function deleteCustomer(tenantId: string, customerId: string, _state: FormState, _data: FormData): Promise<FormState> {
  void _state; void _data;
  const { supabase } = await requireWorkspace(tenantId);
  if (!isUuid(customerId)) return { error: "Cliente inválido." };
  const { data: deleted, error } = await supabase.from("customers").delete().eq("tenant_id", tenantId).eq("id", customerId).select("id").maybeSingle();
  if (error?.code === "23503") return { error: "Desvincule este cliente das galerias antes de excluí-lo." };
  if (error || !deleted) return { error: "Não foi possível excluir o cliente. Atualize a página e tente novamente." };
  revalidatePath(`/painel/${tenantId}`, "layout");
  return { success: "Cliente excluído." };
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

export async function duplicateGallery(tenantId: string, galleryId: string, _data: FormData): Promise<void> {
  void _data;
  const { supabase } = await requireWorkspace(tenantId);
  if (!isUuid(galleryId)) throw new Error("Galeria inválida.");

  const { data: source, error: sourceError } = await supabase
    .from("galleries")
    .select("title, slug, description")
    .eq("tenant_id", tenantId)
    .eq("id", galleryId)
    .maybeSingle();
  if (sourceError || !source) throw new Error("Não foi possível encontrar a galeria para duplicar.");

  const title = [...`Cópia de ${source.title}`].slice(0, 120).join("");
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const suffix = attempt === 1 ? "-copia" : `-copia-${attempt}`;
    const slug = `${source.slug.slice(0, 80 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    const { data: copy, error } = await supabase.from("galleries").insert({
      tenant_id: tenantId,
      title,
      slug,
      description: source.description,
      status: "draft",
      customer_id: null,
    }).select("id").maybeSingle();

    if (error?.code === "23505") continue;
    if (error || !copy) throw new Error("Não foi possível duplicar a galeria. Atualize a página e tente novamente.");
    revalidatePath(`/painel/${tenantId}`, "layout");
    redirect(`/painel/${tenantId}/galerias/${copy.id}`);
  }
  throw new Error("Não foi possível gerar um endereço livre para a cópia. Tente novamente.");
}

export async function saveWorkspaceBrand(tenantId: string, _state: FormState, data: FormData): Promise<FormState> {
  const { supabase } = await requireWorkspace(tenantId);
  const brandName = String(data.get("brand_name") ?? "").trim();
  const brandColor = String(data.get("brand_color") ?? "");
  if ([...brandName].length > 120) return { error: "O nome público pode ter até 120 caracteres." };
  if (!/^#[0-9a-f]{6}$/i.test(brandColor)) return { error: "Escolha uma cor hexadecimal válida." };
  const { data: saved, error } = await supabase.rpc("set_tenant_public_brand", {
    p_tenant_id: tenantId,
    p_brand_name: brandName || null,
    p_brand_color: brandColor,
  });
  if (error?.code === "42501") return { error: "Somente o proprietário do workspace pode alterar a marca do estúdio." };
  if (error || saved !== true) return { error: "Não foi possível salvar a identidade do estúdio. Tente novamente." };
  revalidatePath(`/painel/${tenantId}/marca`);
  return { success: "Identidade do estúdio atualizada." };
}

const brandLogoLimit = 2 * 1024 * 1024;
const brandLogoPixelLimit = 20_000_000;
const brandLogoTypes: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

async function processBrandLogo(file: File) {
  if (!file.size || file.size > brandLogoLimit || !brandLogoTypes[file.type]) return null;
  const input = Buffer.from(await file.arrayBuffer());
  try {
    const metadata = await sharp(input, { limitInputPixels: brandLogoPixelLimit, failOn: "error" }).metadata();
    if (metadata.format !== brandLogoTypes[file.type] || !metadata.width || !metadata.height
      || metadata.width * metadata.height > brandLogoPixelLimit || (metadata.pages ?? 1) > 1) return null;
    const output = await sharp(input, { limitInputPixels: brandLogoPixelLimit, failOn: "error" })
      .autoOrient()
      .timeout({ seconds: 8 })
      .resize({ width: 640, height: 320, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 86, effort: 4 })
      .toBuffer();
    // Copy into ordinary ArrayBuffer-backed memory; Next's fetch rejects shared-backed upload bodies.
    return output.length <= brandLogoLimit ? Uint8Array.from(output) : null;
  } catch {
    return null;
  }
}

export async function saveWorkspaceLogo(tenantId: string, _state: FormState, data: FormData): Promise<FormState> {
  const { supabase, user } = await requireWorkspace(tenantId);
  const action = String(data.get("logo_action") ?? "upload");
  if (action !== "upload" && action !== "remove") return { error: "Ação de logo inválida." };

  const [membership, workspace] = await Promise.all([
    supabase.from("tenant_members").select("role").eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle(),
    supabase.from("tenants").select("brand_logo_path").eq("id", tenantId).maybeSingle(),
  ]);
  if (membership.error || workspace.error || !workspace.data) {
    return { error: "Não foi possível validar a identidade do estúdio. Atualize a página e tente novamente." };
  }
  if (membership.data?.role !== "owner") {
    return { error: "Somente o proprietário do workspace pode alterar a marca do estúdio." };
  }

  const previousPath = workspace.data.brand_logo_path;
  if (action === "remove" && !previousPath) return { success: "Este estúdio ainda não tem um logo." };
  let storage: ReturnType<typeof workspaceAssetStorageClient>;
  try { storage = workspaceAssetStorageClient(); } catch {
    return { error: "O armazenamento do logo não está configurado neste servidor." };
  }

  let nextPath: string | null = null;
  if (action === "upload") {
    const file = data.get("brand_logo");
    if (!(file instanceof File)) return { error: "Selecione um logo para enviar." };
    const output = await processBrandLogo(file);
    if (!output) return { error: "Use uma imagem PNG, JPG ou WebP válida, estática e de até 2 MiB." };
    nextPath = tenantId + "/" + randomUUID() + ".webp";
    const { error: uploadError } = await storage.storage.from("gallery-brand-assets").upload(nextPath, output, {
      contentType: "image/webp", cacheControl: "31536000", upsert: false,
    });
    if (uploadError) return { error: "Não foi possível enviar o logo. Tente novamente." };
  }

  const { data: saved, error: saveError } = await supabase.rpc("set_tenant_brand_logo", {
    p_tenant_id: tenantId,
    p_logo_path: nextPath,
  });
  if (saveError || saved !== true) {
    if (nextPath) await storage.storage.from("gallery-brand-assets").remove([nextPath]);
    if (saveError?.code === "42501") return { error: "Somente o proprietário do workspace pode alterar a marca do estúdio." };
    return { error: "Não foi possível salvar o logo. Atualize a página e tente novamente." };
  }

  if (previousPath && previousPath !== nextPath) {
    await storage.storage.from("gallery-brand-assets").remove([previousPath]);
  }
  revalidatePath("/painel/" + tenantId + "/marca");
  return { success: action === "remove" ? "Logo removido." : "Logo do estúdio atualizado." };
}

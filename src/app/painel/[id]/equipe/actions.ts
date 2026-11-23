"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/action-form";
import { requireWorkspace } from "@/lib/workspace";
import { isUuid } from "@/lib/gallery-validation";

export type WorkspaceInvitationState = FormState & { invitationToken?: string };

export async function createWorkspaceInvitation(_state: WorkspaceInvitationState, data: FormData): Promise<WorkspaceInvitationState> {
  const tenantId = String(data.get("tenant_id") ?? "");
  const email = String(data.get("email") ?? "").trim().toLowerCase();
  if (!isUuid(tenantId)) return { error: "Atualize a página e tente novamente." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: "Informe um e-mail válido de até 254 caracteres." };

  const { supabase } = await requireWorkspace(tenantId);
  const { data: invitationData, error } = await supabase.rpc("create_workspace_invitation", {
    p_tenant_id: tenantId,
    p_email: email,
  }).single();
  const invitation = invitationData as unknown as { invitation_id: string; token: string } | null;
  if (error || !invitation) {
    return { error: error?.message.includes("INVITATION_ALREADY_MEMBER")
      ? "Essa pessoa já participa deste workspace."
      : "Não foi possível criar o convite. Confira as permissões e tente novamente." };
  }

  revalidatePath(`/painel/${tenantId}/equipe`);
  return { success: `Convite preparado para ${email}. Copie o link e envie pelo canal que preferir.`, invitationToken: invitation.token };
}

export async function revokeWorkspaceInvitation(_state: FormState, data: FormData): Promise<FormState> {
  const tenantId = String(data.get("tenant_id") ?? "");
  const invitationId = String(data.get("invitation_id") ?? "");
  if (!isUuid(tenantId) || !isUuid(invitationId)) return { error: "Atualize a página e tente novamente." };

  const { supabase } = await requireWorkspace(tenantId);
  const { data: revoked, error } = await supabase.rpc("revoke_workspace_invitation", {
    p_tenant_id: tenantId,
    p_invitation_id: invitationId,
  });
  if (error || revoked !== true) return { error: "O convite já foi usado, revogado ou expirou." };
  revalidatePath(`/painel/${tenantId}/equipe`);
  return { success: "Convite revogado." };
}

export async function removeWorkspaceMember(_state: FormState, data: FormData): Promise<FormState> {
  const tenantId = String(data.get("tenant_id") ?? "");
  const userId = String(data.get("user_id") ?? "");
  if (!isUuid(tenantId) || !isUuid(userId)) return { error: "Atualize a página e tente novamente." };

  const { supabase } = await requireWorkspace(tenantId);
  const { data: removed, error } = await supabase.rpc("remove_workspace_member", {
    p_tenant_id: tenantId,
    p_user_id: userId,
  });
  if (error) {
    return { error: error.message.includes("WORKSPACE_OWNER_REMOVAL_DENIED")
      ? "A conta proprietária não pode ser removida."
      : "Não foi possível remover o acesso. Confira as permissões e tente novamente." };
  }
  if (removed !== true) return { error: "Este colaborador já não tem acesso a este workspace." };

  revalidatePath("/painel");
  revalidatePath(`/painel/${tenantId}`);
  revalidatePath(`/painel/${tenantId}/equipe`);
  return { success: "Acesso do colaborador removido." };
}

export async function transferWorkspaceOwnership(_state: FormState, data: FormData): Promise<FormState> {
  const tenantId = String(data.get("tenant_id") ?? "");
  const newOwnerUserId = String(data.get("new_owner_user_id") ?? "");
  if (!isUuid(tenantId) || !isUuid(newOwnerUserId)) return { error: "Escolha um colaborador e tente novamente." };
  if (data.get("confirm_transfer") !== "yes") return { error: "Confirme que entende a mudança de permissões." };

  const { supabase } = await requireWorkspace(tenantId);
  const { data: transferred, error } = await supabase.rpc("transfer_workspace_ownership", {
    p_tenant_id: tenantId,
    p_new_owner_user_id: newOwnerUserId,
  });
  if (error) {
    return { error: error.message.includes("WORKSPACE_TRANSFER_TARGET_NOT_EDITOR")
      ? "A propriedade só pode ser transferida para alguém que já seja colaborador."
      : error.message.includes("WORKSPACE_TRANSFER_TARGET_INVALID")
        ? "Escolha outro membro da equipe."
        : "Não foi possível transferir a propriedade. Confira as permissões e tente novamente." };
  }
  if (transferred !== true) return { error: "Não foi possível concluir a transferência." };

  revalidatePath("/painel");
  revalidatePath(`/painel/${tenantId}`);
  revalidatePath(`/painel/${tenantId}/equipe`);
  redirect(`/painel/${tenantId}`);
}

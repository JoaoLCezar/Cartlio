"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/components/action-form";
import { requireUser } from "@/lib/auth";
import { safeInvitationReturnPath } from "@/lib/auth-redirect";

export async function acceptWorkspaceInvitation(_state: FormState, data: FormData): Promise<FormState> {
  const token = String(data.get("token") ?? "");
  if (!/^[0-9a-f]{64}$/.test(token)) return { error: "Este convite não está disponível. Peça ao proprietário um novo link." };

  const { supabase } = await requireUser();
  const { data: tenantId, error } = await supabase.rpc("accept_workspace_invitation", { p_token: token });
  if (error || typeof tenantId !== "string") {
    const message = error?.message ?? "";
    if (message.includes("INVITATION_EMAIL_MISMATCH")) return { error: "Entre com o e-mail convidado e abra este link novamente." };
    return { error: "Este convite expirou ou não está mais disponível. Peça ao proprietário um novo link." };
  }

  redirect(`/painel/${tenantId}`);
}

export async function signOutForInvitation(data: FormData) {
  const token = String(data.get("token") ?? "");
  const returnPath = safeInvitationReturnPath(`/convite/${token}`);
  if (!returnPath) redirect("/login");
  const { supabase } = await requireUser();
  await supabase.auth.signOut();
  redirect(`/login?next=${encodeURIComponent(returnPath)}`);
}

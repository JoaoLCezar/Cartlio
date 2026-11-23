"use client";

import { useActionState, useState } from "react";
import { createWorkspaceInvitation, type WorkspaceInvitationState } from "@/app/painel/[id]/equipe/actions";

export function WorkspaceInvitationForm({ tenantId }: { tenantId: string }) {
  const [state, formAction, pending] = useActionState<WorkspaceInvitationState, FormData>(createWorkspaceInvitation, {});
  const [copied, setCopied] = useState(false);
  const invitationUrl = state.invitationToken && typeof window !== "undefined"
    ? `${window.location.origin}/convite/${state.invitationToken}`
    : "";

  async function copyInvitation() {
    if (!invitationUrl) return;
    try {
      await navigator.clipboard.writeText(invitationUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return <form action={formAction} className="space-y-5">
    <input type="hidden" name="tenant_id" value={tenantId} />
    <label className="field">E-mail do colaborador<input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="nome@estudio.com.br" /></label>
    <p className="text-sm text-stone-400">O convite expira em 7 dias. Colaboradores podem gerenciar clientes, galerias, fotos, compartilhamentos e seleções. Eles podem visualizar a marca, mas não gerenciar equipe e convites, transferir a propriedade nem alterar a marca do estúdio.</p>
    <p className="text-sm text-stone-400">A pessoa precisa entrar ou criar uma conta com esse mesmo e-mail.</p>
    {state.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
    {state.success && <p role="status" className="text-sm text-emerald-300">{state.success}</p>}
    {invitationUrl && <div className="workspace-invitation-result">
      <label className="field">Link de uso único<input aria-label="Link de convite" type="url" readOnly value={invitationUrl} onFocus={event => event.currentTarget.select()} /></label>
      <button className="button-secondary" type="button" onClick={copyInvitation}>{copied ? "Link copiado" : "Copiar link de convite"}</button>
    </div>}
    <button className="button" type="submit" disabled={pending}>{pending ? "Preparando convite…" : "Gerar link de convite"}</button>
  </form>;
}

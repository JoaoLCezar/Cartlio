"use client";

import { useActionState } from "react";
import { removeWorkspaceMember, revokeWorkspaceInvitation, transferWorkspaceOwnership } from "@/app/painel/[id]/equipe/actions";
import type { FormState } from "@/components/action-form";

export function RevokeWorkspaceInvitation({ tenantId, invitationId }: { tenantId: string; invitationId: string }) {
  const [state, formAction, pending] = useActionState(revokeWorkspaceInvitation, {});
  return <form action={formAction} className="workspace-invitation-revoke">
    <input type="hidden" name="tenant_id" value={tenantId} />
    <input type="hidden" name="invitation_id" value={invitationId} />
    {state.success && <span role="status" className="text-sm text-emerald-300">{state.success}</span>}
    {state.error && <span role="alert" className="text-sm text-red-300">{state.error}</span>}
    <button className="button-secondary" type="submit" disabled={pending}>{pending ? "Revogando…" : "Revogar convite"}</button>
  </form>;
}

export function RemoveWorkspaceMemberButton({ tenantId, userId, memberName }: {
  tenantId: string;
  userId: string;
  memberName: string;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(removeWorkspaceMember, {});
  return <form
    action={formAction}
    className="workspace-invitation-revoke"
    onSubmit={event => {
      if (!window.confirm(`Remover o acesso de ${memberName}? A pessoa perderá imediatamente o acesso a este workspace e às galerias.`)) {
        event.preventDefault();
      }
    }}
  >
    <input type="hidden" name="tenant_id" value={tenantId} />
    <input type="hidden" name="user_id" value={userId} />
    {state.success && <span role="status" className="text-sm text-emerald-300">{state.success}</span>}
    {state.error && <span role="alert" className="text-sm text-red-300">{state.error}</span>}
    <button className="button-secondary workspace-member-remove" type="submit" disabled={pending}>
      {pending ? "Removendo…" : "Remover colaborador"}
    </button>
  </form>;
}

type TransferTarget = {
  member_user_id: string;
  member_email: string | null;
  member_display_name: string | null;
};

export function TransferWorkspaceOwnershipForm({ tenantId, workspaceName, members }: {
  tenantId: string;
  workspaceName: string;
  members: TransferTarget[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(transferWorkspaceOwnership, {});
  return <section className="panel workspace-transfer-card" aria-labelledby="workspace-transfer-heading">
    <div>
      <p className="eyebrow">Propriedade do workspace</p>
      <h2 id="workspace-transfer-heading">Transferir propriedade</h2>
      <p>A pessoa escolhida assume o controle da equipe e da marca do estúdio. Sua conta continuará como colaboradora e deixará de gerenciar estas configurações.</p>
    </div>
    {members.length ? <form
      action={formAction}
      className="workspace-transfer-form"
      onSubmit={event => {
        const selectedName = members.find(member => member.member_user_id === (event.currentTarget.elements.namedItem("new_owner_user_id") as HTMLSelectElement).value)?.member_email ?? "a pessoa selecionada";
        if (!window.confirm(`Transferir a propriedade de ${workspaceName} para ${selectedName}? Sua conta passará a ser colaboradora.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="tenant_id" value={tenantId} />
      <label className="field" htmlFor="workspace-new-owner">Novo proprietário
        <select id="workspace-new-owner" name="new_owner_user_id" required defaultValue="">
          <option value="" disabled>Selecione um colaborador</option>
          {members.map(member => {
            const name = member.member_display_name?.trim();
            const label = name && name !== member.member_email ? `${name} · ${member.member_email ?? "e-mail indisponível"}` : member.member_email ?? name ?? "Conta sem e-mail";
            return <option key={member.member_user_id} value={member.member_user_id}>{label}</option>;
          })}
        </select>
      </label>
      <label className="workspace-transfer-confirm"><input type="checkbox" name="confirm_transfer" value="yes" required />
        <span>Entendo que deixarei de ser proprietário e perderei o gerenciamento da equipe.</span>
      </label>
      {state.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
      <button className="button-secondary workspace-transfer-button" type="submit" disabled={pending}>
        {pending ? "Transferindo…" : "Transferir propriedade"}
      </button>
    </form> : <p className="workspace-transfer-empty">Adicione um colaborador e aguarde a aceitação do convite para transferir a propriedade.</p>}
  </section>;
}

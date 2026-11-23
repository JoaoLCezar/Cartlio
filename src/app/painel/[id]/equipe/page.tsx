import { notFound } from "next/navigation";
import { requireWorkspace } from "@/lib/workspace";
import { WorkspaceInvitationForm } from "@/components/workspace-invitation-form";
import { RemoveWorkspaceMemberButton, RevokeWorkspaceInvitation, TransferWorkspaceOwnershipForm } from "@/components/workspace-invitation-actions";

export const dynamic = "force-dynamic";

type PendingInvitation = {
  invitation_id: string;
  invited_email: string;
  invited_role: "editor";
  expires_at: string;
  created_at: string;
};

type WorkspaceMember = {
  member_user_id: string;
  member_email: string | null;
  member_display_name: string | null;
  member_role: "owner" | "editor";
  joined_at: string;
};

type TeamActivity = {
  event_id: number;
  event_type: "workspace_created" | "member_joined" | "member_removed" | "ownership_transferred"
    | "invitation_created" | "invitation_reissued" | "invitation_revoked";
  actor_user_id: string | null;
  actor_email: string | null;
  actor_display_name: string | null;
  subject_user_id: string | null;
  subject_email: string | null;
  subject_display_name: string | null;
  happened_at: string;
  invited_email: string | null;
};

export default async function WorkspaceTeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, user, tenant } = await requireWorkspace(id);
  const { data: membership, error: membershipError } = await supabase.from("tenant_members")
    .select("role").eq("tenant_id", id).eq("user_id", user.id).single();
  if (membershipError || !membership) throw new Error("Não foi possível carregar as permissões do workspace.");
  if (membership.role !== "owner") notFound();

  const [
    { data: memberData, error: memberError },
    { data: invitationData, error: invitationError },
    { data: activityData, error: activityError },
  ] = await Promise.all([
    supabase.rpc("list_workspace_members", { p_tenant_id: id }),
    supabase.rpc("list_workspace_invitations", { p_tenant_id: id }),
    supabase.rpc("list_workspace_team_activity", { p_tenant_id: id }),
  ]);
  if (memberError) throw new Error("Não foi possível carregar os membros da equipe.");
  if (invitationError) throw new Error("Não foi possível carregar os convites da equipe.");
  if (activityError) throw new Error("Não foi possível carregar a atividade da equipe.");
  const members = (memberData ?? []) as WorkspaceMember[];
  const invitations = (invitationData ?? []) as PendingInvitation[];
  const activity = (activityData ?? []) as TeamActivity[];

  return <main className="dashboard-shell">
    <header className="dashboard-header">
      <div><p className="eyebrow">{tenant.name}</p><h1>Equipe do estúdio</h1>
        <p>Convide uma pessoa de confiança para ajudar a organizar clientes e galerias.</p></div>
    </header>

    <section className="workspace-invitations-list" aria-labelledby="workspace-members-heading">
      <div className="workspace-invitations-heading">
        <div><p className="eyebrow">Acesso ao estúdio</p><h2 id="workspace-members-heading">Equipe com acesso</h2></div>
        <span>{members.length} {members.length === 1 ? "pessoa" : "pessoas"}</span>
      </div>
      <div className="workspace-members-rows">
        {members.map(member => {
          const memberName = member.member_display_name?.trim() || member.member_email || "Conta sem e-mail";
          const isOwner = member.member_role === "owner";
          return <article className="workspace-invitation-row workspace-member-row" key={member.member_user_id}>
            <div className="workspace-member-identity">
              <h3>{memberName}{member.member_user_id === user.id && <span className="workspace-member-you">Você</span>}</h3>
              <p>{member.member_email || "E-mail indisponível"} · {isOwner ? "Proprietário" : "Colaborador"}</p>
            </div>
            {isOwner
              ? <span className="workspace-member-role">Proprietário</span>
              : <RemoveWorkspaceMemberButton tenantId={id} userId={member.member_user_id} memberName={memberName} />}
          </article>;
        })}
      </div>
      <p className="workspace-members-note">Ao remover um colaborador, o acesso ao workspace e às galerias é encerrado imediatamente.</p>
    </section>

    <TransferWorkspaceOwnershipForm
      tenantId={id}
      workspaceName={tenant.name}
      members={members.filter(member => member.member_role === "editor")}
    />

    <section className="panel workspace-invitation-card" aria-labelledby="workspace-invite-heading">
      <div>
        <p className="eyebrow">Colaboradores</p>
        <h2 id="workspace-invite-heading">Prepare um convite</h2>
        <p>O colaborador poderá trabalhar nas galerias deste workspace. Só o proprietário pode gerenciar convites e a marca do estúdio.</p>
      </div>
      <WorkspaceInvitationForm tenantId={id} />
    </section>

    <section className="workspace-invitations-list" aria-labelledby="workspace-invitations-heading">
      <div className="workspace-invitations-heading">
        <div><p className="eyebrow">Acesso pendente</p><h2 id="workspace-invitations-heading">Convites ativos</h2></div>
        <span>{invitations.length} {invitations.length === 1 ? "convite" : "convites"}</span>
      </div>
      {invitations.length ? invitations.map(invitation => <article className="workspace-invitation-row" key={invitation.invitation_id}>
        <div><h3>{invitation.invited_email}</h3><p>Colaborador · válido até {new Date(invitation.expires_at).toLocaleDateString("pt-BR", { dateStyle: "long" })}</p></div>
        <RevokeWorkspaceInvitation tenantId={id} invitationId={invitation.invitation_id} />
      </article>) : <p className="workspace-invitations-empty">Ainda não há convites ativos.</p>}
    </section>

    <section className="workspace-invitations-list" aria-labelledby="workspace-activity-heading">
      <div className="workspace-invitations-heading">
        <div><p className="eyebrow">Histórico</p><h2 id="workspace-activity-heading">Atividade da equipe</h2></div>
        <span>Últimas 50 movimentações</span>
      </div>
      {activity.length ? <div className="workspace-team-activity">
        {activity.map(event => {
          const actor = event.actor_display_name?.trim() || event.actor_email || "Conta removida";
          const subject = event.subject_display_name?.trim() || event.subject_email || "membro removido";
          const invitedEmail = event.invited_email || "endereço indisponível";
          const description = event.event_type === "workspace_created" ? `${actor} criou o workspace`
            : event.event_type === "member_joined" ? `${subject} entrou na equipe`
              : event.event_type === "member_removed" ? `${actor} removeu ${subject} da equipe`
                : event.event_type === "ownership_transferred" ? `${actor} transferiu a propriedade para ${subject}`
                  : event.event_type === "invitation_created" ? `${actor} criou um convite para ${invitedEmail}`
                    : event.event_type === "invitation_reissued" ? `${actor} reemitiu um convite para ${invitedEmail}`
                      : `${actor} revogou um convite para ${invitedEmail}`;
          return <article className="workspace-team-activity-row" key={event.event_id}>
            <span aria-hidden="true" className="workspace-team-activity-mark" />
            <p>{description}</p>
            <time dateTime={event.happened_at}>{new Date(event.happened_at).toLocaleString("pt-BR", {
              dateStyle: "medium", timeStyle: "short", timeZone: "America/Sao_Paulo",
            })}</time>
          </article>;
        })}
      </div> : <p className="workspace-invitations-empty">As mudanças de acesso aparecerão aqui.</p>}
    </section>
  </main>;
}

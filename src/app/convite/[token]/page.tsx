import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { AcceptWorkspaceInvitationForm } from "@/components/accept-workspace-invitation-form";
import { signOutForInvitation } from "@/app/convite/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Convite para equipe | Quadrics",
  robots: { index: false, follow: false, noarchive: true },
};

type WorkspaceInvitation = { email: string; role: "editor"; workspace_name: string; expires_at: string };

export default async function WorkspaceInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();

  const supabase = await createClient();
  const [{ data: invitationData, error: invitationError }, { data: { user } }] = await Promise.all([
    supabase.rpc("get_workspace_invitation", { p_token: token }),
    supabase.auth.getUser(),
  ]);
  if (invitationError) throw new Error("Não foi possível validar o convite.");
  if (!invitationData) notFound();
  const invitation = invitationData as WorkspaceInvitation;
  const returnTo = `/convite/${token}`;
  const matchesEmail = user?.email?.trim().toLowerCase() === invitation.email;

  return <main className="auth-page workspace-invitation-page">
    <aside className="auth-aside">
      <Link href="/" className="brand-wordmark">quadrics<span>.</span></Link>
      <div className="auth-aside-copy">
        <p className="eyebrow">Trabalhe em equipe</p>
        <h2>Um estúdio, organizado em conjunto.</h2>
        <p>Convites privados vinculam o acesso ao e-mail escolhido pelo proprietário.</p>
      </div>
      <span className="text-sm text-stone-400">© {new Date().getFullYear()} Quadrics</span>
    </aside>
    <section className="auth-card">
      <Link href="/" className="brand-wordmark" aria-label="Quadrics, início">quadrics<span>.</span></Link>
      <p className="eyebrow mt-10">Convite para colaborar</p>
      <h1>{invitation.workspace_name}</h1>
      <p className="mb-5 text-stone-400">Acesso de colaborador · enviado para <strong className="text-stone-200">{invitation.email}</strong></p>
      <p className="mb-5 text-sm leading-6 text-stone-400">Como colaborador, você poderá gerenciar clientes, galerias, fotos, compartilhamentos e seleções. A equipe, os convites, a transferência de propriedade e as alterações da marca ficam disponíveis apenas para o proprietário.</p>
      <p className="mb-8 text-sm text-stone-400">Este convite expira em {new Date(invitation.expires_at).toLocaleDateString("pt-BR", { dateStyle: "long" })} e só pode ser aceito por uma conta confirmada com esse e-mail.</p>
      {user ? matchesEmail ? <AcceptWorkspaceInvitationForm token={token} /> : <div className="space-y-5">
        <p role="alert" className="rounded-xl border border-amber-400/30 p-4 text-sm text-amber-200">A conta aberta no momento usa outro e-mail. Troque de conta para continuar.</p>
        <form action={signOutForInvitation}><input type="hidden" name="token" value={token} /><button className="button w-full" type="submit">Sair e trocar de conta</button></form>
      </div> : <div className="space-y-4">
        <Link className="button w-full" href={`/login?next=${encodeURIComponent(returnTo)}`}>Entrar com a conta convidada</Link>
        <Link className="button-secondary w-full" href={`/cadastro?next=${encodeURIComponent(returnTo)}`}>Criar conta com esse e-mail</Link>
      </div>}
    </section>
  </main>;
}

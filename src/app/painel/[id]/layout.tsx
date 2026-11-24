import Link from "next/link";
import { requireWorkspace } from "@/lib/workspace";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tenant, supabase, user } = await requireWorkspace(id);
  const { data: membership, error } = await supabase.from("tenant_members")
    .select("role").eq("tenant_id", id).eq("user_id", user.id).single();
  if (error || !membership) throw new Error("Não foi possível carregar as permissões do workspace.");
  return <>
    <Link href="/painel" className="workspace-back">← Todos os espaços</Link>
    <p className="workspace-name">{tenant.name}</p>
    <nav aria-label="Workspace" className="workspace-navigation">
      <Link href={`/painel/${id}`}>Galerias</Link>
      <Link href={`/painel/${id}/clientes`}>Clientes</Link>
      <Link href={`/painel/${id}/marca`}>Marca do estúdio</Link>
      {membership.role === "owner" && <Link href={`/painel/${id}/portfolio`}>Portfólio</Link>}
      {membership.role === "owner" && <Link href={`/painel/${id}/equipe`}>Equipe</Link>}
    </nav>
    {children}
  </>;
}

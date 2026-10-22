import Link from "next/link";

export default function WorkspaceNotFound() {
  return <section className="panel"><h1 className="mb-4 text-2xl font-semibold">Workspace não encontrado</h1><p className="mb-6 text-stone-400">Este espaço não está disponível para sua conta.</p><Link className="button" href="/painel">Voltar ao painel</Link></section>;
}

import Link from "next/link";

export default function NotFound() {
  return <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16"><h1 className="mb-4 text-3xl font-semibold">Página não encontrada</h1><p className="mb-8 text-stone-400">Este conteúdo não existe ou não está disponível para sua conta.</p><Link className="button self-start" href="/painel">Voltar ao painel</Link></main>;
}

import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-stone-950 text-stone-50">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 sm:px-10">
        <header className="flex items-center justify-between border-b border-white/15 pb-6">
          <span className="text-2xl font-semibold tracking-tight">cartlio<span className="text-amber-400">.</span></span>
          <Link href="/login" className="text-sm text-amber-300">Entrar</Link>
        </header>
        <section className="grid flex-1 items-center gap-12 py-20 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <p className="mb-6 text-sm font-medium uppercase tracking-[0.25em] text-amber-400">Para fotógrafos</p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[1.08] tracking-tight sm:text-7xl">
              Seu trabalho merece uma entrega à altura.
            </h1>
            <p className="mt-8 max-w-xl text-lg leading-8 text-stone-300">
              Organize galerias, compartilhe imagens e receba as escolhas dos seus clientes em um só lugar.
            </p>
            <Link href="/cadastro" className="button mt-10">Criar minha conta</Link>
            <p className="mt-4 text-sm text-stone-400">Acesso inicial: contas e workspaces. Galerias em desenvolvimento.</p>
          </div>
          <div aria-hidden="true" className="relative aspect-[4/5] overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-amber-100/90 via-stone-500 to-stone-900 shadow-2xl">
            <div className="absolute inset-8 rounded-t-full border border-white/35" />
            <div className="absolute inset-16 rounded-t-full border border-white/25" />
            <div className="absolute bottom-10 left-10 right-10 border-t border-white/50 pt-5 text-sm tracking-[0.2em] text-white">SUAS HISTÓRIAS, BEM APRESENTADAS</div>
          </div>
        </section>
        <footer className="border-t border-white/15 pt-6 text-sm text-stone-500">© {new Date().getFullYear()} Cartlio</footer>
      </div>
    </main>
  );
}

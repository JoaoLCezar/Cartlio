"use client";
export default function DashboardError({ reset }: { reset: () => void }) {
  return <section className="panel"><h2 className="mb-4 text-xl">Não foi possível carregar seus dados.</h2><p className="mb-6 text-stone-400">Tente novamente em alguns instantes.</p><button className="button" onClick={reset}>Tentar novamente</button></section>;
}

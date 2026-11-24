import Link from "next/link";
export default function GalleryNotFound() {
  return <section className="panel"><h1 className="mb-4 text-2xl font-semibold">Galeria não encontrada</h1><p className="mb-6 text-stone-400">Esta galeria não está disponível neste workspace.</p><Link href="/painel" className="button">Voltar ao painel</Link></section>;
}

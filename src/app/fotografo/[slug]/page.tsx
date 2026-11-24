import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { isPortfolioSlug } from "@/lib/portfolio";
import { shareLookupClient } from "@/lib/supabase/share";

export const dynamic = "force-dynamic";

type Portfolio = { display_name: string; bio: string; contact_email: string | null; photo_ids: string[] };
type Props = { params: Promise<{ slug: string }> };

const getPortfolio = cache(async (slug: string): Promise<Portfolio | null> => {
  if (!isPortfolioSlug(slug)) return null;
  const { data, error } = await shareLookupClient().rpc("get_public_portfolio", { p_slug: slug });
  if (error) throw new Error("Não foi possível carregar o portfólio.");
  return data;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const portfolio = await getPortfolio(slug);
  return portfolio
    ? { title: `${portfolio.display_name} | Quadrics`, description: portfolio.bio.slice(0, 160) || "Portfólio de fotografia." }
    : { title: "Portfólio indisponível | Quadrics", robots: { index: false } };
}

export default async function PortfolioPage({ params }: Props) {
  const { slug } = await params;
  const portfolio = await getPortfolio(slug);
  if (!portfolio) notFound();
  const [cover, ...photos] = portfolio.photo_ids;
  const imageUrl = (photoId: string) => `/fotografo/${slug}/imagem/${photoId}`;

  return <main className="mx-auto max-w-6xl space-y-12 px-5 py-10 sm:px-10 sm:py-16">
    <header className="space-y-5">
      <h1 className="max-w-4xl break-words text-4xl font-semibold sm:text-6xl">{portfolio.display_name}</h1>
      {portfolio.bio && <p className="max-w-2xl whitespace-pre-line break-words text-lg leading-relaxed">{portfolio.bio}</p>}
      {portfolio.contact_email && <a className="button-secondary" href={`mailto:${portfolio.contact_email}`}>Entrar em contato</a>}
    </header>
    {cover && <Image src={imageUrl(cover)} alt="Foto de capa do portfólio" width={1280} height={768}
      unoptimized className="max-h-[70vh] w-full rounded-2xl object-contain" />}
    {photos.length > 0 && <ul aria-label="Fotos do portfólio" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {photos.map((photoId, index) => <li key={photoId}>
        <Image src={imageUrl(photoId)} alt={`Foto ${index + 2} do portfólio`} width={640} height={480} unoptimized
          className="h-auto w-full rounded-xl" />
      </li>)}
    </ul>}
    <footer className="border-t border-stone-700 pt-6">
      <Link className="brand-wordmark" href="/" aria-label="Quadrics, início">quadrics<span>.</span></Link>
    </footer>
  </main>;
}

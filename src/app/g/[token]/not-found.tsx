import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Link indisponível | Quadrics",
  robots: { index: false, follow: false, noarchive: true },
};

export default function SharedGalleryNotFound() {
  return (
    <main className="gallery-public-shell gallery-unavailable-page">
      <div className="gallery-public-brand">
        <span className="brand-wordmark">quadrics<span>.</span></span>
        <span className="gallery-public-brand-note">Galerias para compartilhar</span>
      </div>
      <section className="gallery-unavailable-card" aria-labelledby="gallery-unavailable-title">
        <span className="gallery-unavailable-mark" aria-hidden="true">↗</span>
        <p className="gallery-unavailable-eyebrow">Acesso à galeria</p>
        <h1 id="gallery-unavailable-title">Este link não está disponível</h1>
        <p>Peça ao fotógrafo que compartilhe um novo link para acessar as fotos.</p>
      </section>
      <footer className="gallery-unavailable-footer">Quadrics · Galerias privadas de fotografia</footer>
    </main>
  );
}

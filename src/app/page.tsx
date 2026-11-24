import Link from "next/link";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <main className="homepage">
      <div className="homepage-inner">
        <header className="homepage-header">
          <Link href="/" className="brand-wordmark" aria-label="Quadrics, início">quadrics<span>.</span></Link>
          <Link href="/login">Entrar na sua conta <span aria-hidden="true">↗</span></Link>
        </header>

        <section className="homepage-hero">
          <div className="homepage-copy">
            <p className="eyebrow">Um novo jeito de entregar</p>
            <h1 className="homepage-title">Suas histórias merecem ser <em>vividas de novo.</em></h1>
            <p className="homepage-description">
              Um espaço bonito e simples para organizar seus ensaios, compartilhar galerias privadas e escolher entre receber uma seleção do cliente ou entregar todas as fotos.
            </p>
            <div className="homepage-actions">
              <Link href="/cadastro" className="button">Criar minha conta <span aria-hidden="true">↗</span></Link>
              <Link href="/login" className="button-secondary">Já tenho uma conta</Link>
            </div>
            <p className="homepage-note">Feito para fotógrafos que cuidam de cada detalhe.</p>
          </div>

          <div className="hero-art" aria-label="Prévia artística de uma galeria de fotografia" role="img">
            <div className="hero-art-backdrop" />
            <div className="hero-frame" />
            <div className="hero-caption">
              <span>Galeria de exemplo</span>
              <strong>Um dia para guardar</strong>
            </div>
          </div>
        </section>

        <section className="homepage-proof" aria-label="O que você pode fazer no Quadrics">
          <article>
            <small>01 — ORGANIZE</small>
            <h2>Clientes e galerias, juntos</h2>
            <p>Encontre cada trabalho com facilidade e mantenha tudo em ordem.</p>
          </article>
          <article>
            <small>02 — APRESENTE</small>
            <h2>Uma entrega à altura</h2>
            <p>Compartilhe uma experiência clara e acolhedora com seus clientes.</p>
          </article>
          <article>
            <small>03 — ENTREGUE</small>
            <h2>Você escolhe como entregar</h2>
            <p>Peça ao cliente que selecione as fotos ou disponibilize a galeria completa em um só link.</p>
          </article>
        </section>

        <footer className="homepage-footer">
          <span>© {new Date().getFullYear()} Quadrics</span>
          <span>Fotografias bem cuidadas, do começo ao fim.</span>
        </footer>
      </div>
    </main>
  );
}

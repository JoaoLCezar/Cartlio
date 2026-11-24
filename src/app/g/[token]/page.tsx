import { quadricsEnv } from "../../../../scripts/lib/quadrics-env.mjs";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import Image from "next/image";
import type { Metadata } from "next";
import { cache, type CSSProperties } from "react";
import { galleryPinSession } from "@/lib/gallery-pin";
import { shareLookupClient } from "@/lib/supabase/share";
import { GallerySelection } from "@/components/gallery-selection";
import { GalleryPinGate } from "@/components/gallery-pin-gate";
import { contrastTextColor } from "@/lib/brand-color";

export const dynamic = "force-dynamic";

type SharedGallery = { pin_required?: boolean; title: string; description: string | null; brand_name: string; brand_color: string; cover_photo_id: string | null; photo_count: number; selected_photo_ids: string[]; revision_message?: string | null; submitted_at: string | null; downloads_enabled: boolean; selection_limit: number; share_mode: "selection" | "delivery"; photos: { id: string; name: string; selected: boolean; client_note?: string | null }[] };

const getSharedGallery = cache(async (token: string, accessToken: string | null) => {
  try {
    const { data, error } = await shareLookupClient().rpc("get_shared_gallery", {
      p_token: token,
      p_access_token: accessToken,
    });
    return { gallery: data as SharedGallery | null, error: Boolean(error) };
  } catch {
    return { gallery: null, error: true };
  }
});

const getSharedBrandLogoStatus = cache(async (token: string, accessToken: string | null) => {
  try {
    const { data, error } = await shareLookupClient().rpc("get_shared_brand_logo_status", {
      p_token: token,
      p_access_token: accessToken,
    });
    return !error && data === true;
  } catch {
    return false;
  }
});

const privateMetadata: Metadata = {
  robots: { index: false, follow: false, noarchive: true },
};

async function publicImageUrl(path: string) {
  const configuredUrl = quadricsEnv("APP_URL")?.trim();
  if (configuredUrl) {
    try {
      const base = new URL(configuredUrl);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return null;
      return new URL(path, base).toString();
    } catch {
      return null;
    }
  }

  if (process.env.NODE_ENV === "production") return null;
  try {
    const requestHeaders = await headers();
    const host = requestHeaders.get("host");
    const protocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() || "http";
    if (!host || !["http", "https"].includes(protocol)) return null;
    const base = new URL(`${protocol}://${host}`);
    if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) return null;
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return { ...privateMetadata, title: "Galeria não encontrada | Quadrics" };
  }

  const { gallery, error } = await getSharedGallery(token, await galleryPinSession(token));
  if (error) {
    return { ...privateMetadata, title: "Galeria compartilhada | Quadrics" };
  }
  if (!gallery) {
    return { ...privateMetadata, title: "Galeria não encontrada | Quadrics" };
  }
  if (gallery.pin_required) {
    const title = "Galeria protegida | Quadrics";
    const description = "Digite o PIN enviado pelo fotógrafo para acessar esta galeria.";
    return {
      ...privateMetadata,
      title,
      description,
      openGraph: { title, description, type: "website" },
      twitter: { card: "summary", title, description },
    };
  }

  const studio = gallery.brand_name.trim() || "Quadrics";
  const title = `${gallery.title.trim()} | ${studio}`;
  const description = (gallery.description ?? "").trim().slice(0, 300)
    || `${studio} compartilhou uma galeria de fotos com você.`;
  const image = await publicImageUrl(`/g/${token}/share-card`);

  return {
    ...privateMetadata,
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: studio,
      type: "website",
      ...(image ? { images: [{ url: image, alt: title }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function SharedGalleryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();
  const { gallery, error } = await getSharedGallery(token, await galleryPinSession(token));
  if (error) throw new Error("Não foi possível abrir a galeria.");
  if (!gallery) notFound();
  if (gallery.pin_required) return <main className="gallery-public-shell">
    <div className="gallery-public-brand"><span className="brand-wordmark">quadrics<span>.</span></span><span className="gallery-public-brand-note">Uma galeria preparada para você</span></div>
    <GalleryPinGate token={token} />
  </main>;
  const hasBrandLogo = await getSharedBrandLogoStatus(token, await galleryPinSession(token));
  return <main className="gallery-public-shell" style={{ "--gallery-brand-color": gallery.brand_color } as CSSProperties}>
    <div className="gallery-public-brand">
      {hasBrandLogo
        ? <Image className="gallery-brand-mark" src={"/g/" + token + "/brand-logo"} alt={"Logo de " + gallery.brand_name} width={160} height={80} unoptimized />
        : <span className="gallery-public-studio" style={{ backgroundColor: gallery.brand_color, color: contrastTextColor(gallery.brand_color) }}>{gallery.brand_name}</span>}
      <span className="gallery-public-brand-note">Uma galeria preparada para você</span>
    </div>
    <header className="gallery-cover">
      {gallery.cover_photo_id && <Image
        className="gallery-cover-image"
        src={`/g/${token}/image/${gallery.cover_photo_id}?size=preview`}
        alt=""
        fill
        priority
        unoptimized
        sizes="(max-width: 800px) 100vw, 1480px"
      />}
      <div className="gallery-cover-shade" aria-hidden="true" />
      <div className="gallery-cover-content">
        <p className="gallery-cover-kicker">Galeria privada · {gallery.photo_count} {gallery.photo_count === 1 ? "foto" : "fotos"}</p>
        <h1>{gallery.title}</h1>
        {gallery.description && <p className="gallery-cover-description">{gallery.description}</p>}
        <a className="gallery-cover-cta" href="#gallery-photos">Ver galeria <span aria-hidden="true">↓</span></a>
      </div>
    </header>
    <GallerySelection token={token} photos={gallery.photos} photoCount={gallery.photo_count} selectedPhotoIds={gallery.selected_photo_ids} submittedAt={gallery.submitted_at} revisionMessage={gallery.revision_message ?? null} downloadsEnabled={gallery.downloads_enabled} selectionLimit={gallery.selection_limit} shareMode={gallery.share_mode} />
  </main>;
}

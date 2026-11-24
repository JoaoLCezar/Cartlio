import sharp, { type OverlayOptions } from "sharp";
import { galleryPinClientFingerprint } from "@/lib/gallery-pin-client";
import { shareLookupClient, shareStorageClient } from "@/lib/supabase/share";
import { createMediaReader } from "@/lib/media-storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const width = 1200;
const height = 630;
const maxCoverBytes = 12 * 1024 * 1024;
const maxLogoBytes = 3 * 1024 * 1024;
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

type SharedCardGallery = {
  pin_required?: boolean;
  title?: string;
  brand_name?: string;
  brand_color?: string;
  cover_photo_id?: string | null;
};

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]!);
}

function boundedText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}…` : normalized;
}

function titleLines(title: string) {
  const words = boundedText(title, 94).split(" ").filter(Boolean)
    .map(word => word.length > 32 ? `${word.slice(0, 31)}…` : word);
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.length - 1;
    if (lines.length < 2 && (last < 0 || `${lines[last]} ${word}`.trim().length <= 32)) {
      lines[last < 0 ? 0 : last] = last < 0 ? word : `${lines[last]} ${word}`;
    } else if (lines.length < 2) {
      lines.push(word);
    } else {
      lines[1] = boundedText(`${lines[1]} ${word}`, 32);
    }
  }
  return lines.length ? lines : ["Galeria de fotos"];
}

function fallbackBackground() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="base" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#243b34"/><stop offset="1" stop-color="#0d1714"/></linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#base)"/>
    <circle cx="1000" cy="80" r="310" fill="#78917f" opacity=".12"/>
    <circle cx="1090" cy="520" r="260" fill="#d5c8aa" opacity=".08"/>
  </svg>`);
}

function cardOverlay(brandName: string, title: string, brandColor: string, hasLogo: boolean) {
  const lines = titleLines(title);
  const lineY = lines.length === 1 ? [526] : [482, 540];
  const titleMarkup = lines.map((line, index) =>
    `<text x="76" y="${lineY[index]}" fill="#fff" font-family="Arial, sans-serif" font-size="54" font-weight="600" letter-spacing="-1">${escapeXml(line)}</text>`,
  ).join("");
  const studio = escapeXml(boundedText(brandName || "Quadrics", 44));

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#07110e" stop-opacity=".04"/><stop offset=".42" stop-color="#07110e" stop-opacity=".1"/><stop offset="1" stop-color="#07110e" stop-opacity=".86"/></linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#shade)"/>
    ${hasLogo ? '<rect x="922" y="70" width="202" height="104" rx="16" fill="#fff" fill-opacity=".94"/>' : ""}
    <rect x="76" y="388" width="7" height="34" rx="3.5" fill="${brandColor}"/>
    <text x="102" y="413" fill="#fff" font-family="Arial, sans-serif" font-size="25" font-weight="600" letter-spacing="1">${studio}</text>
    ${titleMarkup}
    <text x="76" y="590" fill="#fff" fill-opacity=".78" font-family="Arial, sans-serif" font-size="18" letter-spacing="2">UMA GALERIA PREPARADA PARA VOCÊ</text>
  </svg>`);
}

async function renderCard(source: Buffer | null, logo: Buffer | null, gallery: SharedCardGallery) {
  const color = /^#[\da-f]{6}$/i.test(gallery.brand_color ?? "") ? gallery.brand_color! : "#a68f6d";
  const background = source ?? fallbackBackground();
  const layers: OverlayOptions[] = [{ input: cardOverlay(gallery.brand_name ?? "Quadrics", gallery.title ?? "Galeria de fotos", color, Boolean(logo)) }];
  if (logo) {
    layers.push({
      input: await sharp(logo).rotate().resize(166, 80, { fit: "contain" }).png().toBuffer(),
      left: 940,
      top: 82,
    });
  }
  return sharp(background)
    .resize(width, height, { fit: "cover", position: "attention" })
    .composite(layers)
    .jpeg({ quality: 88, progressive: true, mozjpeg: true })
    .toBuffer();
}

function imageResponse(body: Buffer, status = 200) {
  return new Response(new Uint8Array(body), {
    status,
    headers: { ...headers, "Content-Type": "image/jpeg" },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) return new Response(null, { status: 404, headers });

  let lookup;
  let storage;
  try {
    lookup = shareLookupClient();
    storage = shareStorageClient();
  } catch {
    return new Response("Prévia social indisponível.", { status: 503, headers });
  }

  let resolved;
  try {
    resolved = await lookup.rpc("get_shared_gallery", { p_token: token, p_access_token: null });
  } catch {
    return new Response("Prévia social indisponível.", { status: 503, headers });
  }
  if (resolved.error) return new Response("Prévia social indisponível.", { status: 503, headers });
  if (!resolved.data || typeof resolved.data !== "object") return new Response(null, { status: 404, headers });

  const gallery = resolved.data as SharedCardGallery;
  if (gallery.pin_required) return new Response(null, { status: 404, headers });
  if (typeof gallery.title !== "string") return new Response(null, { status: 404, headers });

  let cover: Buffer | null = null;
  let logo: Buffer | null = null;
  if (gallery.cover_photo_id) {
    const fingerprint = galleryPinClientFingerprint(request);
    if (!fingerprint && process.env.NODE_ENV === "production") {
      return new Response("Não foi possível validar a origem da solicitação.", { status: 503, headers });
    }
    try {
      const media = createMediaReader(storage);
      const authorized = await storage.rpc("authorize_shared_photo_image", {
        p_token: token,
        p_photo_id: gallery.cover_photo_id,
        p_access_token: null,
        p_client_fingerprint: fingerprint,
      });
      if (authorized.error) return new Response("Prévia social indisponível.", { status: 503, headers });
      if (authorized.data?.rate_limited === true) {
        const retryAfter = typeof authorized.data.retry_after === "number"
          ? Math.max(1, Math.min(60, Math.ceil(authorized.data.retry_after)))
          : 60;
        return new Response("Muitas solicitações de imagens.", {
          status: 429,
          headers: { ...headers, "Retry-After": String(retryAfter) },
        });
      }
      if (typeof authorized.data?.path !== "string"
        || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}[.]webp$/.test(authorized.data.path)) {
        return new Response(null, { status: 404, headers });
      }
      const downloaded = await media.readImage("preview", authorized.data.path);
      if (downloaded && downloaded.size <= maxCoverBytes) {
        cover = Buffer.from(await downloaded.arrayBuffer());
      }

      const authorizedLogo = await storage.rpc("authorize_shared_brand_logo", {
        p_token: token,
        p_access_token: null,
        p_client_fingerprint: fingerprint,
      });
      if (authorizedLogo.error) return new Response("Prévia social indisponível.", { status: 503, headers });
      if (authorizedLogo.data?.rate_limited === true) {
        const retryAfter = typeof authorizedLogo.data.retry_after === "number"
          ? Math.max(1, Math.min(60, Math.ceil(authorizedLogo.data.retry_after)))
          : 60;
        return new Response("Muitas solicitações de imagens.", {
          status: 429,
          headers: { ...headers, "Retry-After": String(retryAfter) },
        });
      }
      if (typeof authorizedLogo.data?.path === "string"
        && /^[0-9a-f-]{36}\/[0-9a-f-]{36}[.]webp$/.test(authorizedLogo.data.path)) {
        const downloadedLogo = await media.readImage("studioLogo", authorizedLogo.data.path);
        if (downloadedLogo && downloadedLogo.size <= maxLogoBytes) {
          logo = Buffer.from(await downloadedLogo.arrayBuffer());
        }
      }
    } catch {
      // A missing or oversized preview falls back to the photographer-branded text card.
    }
  }

  try {
    return imageResponse(await renderCard(cover, logo, gallery));
  } catch {
    return new Response("Prévia social indisponível.", { status: 503, headers });
  }
}

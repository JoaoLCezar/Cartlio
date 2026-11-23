import sharp from "sharp";

const pixelLimit = 40_000_000;
export const inputLimit = 50 * 1024 * 1024;

export class InvalidPhotoError extends Error {}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]);
}

export function watermarkSvg(text, width, height) {
  const label = [...String(text ?? "").trim()].slice(0, 60).join("") || "PROVA";
  const safeLabel = escapeXml(label);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="watermark" width="520" height="220" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)"><text x="260" y="120" text-anchor="middle" textLength="440" lengthAdjust="spacingAndGlyphs" font-family="Arial, sans-serif" font-size="30" font-weight="700" letter-spacing="2" fill="#ffffff" fill-opacity="0.40" stroke="#1c1917" stroke-opacity="0.24" stroke-width="1.5" paint-order="stroke">${safeLabel}</text></pattern></defs><rect width="100%" height="100%" fill="url(#watermark)"/></svg>`);
}

export async function renderWatermarkedImages(bytes, declaredType, watermarkText) {
  let info;
  try {
    info = await sharp(bytes, { limitInputPixels: pixelLimit, failOn: "error" }).metadata();
  } catch { throw new InvalidPhotoError("Imagem não decodificável."); }
  if (info.mediaType !== declaredType || !info.width || !info.height || info.width * info.height > pixelLimit) {
    throw new InvalidPhotoError("Formato ou dimensões inválidos.");
  }
  try {
    const options = { limitInputPixels: pixelLimit, failOn: "error" };
    const previewBase = await sharp(bytes, options).autoOrient().timeout({ seconds: 10 })
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png().toBuffer({ resolveWithObject: true });
    const preview = await sharp(previewBase.data).timeout({ seconds: 10 })
      .composite([{ input: watermarkSvg(watermarkText, previewBase.info.width, previewBase.info.height) }])
      .webp({ quality: 78, effort: 4 }).toBuffer();
    const thumbnailBase = await sharp(bytes, options).autoOrient().timeout({ seconds: 10 })
      .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
      .png().toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(thumbnailBase.data).timeout({ seconds: 10 })
      .composite([{ input: watermarkSvg(watermarkText, thumbnailBase.info.width, thumbnailBase.info.height) }])
      .webp({ quality: 72, effort: 4 }).toBuffer();
    return { preview, thumbnail, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof InvalidPhotoError) throw error;
    throw new InvalidPhotoError("Imagem não decodificável ou acima do tempo permitido.");
  }
}

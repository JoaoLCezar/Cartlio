export const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;
export const MAX_PHOTOS_PER_BATCH = 20;
export const MAX_BATCH_BYTES = 100 * 1024 * 1024;

export function validPhotoSignature(type: string, bytes: Uint8Array) {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  return false;
}

export function validatePhotoSelection(files: readonly { type: string; size: number }[]) {
  if (files.length === 0) return "Selecione pelo menos uma imagem.";
  if (files.length > MAX_PHOTOS_PER_BATCH) return `Envie no máximo ${MAX_PHOTOS_PER_BATCH} imagens por vez.`;
  if (files.some(file => !["image/jpeg", "image/png"].includes(file.type))) return "Use arquivos JPEG ou PNG.";
  if (files.some(file => file.size <= 0 || file.size > MAX_PHOTO_BYTES)) return "Cada imagem deve ter até 50 MiB.";
  if (files.reduce((total, file) => total + file.size, 0) > MAX_BATCH_BYTES) return "O total de cada envio deve ser de até 100 MiB.";
  return null;
}

export function validatePhotoQuota(files: readonly { size: number }[], availableBytes: number) {
  if (!Number.isFinite(availableBytes) || availableBytes < 0) {
    return "Não foi possível confirmar o espaço disponível. Atualize a galeria e tente novamente.";
  }

  let remainingBytes = Math.floor(availableBytes);
  for (let index = 0; index < files.length; index++) {
    if (remainingBytes < MAX_PHOTO_BYTES) {
      return index === 0
        ? "Libere pelo menos 50 MiB antes de iniciar um novo envio."
        : `O espaço disponível permite iniciar apenas ${index} ${index === 1 ? "imagem" : "imagens"} deste lote. Envie menos arquivos ou libere espaço.`;
    }
    remainingBytes -= files[index].size;
  }

  return null;
}

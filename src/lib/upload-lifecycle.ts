export type UploadSession = {
  id: string;
  object_path: string;
  storage_provider: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  state: "reserved" | "completed" | "canceling" | "canceled";
  expires_at: string;
};

export type StorageUsage = { limit_bytes: number; used_bytes: number; reserved_bytes: number; available_bytes: number };

export function uploadError(message: string) {
  if (message.includes("STORAGE_QUOTA_EXCEEDED")) return "Não há espaço disponível para outro envio. Conclua ou descarte envios pendentes, ou exclua fotos para liberar espaço.";
  if (message.includes("UPLOAD_CLOSED")) return "O prazo deste envio terminou ou ele foi cancelado. Descarte a pendência e inicie um novo envio.";
  if (message.includes("UPLOAD_MISSING")) return "O arquivo ainda não chegou ao armazenamento. Selecione o arquivo para reenviar.";
  if (message.includes("UPLOAD_MISMATCH")) return "O arquivo recebido não corresponde ao tamanho ou tipo reservado. Descarte este envio e tente novamente.";
  if (message.includes("UPLOAD_PROVIDER_UNSUPPORTED")) return "O armazenamento deste envio ainda não está disponível.";
  if (message.includes("GALLERY_ARCHIVED")) return "Desarquive a galeria antes de concluir ou iniciar envios.";
  return "Não foi possível concluir o envio. Confira os envios pendentes e tente novamente.";
}

export function normalizedPhotoFilename(name: string) {
  return Array.from(name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "_").trim()).slice(0, 255).join("").trim() || "imagem";
}

export function formatStorageBytes(bytes: number) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GiB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

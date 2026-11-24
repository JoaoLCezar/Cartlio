export function whatsappMessageUrl(text: string, phone: string | null = null) {
  const recipient = phone && /^\+[1-9][0-9]{7,14}$/.test(phone) ? phone.slice(1) : "";
  return `https://wa.me/${recipient}?text=${encodeURIComponent(text)}`;
}

export function gallerySelectionRevisionWhatsAppUrl(
  galleryTitle: string,
  revisionMessage: string,
  pinEnabled: boolean,
  customerWhatsAppPhone: string | null = null,
) {
  const pinNote = pinEnabled ? " Se a galeria solicitar um PIN, use o código que enviei separadamente." : "";
  const text = `Olá! Peço que revise a seleção da galeria “${galleryTitle}”. Orientação: ${revisionMessage} Abra novamente o mesmo link para ajustar as fotos e enviar a nova seleção. Se o link tiver vencido, responda a esta mensagem para combinarmos um novo acesso.${pinNote}`;
  return whatsappMessageUrl(text, customerWhatsAppPhone);
}

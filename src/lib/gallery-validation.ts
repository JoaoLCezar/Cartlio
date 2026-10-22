export const galleryStatuses = { draft: "Rascunho", published: "Publicada", archived: "Arquivada" } as const;
export type GalleryStatus = keyof typeof galleryStatuses;
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (data: FormData, key: string) => typeof data.get(key) === "string" ? String(data.get(key)).trim() : "";
const length = (value: string) => [...value].length;
export function parseCustomer(data: FormData) {
  const name = text(data, "name");
  const email = text(data, "email").toLowerCase();
  if (!name || length(name) > 120) return { error: "Informe um nome de até 120 caracteres." } as const;
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: "Informe um e-mail válido ou deixe o campo vazio." } as const;
  return { value: { name, email: email || null } } as const;
}
export function parseGallery(data: FormData) {
  const title = text(data, "title");
  const slug = text(data, "slug").toLowerCase();
  const description = text(data, "description");
  const customer_id = text(data, "customer_id") || null;
  const status = text(data, "status");
  if (!title || length(title) > 120) return { error: "Informe um título de até 120 caracteres." } as const;
  if (slug.length < 3 || slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { error: "Use um endereço de 3 a 80 caracteres, com letras, números e hífens entre palavras." } as const;
  if (length(description) > 2000) return { error: "A descrição deve ter até 2.000 caracteres." } as const;
  if (customer_id && !isUuid(customer_id)) return { error: "Selecione um cliente válido." } as const;
  if (!Object.hasOwn(galleryStatuses, status)) return { error: "Selecione um status válido." } as const;
  return { value: { title, slug, description, customer_id, status: status as GalleryStatus } } as const;
}

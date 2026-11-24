export type GallerySelectionCsvItem = { photo_id: string; original_filename: string; client_note?: string | null };

function csvCell(value: string): string {
  const safeValue = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

export function gallerySelectionCsv(items: GallerySelectionCsvItem[]): string {
  const rows = [
    ["Nº", "Arquivo original", "Observação do cliente", "ID da foto"],
    ...items.map((item, index) => [String(index + 1), item.original_filename, item.client_note ?? "", item.photo_id]),
  ];
  return `\uFEFF${rows.map(row => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

export function gallerySelectionCsvFilename(galleryTitle: string): string {
  const slug = galleryTitle.normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "") || "galeria";
  return `selecao-${slug}.csv`;
}

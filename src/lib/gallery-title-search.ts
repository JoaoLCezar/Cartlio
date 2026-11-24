export function galleryTitleSearchPattern(query: string): string | null {
  const term = query.trim();
  if (!term) return null;
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

import Link from "next/link";

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  firstItem,
  lastItem,
  hrefForPage,
  label,
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  firstItem: number;
  lastItem: number;
  hrefForPage: (page: number) => string;
  label: string;
}) {
  if (totalPages <= 1) return null;

  return <nav className="mt-6 flex flex-wrap items-center justify-between gap-4" aria-label={label}>
    <p className="text-sm text-stone-400">Mostrando {firstItem}–{lastItem} de {totalItems}</p>
    <div className="flex items-center gap-3">
      {currentPage > 1
        ? <Link className="button-secondary" href={hrefForPage(currentPage - 1)}>Anterior</Link>
        : <span className="button-secondary cursor-not-allowed opacity-50" aria-disabled="true">Anterior</span>}
      <span className="text-sm text-stone-300">Página {currentPage} de {totalPages}</span>
      {currentPage < totalPages
        ? <Link className="button-secondary" href={hrefForPage(currentPage + 1)}>Próxima</Link>
        : <span className="button-secondary cursor-not-allowed opacity-50" aria-disabled="true">Próxima</span>}
    </div>
  </nav>;
}

export function isPortfolioSlug(value: string) {
  return value.length >= 3 && value.length <= 48 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

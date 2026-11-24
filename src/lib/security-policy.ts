function httpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(
  nonce: string,
  options: { development?: boolean; supabaseUrl?: string; storageUrl?: string } = {},
) {
  const externalOrigins = [...new Set([
    httpOrigin(options.supabaseUrl),
    httpOrigin(options.storageUrl),
  ].filter((origin): origin is string => origin !== null))];

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // The studio branding preview and public gallery use validated inline colors.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: ${externalOrigins.join(" ")}`.trim(),
    "font-src 'self' data:",
    `connect-src 'self' ${externalOrigins.join(" ")}`.trim(),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

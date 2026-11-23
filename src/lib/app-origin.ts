import { quadricsEnv } from "../../scripts/lib/quadrics-env.mjs";
type HeaderReader = Pick<Headers, "get">;

export function trustedAppOrigin(
  requestHeaders: HeaderReader,
  options: { canonicalUrl?: string; production?: boolean } = {},
): string | null {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const canonicalUrl = (options.canonicalUrl ?? quadricsEnv("APP_URL"))?.trim();

  if (canonicalUrl) {
    try {
      const parsed = new URL(canonicalUrl);
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
      const loopbackHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      if (production && parsed.protocol !== "https:" && !loopbackHttp) return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  // Never build email links from proxy headers in production. A canonical origin
  // must be configured so an untrusted Host header cannot poison auth links.
  if (production) return null;

  const origin = requestHeaders.get("origin");
  const host = requestHeaders.get("host")?.trim().toLowerCase();
  if (!origin || !host) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.host.toLowerCase() !== host) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

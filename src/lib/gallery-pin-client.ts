import { quadricsEnv } from "../../scripts/lib/quadrics-env.mjs";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const trustedClientIpHeaders = new Set(["cf-connecting-ip", "x-real-ip", "x-forwarded-for"]);

function normalizeAddress(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  const address = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return isIP(address) ? address.toLowerCase() : null;
}

export function galleryClientIpConfigurationReady() {
  if (process.env.NODE_ENV !== "production") return true;
  const header = quadricsEnv("TRUSTED_CLIENT_IP_HEADER")?.trim().toLowerCase();
  return Boolean(header && trustedClientIpHeaders.has(header));
}

export function galleryPinClientFingerprint(request: Pick<Request, "headers">) {
  const secret = process.env.SUPABASE_SERVER_SECRET_KEY;
  if (!secret) return null;

  const configuredHeader = quadricsEnv("TRUSTED_CLIENT_IP_HEADER");
  if (configuredHeader !== undefined || process.env.NODE_ENV === "production") {
    const header = configuredHeader?.trim().toLowerCase();
    if (!header || !trustedClientIpHeaders.has(header)) return null;
    const rawAddress = request.headers.get(header);
    // A trusted proxy must overwrite the selected header with one client address.
    // Reject forwarded chains because their untrusted portion depends on proxy topology.
    if (!rawAddress || rawAddress.includes(",")) return null;
    const address = normalizeAddress(rawAddress);
    return address ? createHmac("sha256", secret).update(address).digest("hex") : null;
  }

  const forwarded = request.headers.get("x-forwarded-for")?.split(",").reverse() ?? [];
  const candidates = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("x-real-ip"),
    ...forwarded,
  ];
  const address = candidates.map(normalizeAddress).find((candidate): candidate is string => candidate !== null);
  if (!address) return null;

  return createHmac("sha256", secret).update(address).digest("hex");
}

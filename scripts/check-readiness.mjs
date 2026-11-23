import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "http://127.0.0.1:3000/api/ready";
const MAX_RESPONSE_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 5000;

export function parseReadinessUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Readiness URL must be an absolute HTTP(S) URL.");
  }

  const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/api/ready") {
    throw new Error("Use an HTTPS URL ending in /api/ready (HTTP is allowed on loopback only).");
  }
  return url;
}

export async function checkReadiness(value, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = parseReadinessUrl(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Readiness timeout must be between 1 and 30000 milliseconds.");
  }

  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Readiness endpoint returned an oversized response.");
  }
  const bodyText = await response.text();
  if (Buffer.byteLength(bodyText, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Readiness endpoint returned an oversized response.");
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`Readiness endpoint returned invalid JSON (HTTP ${response.status}).`);
  }

  const checks = body?.checks;
  const database = checks?.database === "ok" ? "ok" : "unavailable";
  const storage = checks?.storage === "ok" ? "ok" : "unavailable";
  const clientIp = checks?.clientIp === "ok" ? "ok" : "misconfigured";
  if (response.status !== 200 || body?.status !== "ready" || database !== "ok" || storage !== "ok" || clientIp !== "ok") {
    throw new Error(`Readiness failed (HTTP ${response.status}; database=${database}; storage=${storage}; client_ip=${clientIp}).`);
  }
  return { status: "ready", database, storage, clientIp };
}

function argumentsFrom(argv) {
  const options = { url: process.env.READINESS_URL || DEFAULT_URL, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url" && argv[index + 1]) {
      options.url = argv[++index];
    } else if (argument === "--timeout-ms" && argv[index + 1]) {
      options.timeoutMs = Number(argv[++index]);
    } else {
      throw new Error("Usage: node scripts/check-readiness.mjs [--url URL] [--timeout-ms 1..30000]");
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = argumentsFrom(process.argv.slice(2));
    const result = await checkReadiness(options.url, { timeoutMs: options.timeoutMs });
    process.stdout.write(`Readiness ${result.status} (database=${result.database}, storage=${result.storage}, client_ip=${result.clientIp})\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Readiness check failed."}\n`);
    process.exitCode = 1;
  }
}

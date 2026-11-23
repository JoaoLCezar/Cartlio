import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

function localCredentials() {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"],
  }).replace(/^\uFEFF/, ""));
  return { url: status.API_URL, key: status.SERVICE_ROLE_KEY };
}

function remoteCredentials() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVER_SECRET_KEY;
  if (!url || !key) throw new Error("Remote maintenance credentials are missing.");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("Remote Supabase URL must use HTTPS.");
  }
  return { url: parsed.origin, key };
}

export function maintenanceClient(mode) {
  if (!new Set(["--local", "--remote"]).has(mode)) throw new Error("Maintenance mode must be explicit.");
  const { url, key } = mode === "--local" ? localCredentials() : remoteCredentials();
  return createClient(url, key, { auth: { persistSession: false } });
}

import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./config";

export function shareLookupClient(fetchImpl?: typeof fetch) {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase não configurado.");
  // No cookies: a public share is authorized only by its token in the RPC.
  return createClient(config.url, config.key, {
    auth: { persistSession: false }, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

export function shareStorageClient(fetchImpl?: typeof fetch) {
  const config = supabaseConfig();
  const key = process.env.SUPABASE_SERVER_SECRET_KEY;
  if (!config || !key) throw new Error("Storage de compartilhamento não configurado.");
  // Callers use this only after authorization checks before touching private gallery assets.
  return createClient(config.url, key, {
    auth: { persistSession: false }, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

export function sharePinClient(fetchImpl?: typeof fetch) {
  const config = supabaseConfig();
  const key = process.env.SUPABASE_SERVER_SECRET_KEY;
  if (!config || !key) throw new Error("Cliente de PIN da galeria não configurado.");
  return createClient(config.url, key, {
    auth: { persistSession: false }, ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./config";

export function workspaceAssetStorageClient() {
  const config = supabaseConfig();
  const key = process.env.SUPABASE_SERVER_SECRET_KEY;
  if (!config || !key) throw new Error("Storage de marca não configurado.");
  // Use only after the caller verifies workspace membership and a database-scoped asset path.
  return createClient(config.url, key, { auth: { persistSession: false } });
}

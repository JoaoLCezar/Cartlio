import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./config";

export function createServiceClient() {
  const config = supabaseConfig();
  const key = process.env.SUPABASE_SERVER_SECRET_KEY;
  if (!config || !key) throw new Error("Supabase administrativo não configurado.");
  return createClient(config.url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseConfig } from "./config";

export function createClient() {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase não configurado.");
  return createBrowserClient(config.url, config.key);
}

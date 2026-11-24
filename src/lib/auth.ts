import "server-only";
import { redirect } from "next/navigation";
import { supabaseConfig } from "./supabase/config";
import { createClient } from "./supabase/server";

export async function requireUser() {
  if (!supabaseConfig()) redirect("/login");
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  return { supabase, user };
}

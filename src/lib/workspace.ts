import "server-only";
import { notFound } from "next/navigation";
import { requireUser } from "./auth";
import { isUuid } from "./gallery-validation";
export async function requireWorkspace(id: string) {
  const { supabase, user } = await requireUser();
  if (!isUuid(id)) notFound();
  const { data: tenant, error } = await supabase.from("tenants").select("id, name, slug").eq("id", id).maybeSingle();
  if (error) throw new Error("Não foi possível carregar o workspace.");
  if (!tenant) notFound();
  return { supabase, user, tenant };
}

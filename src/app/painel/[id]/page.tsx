import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const { data: tenant, error } = await supabase.from("tenants").select("name, slug").eq("id", id).maybeSingle();
  if (error) throw new Error("Não foi possível carregar o workspace.");
  if (!tenant) notFound();
  return <><Link href="/painel" className="text-sm text-amber-300 underline">Todos os workspaces</Link><h1 className="mb-3 mt-8 text-4xl font-semibold">{tenant.name}</h1><p className="mb-10 text-stone-400">{tenant.slug}</p><section className="panel"><h2 className="mb-3 text-xl font-semibold">Seu espaço está pronto</h2><p className="text-stone-400">As galerias e os envios de fotos estarão disponíveis em uma próxima etapa.</p></section></>;
}

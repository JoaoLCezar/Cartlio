import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { createWorkspace, saveProfile } from "./actions";

export default async function DashboardPage() {
  const { supabase, user } = await requireUser();
  const [profile, tenants] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
    supabase.from("tenants").select("id, name, slug").order("created_at"),
  ]);
  if (profile.error || tenants.error) throw new Error("Não foi possível carregar o painel.");
  return <>
    <p className="mb-3 text-sm uppercase tracking-widest text-amber-300">Seu painel</p>
    <h1 className="mb-10 text-4xl font-semibold">{profile.data ? `Olá, ${profile.data.display_name}` : "Vamos começar?"}</h1>
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="panel"><h2 className="mb-6 text-xl font-semibold">Seus workspaces</h2>
        {tenants.data.length ? <ul className="space-y-3">{tenants.data.map(tenant => <li key={tenant.id}><Link className="block rounded-xl border border-white/15 p-4 hover:border-amber-300" href={`/painel/${tenant.id}`}><span className="block font-medium">{tenant.name}</span><span className="text-sm text-stone-400">{tenant.slug}</span></Link></li>)}</ul> : <p className="text-stone-400">Você ainda não tem um workspace. Crie o espaço do seu estúdio para começar.</p>}
      </section>
      <section className="panel"><h2 className="mb-6 text-xl font-semibold">Seu perfil</h2><ActionForm action={saveProfile} label="Salvar perfil"><label className="field">Como podemos chamar você?<input name="display_name" required maxLength={120} autoComplete="name" defaultValue={profile.data?.display_name ?? ""} /></label></ActionForm></section>
      <section className="panel lg:col-span-2"><h2 className="mb-2 text-xl font-semibold">Criar workspace</h2><p className="mb-6 text-sm text-stone-400">Um espaço independente para seu trabalho ou estúdio.</p><ActionForm action={createWorkspace} label="Criar workspace">
        <label className="field">Nome do estúdio<input name="name" required maxLength={120} placeholder="Estúdio Aurora" /></label>
        <label className="field">Endereço do workspace<input name="slug" required minLength={3} maxLength={48} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="estudio-aurora" aria-describedby="slug-hint" /></label>
        <p id="slug-hint" className="text-sm text-stone-400">Use letras minúsculas, números e hífens entre palavras. O endereço deve ser único.</p>
      </ActionForm></section>
    </div>
  </>;
}

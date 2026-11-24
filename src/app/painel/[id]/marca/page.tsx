import { WorkspaceBrandEditor } from "@/components/workspace-brand-editor";
import { requireWorkspace } from "@/lib/workspace";
import { saveWorkspaceBrand, saveWorkspaceLogo } from "../actions";

export default async function WorkspaceBrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user, tenant } = await requireWorkspace(id);
  const [settingsResult, membershipResult] = await Promise.all([
    supabase.from("tenants").select("public_brand_name, brand_color, brand_logo_path").eq("id", id).single(),
    supabase.from("tenant_members").select("role").eq("tenant_id", id).eq("user_id", user.id).single(),
  ]);
  if (settingsResult.error || membershipResult.error) throw new Error("Não foi possível carregar a identidade do estúdio.");
  const settings = settingsResult.data;
  const isOwner = membershipResult.data.role === "owner";

  return <section className="panel max-w-2xl space-y-7">
    <header>
      <p className="eyebrow">Experiência do cliente</p>
      <h1 className="mt-2 text-3xl font-semibold">Marca do estúdio</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-stone-400">Personalize o nome e a cor que aparecem no topo das galerias compartilhadas. Se o nome ficar vazio, mostramos Quadrics e mantemos o nome interno do workspace privado.</p>
    </header>
    <WorkspaceBrandEditor
      action={saveWorkspaceBrand.bind(null, id)}
      logoAction={saveWorkspaceLogo.bind(null, id)}
      brandName={settings.public_brand_name ?? ""}
      brandColor={settings.brand_color}
      brandLogoPath={settings.brand_logo_path ?? null}
      tenantId={id}
      workspaceName={tenant.name}
      canEdit={isOwner}
    />
  </section>;
}

import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Pagination } from "@/components/pagination";
import { createMediaReader } from "@/lib/media-storage";
import { requireWorkspace } from "@/lib/workspace";
import { savePortfolio, setPortfolioPhoto } from "./actions";

const pageSize = 24;
type Photo = { id: string; gallery_id: string; original_filename: string };

export default async function PortfolioEditorPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pagina?: string }>;
}) {
  const { id } = await params;
  const { supabase, user, tenant } = await requireWorkspace(id);
  const membership = await supabase.from("tenant_members").select("role")
    .eq("tenant_id", id).eq("user_id", user.id).single();
  if (membership.error) throw new Error("Não foi possível verificar as permissões do estúdio.");
  if (membership.data.role !== "owner") notFound();

  const { data: portfolio, error } = await supabase.from("photographer_portfolios")
    .select("display_name,bio,contact_email,published,photo_ids").eq("tenant_id", id).maybeSingle();
  if (error) throw new Error("Não foi possível carregar o portfólio.");

  const { pagina } = await searchParams;
  const page = pagina === undefined ? 1 : Number(pagina);
  if (!Number.isInteger(page) || page < 1 || page > 10000) notFound();
  const start = (page - 1) * pageSize;
  const readyPhotos = () => supabase.from("photos").select("id,gallery_id,original_filename")
    .eq("tenant_id", id).eq("processing_status", "ready").is("deletion_requested_at", null);
  let photos: Photo[] = [];
  const selected: Photo[] = [];
  let count = 0;
  if (portfolio) {
    const [catalog, chosen] = await Promise.all([
      supabase.from("photos").select("id,gallery_id,original_filename", { count: "exact" })
        .eq("tenant_id", id).eq("processing_status", "ready").is("deletion_requested_at", null)
        .order("created_at", { ascending: false }).order("id").range(start, start + pageSize - 1),
      portfolio.photo_ids.length > 0 ? readyPhotos().in("id", portfolio.photo_ids) : null,
    ]);
    if (catalog.error || chosen?.error) throw new Error("Não foi possível carregar as fotos do portfólio.");
    photos = catalog.data;
    const chosenById = new Map(chosen?.data?.map(photo => [photo.id, photo]));
    for (const photoId of portfolio.photo_ids as string[]) {
      const photo = chosenById.get(photoId);
      if (photo) selected.push(photo);
    }
    count = catalog.count ?? 0;
    if (page > Math.max(1, Math.ceil(count / pageSize))) notFound();
  }

  const selectedIds = new Set(selected.map(photo => photo.id));
  const pathFor = (photo: Photo) => `${id}/${photo.gallery_id}/${photo.id}.webp`;
  const previews = await createMediaReader(supabase).signPaths("thumbnail", [...photos, ...selected].map(pathFor), 900);

  function photoCard(photo: Photo, include: boolean) {
    const preview = previews.get(pathFor(photo));
    return <li key={photo.id} className="space-y-3 rounded-xl border border-stone-700 p-3">
      {preview ? <Image src={preview} alt="" width={320} height={240} unoptimized
        className="aspect-[4/3] w-full rounded-lg object-cover" /> :
        <div className="grid aspect-[4/3] place-items-center rounded-lg bg-stone-800 text-sm">Prévia indisponível</div>}
      <p className="break-all text-sm">{photo.original_filename}</p>
      {include && selectedIds.has(photo.id) ? <p className="text-sm text-stone-400">Adicionada</p> :
        <ActionForm action={setPortfolioPhoto.bind(null, id, photo.id, include)} label={include ? "Adicionar" : "Remover"}>
          {null}
        </ActionForm>}
    </li>;
  }

  const publicPath = `/fotografo/${tenant.slug}`;
  return <div className="space-y-8">
    <section className="panel max-w-2xl space-y-6">
      <h1 className="text-3xl font-semibold">Portfólio público</h1>
      <p className="break-all text-sm">Endereço: {portfolio?.published ?
        <Link className="underline" href={publicPath}>{publicPath}</Link> : publicPath}</p>
      <ActionForm action={savePortfolio.bind(null, id)} label="Salvar portfólio">
        <label className="field">Nome público <input name="name" defaultValue={portfolio?.display_name ?? ""} required maxLength={120} /></label>
        <label className="field">Apresentação <textarea name="bio" defaultValue={portfolio?.bio ?? ""} maxLength={1200} rows={5} /></label>
        <label className="field">E-mail de contato público <input name="email" type="email" defaultValue={portfolio?.contact_email ?? ""} maxLength={254} /></label>
        <label className="flex items-center gap-3">
          <input name="published" type="checkbox" defaultChecked={portfolio?.published ?? false} />
          Disponibilizar o portfólio ao público
        </label>
      </ActionForm>
    </section>
    {portfolio && <>
      <section className="panel space-y-4">
        <h2 className="text-xl font-semibold">Fotos selecionadas ({selected.length}/12)</h2>
        <p className="text-sm">A primeira foto é a capa. Quando o portfólio está publicado, alterações nesta seleção aparecem na página pública.</p>
        {selected.length > 0 && <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {selected.map(photo => photoCard(photo, false))}
        </ul>}
      </section>
      <section className="panel space-y-4">
        <h2 className="text-xl font-semibold">Escolher fotos das galerias</h2>
        {photos.length ? <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{photos.map(photo => photoCard(photo, true))}</ul>
          : <p className="text-sm">As fotos aparecerão aqui depois de concluído o processamento.</p>}
        <Pagination currentPage={page} totalPages={Math.ceil(count / pageSize)} totalItems={count}
          firstItem={start + 1} lastItem={start + photos.length} label="Páginas de fotos"
          hrefForPage={nextPage => `/painel/${id}/portfolio?pagina=${nextPage}`} />
      </section>
    </>}
  </div>;
}

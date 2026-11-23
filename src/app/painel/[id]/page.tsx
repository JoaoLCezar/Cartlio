import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/workspace";
import { galleryStatuses, isUuid, type GalleryStatus } from "@/lib/gallery-validation";
import { galleryTitleSearchPattern } from "@/lib/gallery-title-search";
import { createMediaReader } from "@/lib/media-storage";
import { formatStorageBytes, type StorageUsage } from "@/lib/upload-lifecycle";
import { Pagination } from "@/components/pagination";
import { CustomerPicker } from "@/components/customer-picker";

const pageSize = 25;

type GalleryOperations = {
  id: string;
  title: string;
  uploads_pending: number;
  uploads_expired: number;
  uploads_canceling: number;
  photos_pending: number;
  photos_processing: number;
  photos_failed: number;
  photos_deleting: number;
};

type GalleryCover = { gallery_id: string; photo_id: string | null };

type WorkspaceOperations = {
  uploads_pending: number;
  uploads_expired: number;
  uploads_canceling: number;
  photos_pending: number;
  photos_processing: number;
  photos_failed: number;
  photos_deleting: number;
  selections_received: number;
  selection_inbox: {
    share_id: string;
    gallery_id: string;
    gallery_title: string;
    submitted_at: string;
    submitted_name: string;
    selected_count: number;
  }[];
  galleries: GalleryOperations[];
};

type OperationCountKey = Exclude<keyof GalleryOperations, "id" | "title">;
type WorkspacePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string | string[]; status?: string | string[]; customer?: string | string[]; page?: string | string[] }>;
};

const labels: [OperationCountKey, string][] = [
  ["uploads_pending", "envios em aberto"],
  ["uploads_expired", "envios expirados"],
  ["uploads_canceling", "envios aguardando descarte"],
  ["photos_pending", "fotos aguardando processamento"],
  ["photos_processing", "fotos em processamento"],
  ["photos_failed", "fotos com falha"],
  ["photos_deleting", "fotos aguardando exclusão"],
];

const operationPriority: OperationCountKey[] = [
  "photos_failed",
  "uploads_expired",
  "photos_pending",
  "photos_processing",
  "uploads_pending",
  "uploads_canceling",
  "photos_deleting",
];

const operationNames: Record<OperationCountKey, { singular: string; plural: string }> = {
  uploads_pending: { singular: "envio em aberto", plural: "envios em aberto" },
  uploads_expired: { singular: "envio expirado", plural: "envios expirados" },
  uploads_canceling: { singular: "envio aguardando descarte", plural: "envios aguardando descarte" },
  photos_pending: { singular: "foto aguardando processamento", plural: "fotos aguardando processamento" },
  photos_processing: { singular: "foto em processamento", plural: "fotos em processamento" },
  photos_failed: { singular: "foto com falha", plural: "fotos com falha" },
  photos_deleting: { singular: "foto aguardando exclusão", plural: "fotos aguardando exclusão" },
};

const formatOperationCount = (key: OperationCountKey, count: number) =>
  `${count} ${count === 1 ? operationNames[key].singular : operationNames[key].plural}`;

export default async function WorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const query = (Array.isArray(search.q) ? search.q[0] : search.q)?.trim().slice(0, 120) ?? "";
  const titlePattern = galleryTitleSearchPattern(query);
  const requestedStatus = Array.isArray(search.status) ? search.status[0] : search.status;
  const status = requestedStatus && Object.hasOwn(galleryStatuses, requestedStatus)
    ? requestedStatus as GalleryStatus
    : "all";
  const requestedCustomer = (Array.isArray(search.customer) ? search.customer[0] : search.customer)?.trim() ?? "";
  const requestedCustomerId = isUuid(requestedCustomer) ? requestedCustomer : "";
  const pageValue = Array.isArray(search.page) ? search.page[0] : search.page;
  const parsedPage = Number(pageValue);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 && parsedPage <= 10_000 ? parsedPage : 1;
  const offset = (page - 1) * pageSize;
  const { supabase } = await requireWorkspace(id);
  const expiresAfter = new Date().toISOString();
  const expiresBefore = new Date(new Date(expiresAfter).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const [selectedCustomerResult, expiringSharesResult] = await Promise.all([
    requestedCustomerId
      ? supabase.from("customers").select("id, name").eq("tenant_id", id).eq("id", requestedCustomerId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from("gallery_shares").select("id, gallery_id, expires_at, share_mode", { count: "exact" })
      .eq("tenant_id", id).is("revoked_at", null).gt("expires_at", expiresAfter).lte("expires_at", expiresBefore)
      .order("expires_at").limit(10),
  ]);
  if (selectedCustomerResult.error) throw new Error("N\u00e3o foi poss\u00edvel carregar o cliente selecionado.");
  if (expiringSharesResult.error) throw new Error("Não foi possível carregar os links que vencem em breve.");
  const expiringGalleryIds = [...new Set(expiringSharesResult.data.map(share => share.gallery_id))];
  const expiringGalleriesResult = expiringGalleryIds.length
    ? await supabase.from("galleries").select("id, title").eq("tenant_id", id).in("id", expiringGalleryIds)
    : { data: [], error: null };
  if (expiringGalleriesResult.error) throw new Error("Não foi possível carregar os nomes das galerias.");
  const expiringGalleryTitles = new Map(expiringGalleriesResult.data.map(gallery => [gallery.id, gallery.title]));
  const expiringLinks = expiringSharesResult.data.flatMap(share => {
    const title = expiringGalleryTitles.get(share.gallery_id);
    return title ? [{ ...share, gallery_title: title }] : [];
  });
  const customerFilter = requestedCustomer === "unassigned"
    ? "unassigned"
    : selectedCustomerResult.data?.id ?? "";
  const pageHref = (targetPage: number) => {
    const search = new URLSearchParams();
    if (query) search.set("q", query);
    if (status !== "all") search.set("status", status);
    if (customerFilter) search.set("customer", customerFilter);
    search.set("page", String(targetPage));
    return `/painel/${id}?${search.toString()}`;
  };
  const hasFilters = Boolean(query) || status !== "all" || Boolean(customerFilter);
  const shouldCheckSetupProgress = page === 1 && !hasFilters;
  let totalItems = 0;
  if (page > 1) {
    let countQuery = supabase.from("galleries").select("id", { count: "exact", head: true }).eq("tenant_id", id);
    if (titlePattern) countQuery = countQuery.ilike("title", titlePattern);
    if (status !== "all") countQuery = countQuery.eq("status", status);
    if (customerFilter === "unassigned") countQuery = countQuery.is("customer_id", null);
    else if (customerFilter) countQuery = countQuery.eq("customer_id", customerFilter);
    const { count, error } = await countQuery;
    if (error) throw new Error("Não foi possível carregar as galerias.");
    totalItems = count ?? 0;
    const pageCount = Math.ceil(totalItems / pageSize);
    if (page > pageCount) redirect(pageHref(Math.max(pageCount, 1)));
  }
  let galleryQuery = supabase.from("galleries").select("id, title, slug, status, cover_photo_id", page === 1 ? { count: "exact" } : {}).eq("tenant_id", id).order("created_at", { ascending: false }).order("id").range(offset, offset + pageSize - 1);
  if (titlePattern) galleryQuery = galleryQuery.ilike("title", titlePattern);
  if (status !== "all") galleryQuery = galleryQuery.eq("status", status);
  if (customerFilter === "unassigned") galleryQuery = galleryQuery.is("customer_id", null);
  else if (customerFilter) galleryQuery = galleryQuery.eq("customer_id", customerFilter);
  const [galleriesResult, operationsResult, storageUsageResult, activeShareResult] = await Promise.all([
    galleryQuery,
    supabase.rpc("workspace_operations", { p_tenant_id: id }),
    supabase.rpc("workspace_storage_usage", { p_tenant_id: id }),
    shouldCheckSetupProgress
      ? supabase.from("gallery_shares").select("id")
        .eq("tenant_id", id).is("revoked_at", null).gt("expires_at", expiresAfter).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (galleriesResult.error) throw new Error("Não foi possível carregar as galerias.");
  if (operationsResult.error) throw new Error("Não foi possível carregar o resumo operacional.");
  const galleries = galleriesResult.data;
  if (page === 1) totalItems = galleriesResult.count ?? 0;
  const totalPages = Math.ceil(totalItems / pageSize);
  const operations = operationsResult.data as WorkspaceOperations;
  if (storageUsageResult.error) throw new Error("N\u00e3o foi poss\u00edvel carregar o uso de armazenamento.");
  const storageUsage = storageUsageResult.data as StorageUsage;
  if (activeShareResult.error) throw new Error("N\u00e3o foi poss\u00edvel carregar o progresso da primeira entrega.");
  const galleryIds = galleries.map(gallery => gallery.id);
  const coverPhotosResult = galleryIds.length
    ? await supabase.rpc("workspace_gallery_cover_photos", { p_tenant_id: id, p_gallery_ids: galleryIds })
    : { data: [], error: null };
  if (coverPhotosResult.error) throw new Error("Não foi possível carregar as capas das galerias.");
  const coverPhotoIds = new Map((coverPhotosResult.data as GalleryCover[]).map(cover => [cover.gallery_id, cover.photo_id]));
  const galleryCoverPaths = new Map(galleries.flatMap(gallery => {
    const photoId = coverPhotoIds.get(gallery.id);
    return photoId ? [[gallery.id, `${id}/${gallery.id}/${photoId}.webp`] as const] : [];
  }));
  const signedCoverUrls = await createMediaReader(supabase).signPaths(
    "thumbnail",
    [...galleryCoverPaths.values()],
    900,
  );
  const galleryCoverUrls = new Map(galleries.map(gallery => {
    const path = galleryCoverPaths.get(gallery.id);
    return [gallery.id, path ? signedCoverUrls.get(path) ?? null : null] as const;
  }));
  const hasActivity = labels.some(([key]) => operations[key] > 0);
  const hasSelections = operations.selections_received > 0;
  const galleryOperationsById = new Map(operations.galleries.map(gallery => [gallery.id, gallery]));
  const galleriesAwaitingReview = new Set(operations.selection_inbox.map(selection => selection.gallery_id));
  const setupGallery = galleries.find(gallery => coverPhotoIds.has(gallery.id)) ?? galleries[0];
  const setupHasGallery = galleries.length > 0;
  const setupHasUploadedPhotos = setupHasGallery && storageUsage.used_bytes > 0;
  const completedSetupSteps = Number(setupHasGallery) + Number(setupHasUploadedPhotos);
  const showSetupProgress = shouldCheckSetupProgress && setupHasGallery && !activeShareResult.data;

  return <>
    <div className="mb-8 flex flex-wrap items-center justify-between gap-4"><h1 className="text-3xl font-semibold">Galerias</h1><Link className="button" href={`/painel/${id}/galerias/nova`}>Criar galeria</Link></div>
    {showSetupProgress && setupGallery && <section className="panel workspace-setup-panel mb-8" aria-labelledby="workspace-setup-heading">
      <header className="workspace-setup-header">
        <div><p className="eyebrow">Primeira entrega</p><h2 id="workspace-setup-heading">Continue preparando sua galeria</h2><p>Seu progresso até compartilhar um link com o cliente.</p></div>
        <div className="workspace-setup-score"><progress aria-label="Etapas da primeira entrega" max={3} value={completedSetupSteps} /><span>{completedSetupSteps} de 3 etapas</span></div>
      </header>
      <ol className="workspace-setup-steps">
        {[
          { title: "Crie sua galeria", description: "Organize os detalhes do ensaio em um espaço próprio.", done: setupHasGallery, action: "Abrir galeria" },
          { title: "Envie suas fotos", description: "Os originais ficam privados enquanto são preparados para o cliente.", done: setupHasUploadedPhotos, action: setupHasUploadedPhotos ? "Ver fotos" : "Enviar fotos" },
          { title: "Compartilhe com o cliente", description: "Com fotos prontas, publique a galeria e crie um link temporário.", done: false, action: "Preparar compartilhamento" },
        ].map((step, index) => <li key={step.title} className={`workspace-setup-step${step.done ? " is-complete" : index === completedSetupSteps ? " is-current" : ""}`} aria-current={index === completedSetupSteps ? "step" : undefined}>
          <span className="workspace-setup-step-number" aria-hidden="true">{step.done ? "✓" : index + 1}</span>
          <div><h3>{step.title}</h3><p>{step.description}</p><Link href={`/painel/${id}/galerias/${setupGallery.id}`}>{step.action}</Link></div>
        </li>)}
      </ol>
    </section>}
    {hasSelections && <section className="panel mb-8 space-y-5" aria-labelledby="selection-inbox-heading">
      <div><h2 id="selection-inbox-heading" className="text-xl font-semibold">Seleções recebidas <span className="ml-2 text-amber-300">{operations.selections_received}</span></h2><p className="mt-1 text-sm text-stone-400">Confira as escolhas dos clientes e prepare os próximos passos do ensaio.</p></div>
      <ul className="divide-y divide-stone-800">
        {operations.selection_inbox.map(selection => <li key={selection.share_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><h3 className="font-medium">{selection.gallery_title}</h3><p className="text-sm text-stone-400">{selection.submitted_name} · {selection.selected_count} {selection.selected_count === 1 ? "foto selecionada" : "fotos selecionadas"} · {new Date(selection.submitted_at).toLocaleDateString("pt-BR")}</p></div>
          <Link className="text-sm text-amber-300 hover:text-amber-200" href={`/painel/${id}/galerias/${selection.gallery_id}`}>Conferir seleção</Link>
        </li>)}
      </ul>
      {operations.selections_received > operations.selection_inbox.length && <p className="text-sm text-stone-400">Exibindo as {operations.selection_inbox.length} seleções mais antigas; as outras continuam disponíveis nas galerias.</p>}
    </section>}
    {expiringLinks.length > 0 && <section className="panel mb-8 space-y-5" aria-labelledby="expiring-links-heading">
      <div><h2 id="expiring-links-heading" className="text-xl font-semibold">Links perto do vencimento <span className="ml-2 text-amber-300">{expiringSharesResult.count ?? expiringLinks.length}</span></h2><p className="mt-1 text-sm text-stone-400">Links ativos que vencem nos próximos três dias. Abra a galeria para renovar o acesso antes de o cliente perder o link.</p></div>
      <ul className="divide-y divide-stone-800">
        {expiringLinks.map(share => {
          const expiresAt = new Date(share.expires_at);
          return <li key={share.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div><h3 className="font-medium">{share.gallery_title}</h3><p className="text-sm text-stone-400">{share.share_mode === "delivery" ? "Entrega completa" : "Seleção de fotos"} · expira em {expiresAt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" })}</p></div>
            <Link className="text-sm text-amber-300 hover:text-amber-200" href={`/painel/${id}/galerias/${share.gallery_id}`}>Renovar link</Link>
          </li>;
        })}
      </ul>
      {(expiringSharesResult.count ?? expiringLinks.length) > expiringLinks.length && <p className="text-sm text-stone-400">Exibindo os {expiringLinks.length} links que vencem primeiro.</p>}
    </section>}
    <section className="panel mb-8 space-y-4" aria-labelledby="storage-quota-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 id="storage-quota-heading" className="text-xl font-semibold">Armazenamento do workspace</h2><p className="mt-1 text-sm text-stone-400">{"A cota considera os originais e o espa\u00e7o reservado para envios em andamento."}</p></div>
        <p className="text-right"><span className="block text-2xl font-semibold">{formatStorageBytes(storageUsage.available_bytes)}</span><span className="text-sm text-stone-400">{"dispon\u00edveis para novos envios"}</span></p>
      </div>
      <meter className="w-full" aria-label={"Espa\u00e7o utilizado e reservado"} min={0} max={Math.max(1, storageUsage.limit_bytes)} value={Math.min(storageUsage.limit_bytes, storageUsage.used_bytes + storageUsage.reserved_bytes)} />
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-stone-500">Fotos originais</dt><dd className="mt-1 font-medium">{formatStorageBytes(storageUsage.used_bytes)}</dd></div>
        <div><dt className="text-stone-500">Envios reservados</dt><dd className="mt-1 font-medium">{formatStorageBytes(storageUsage.reserved_bytes)}</dd></div>
        <div><dt className="text-stone-500">{"Limite t\u00e9cnico"}</dt><dd className="mt-1 font-medium">{formatStorageBytes(storageUsage.limit_bytes)}</dd></div>
      </dl>
    </section>
    {hasActivity && <section className="panel mb-8 space-y-5" aria-labelledby="operations-heading">
      <div><h2 id="operations-heading" className="text-xl font-semibold">Resumo operacional</h2><p className="mt-1 text-sm text-stone-400">Envios e processamento das galerias deste workspace.</p></div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {labels.filter(([key]) => operations[key] > 0).map(([key]) => <li key={key} className="rounded-lg border border-stone-800 p-3"><span className="text-2xl font-semibold">{operations[key]}</span><span className="ml-2 text-sm text-stone-400">{operationNames[key][operations[key] === 1 ? "singular" : "plural"]}</span></li>)}
      </ul>
      <ul className="divide-y divide-stone-800">
        {operations.galleries.map(gallery => {
          const items = labels.filter(([key]) => gallery[key] > 0).map(([key]) => formatOperationCount(key, gallery[key]));
          return <li key={gallery.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><h3 className="font-medium">{gallery.title}</h3><p className="text-sm text-stone-400">{items.join(" · ")}</p></div><Link className="text-sm text-amber-300 hover:text-amber-200" href={`/painel/${id}/galerias/${gallery.id}`}>Abrir galeria</Link></li>;
        })}
      </ul>
    </section>}
    <form key={`${query}:${status}:${customerFilter}`} method="get" className="mb-6 flex flex-wrap items-end gap-3">
      <label className="field min-w-56 flex-1">Buscar por título<input key={query} type="search" name="q" maxLength={120} defaultValue={query} /></label>
      <label className="field min-w-40">Status<select key={status} name="status" defaultValue={status}>
        <option value="all">Todos</option>
        {Object.entries(galleryStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <div className="field min-w-48"><label htmlFor="gallery-customer-filter">Cliente</label><CustomerPicker tenantId={id} name="customer" inputId="gallery-customer-filter" initialValue={customerFilter} initialName={selectedCustomerResult.data?.name} quickChoices={[{ value: "", label: "Todos os clientes" }, { value: "unassigned", label: "Sem cliente vinculado" }]} /></div>
      <button className="button" type="submit">Filtrar</button>
      {hasFilters && <Link className="button-secondary" href={`/painel/${id}`}>Limpar</Link>}
    </form>
    {galleries.length ? <><ul className="gallery-dashboard-grid">{galleries.map(gallery => {
      const coverUrl = galleryCoverUrls.get(gallery.id);
      const galleryOperations = galleryOperationsById.get(gallery.id);
      const gallerySignals = operationPriority.filter(key => galleryOperations && galleryOperations[key] > 0);
      const hasSelectionAwaitingReview = galleriesAwaitingReview.has(gallery.id);
      return <li key={gallery.id}>
        <Link href={`/painel/${id}/galerias/${gallery.id}`} className="gallery-dashboard-card">
          <div className={`gallery-dashboard-cover${coverUrl ? "" : " is-empty"}`}>
            {coverUrl
              ? <Image src={coverUrl} alt={`Capa da galeria ${gallery.title}`} fill unoptimized sizes="(max-width: 560px) 100vw, (max-width: 900px) 50vw, 33vw" />
              : <div className="gallery-dashboard-placeholder" aria-hidden="true"><span className="gallery-dashboard-placeholder-mark" /><span>Adicione fotos para criar a capa</span></div>}
            <span className={`gallery-dashboard-status is-${gallery.status}`}>{galleryStatuses[gallery.status as GalleryStatus]}</span>
          </div>
          <div className="gallery-dashboard-copy">
            <p className="gallery-dashboard-slug">ID · {gallery.slug}</p>
            <h2>{gallery.title}</h2>
            <div className="gallery-dashboard-signals" aria-label="Pendências da galeria">
              {hasSelectionAwaitingReview && <span className="gallery-dashboard-signal is-selection">Seleção aguardando conferência</span>}
              {gallerySignals.length
                ? gallerySignals.slice(0, 2).map(key => <span key={key} className={`gallery-dashboard-signal${key === "photos_failed" || key === "uploads_expired" ? " is-alert" : ""}`}>{formatOperationCount(key, galleryOperations![key])}</span>)
                : <span className="gallery-dashboard-signal is-quiet">Envios e processamento sem pendências</span>}
              {gallerySignals.length > 2 && <span className="gallery-dashboard-signal is-more">+{gallerySignals.length - 2} outros alertas</span>}
            </div>
            <span className="gallery-dashboard-action">Gerenciar galeria <span className="gallery-dashboard-arrow" aria-hidden="true" /></span>
          </div>
        </Link>
      </li>;
    })}</ul><Pagination currentPage={page} totalPages={totalPages} totalItems={totalItems} firstItem={offset + 1} lastItem={offset + galleries.length} hrefForPage={pageHref} label="Paginação de galerias" /></> : hasFilters ? <p className="text-stone-400">Nenhuma galeria encontrada com estes filtros.</p> : <section className="panel space-y-6" aria-labelledby="first-gallery-heading">
      <div><p className="mb-2 text-sm font-medium uppercase tracking-widest text-amber-300">Primeira entrega</p><h2 id="first-gallery-heading" className="mb-3 text-2xl font-semibold">Organize seu primeiro trabalho</h2><p className="max-w-2xl text-stone-400">Siga estes passos para preparar as fotos e entregar uma seleção ao seu cliente.</p></div>
      <ol className="grid gap-4 sm:grid-cols-2">
        <li className="rounded-xl border border-white/10 p-4"><p className="font-medium">1. Cadastre seu cliente <span className="text-sm font-normal text-stone-500">(opcional)</span></p><p className="mt-2 text-sm text-stone-400">Você também pode criar a galeria sem vincular um cliente.</p><Link className="mt-3 inline-block text-sm text-amber-300 underline" href={`/painel/${id}/clientes`}>Abrir clientes</Link></li>
        <li className="rounded-xl border border-white/10 p-4"><p className="font-medium">2. Crie uma galeria</p><p className="mt-2 text-sm text-stone-400">Dê um nome ao ensaio e organize os detalhes da entrega.</p><Link className="button mt-3 inline-block" href={`/painel/${id}/galerias/nova`}>Criar primeira galeria</Link></li>
        <li className="rounded-xl border border-white/10 p-4"><p className="font-medium">3. Envie suas fotos</p><p className="mt-2 text-sm text-stone-400">A galeria aceita imagens JPEG e PNG de até 50 MiB por arquivo.</p></li>
        <li className="rounded-xl border border-white/10 p-4"><p className="font-medium">4. Compartilhe a entrega</p><p className="mt-2 text-sm text-stone-400">Depois do processamento, publique a galeria e crie um link temporário para seu cliente.</p></li>
      </ol>
    </section>}
  </>;
}

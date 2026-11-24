"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type DragEvent, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MAX_PHOTO_BYTES, validatePhotoQuota, validatePhotoSelection } from "@/lib/photo-validation";
import { formatStorageBytes, uploadError, type UploadSession, type StorageUsage } from "@/lib/upload-lifecycle";
import { createPhotoUploadFlow } from "@/lib/photo-upload-flow";
import { fetchAllGalleryPhotoIds } from "@/lib/gallery-photo-data";

type Photo = {
  id: string; object_path: string; storage_provider: "supabase" | "r2"; original_filename: string; byte_size: number; deletion_requested_at: string | null;
  processing_status: "pending" | "processing" | "ready" | "invalid" | "failed";
  thumbnailUrl: string | null; previewUrl: string | null; originalUrl: string | null; position: number;
};
type PhotoDeletionTarget = Pick<Photo, "id" | "object_path" | "storage_provider" | "original_filename" | "deletion_requested_at">;

const subscribeToHydration = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
const photoIdPageSize = 1000;
const selectedPhotoBatchSize = 200;

export function PhotoUploader({ tenantId, galleryId, photos, photoCount: initialPhotoCount, pendingDeletions, readyPhotoCount, hasPhotosProcessing, activeCoverPhotoId, uploads, storageUsage, coverPhotoId, allowUpload = true }: {
  tenantId: string; galleryId: string; photos: Photo[]; photoCount: number; pendingDeletions: PhotoDeletionTarget[];
  readyPhotoCount: number; hasPhotosProcessing: boolean; activeCoverPhotoId: string | null;
  uploads: UploadSession[]; storageUsage: StorageUsage; coverPhotoId: string | null; allowUpload?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const uploadFlowFactory = useRef<ReturnType<typeof createPhotoUploadFlow> | null>(null);
  const draggedPhotoId = useRef<string | null>(null);
  const previousPhotoCount = useRef(initialPhotoCount);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [removingPhotoId, setRemovingPhotoId] = useState<string | null>(null);
  const [retryingPhotoId, setRetryingPhotoId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [settingCover, setSettingCover] = useState(false);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [loadedPhotos, setLoadedPhotos] = useState(photos);
  const [totalPhotoCount, setTotalPhotoCount] = useState(initialPhotoCount);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingSelection, setLoadingSelection] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  // Server-rendered inputs must stay disabled until their handlers are attached.
  const hydrated = useSyncExternalStore(subscribeToHydration, clientReady, serverReady);
  const busy = !hydrated || pending || removingPhotoId !== null || retryingPhotoId !== null || reordering || settingCover || refreshing || loadingMore || loadingSelection;
  const activePhotos = useMemo(() => loadedPhotos.filter(photo => !photo.deletion_requested_at), [loadedPhotos]);
  const visiblePhotos = activePhotos;
  const selectedPhotoCount = selectedPhotoIds.size;
  const activeCoverId = activeCoverPhotoId;
  const availableBytes = Math.max(0, storageUsage.available_bytes);

  useEffect(() => {
    if (previousPhotoCount.current !== initialPhotoCount) {
      previousPhotoCount.current = initialPhotoCount;
      setTotalPhotoCount(initialPhotoCount);
      setLoadedPhotos(photos);
      setSelectedPhotoIds(new Set());
      return;
    }
    setLoadedPhotos(current => {
      const next = new Map(current.map(photo => [photo.id, photo]));
      for (const photo of photos) next.set(photo.id, photo);
      for (const photo of pendingDeletions) next.delete(photo.id);
      return [...next.values()].sort((a, b) => a.position - b.position);
    });
  }, [initialPhotoCount, pendingDeletions, photos]);
  useEffect(() => {
    if (!hasPhotosProcessing) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [hasPhotosProcessing, router]);

  function uploadFlow() {
    const flow = uploadFlowFactory.current ??= createPhotoUploadFlow(createClient());
    return flow(tenantId, galleryId);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !input.current) return;
    const files = Array.from(input.current.files ?? []);
    const validation = validatePhotoSelection(files);
    if (validation) { setError(validation); return; }
    const quotaValidation = validatePhotoQuota(files, availableBytes);
    if (quotaValidation) { setError(quotaValidation); return; }
    setPending(true); setError(""); setProgress("");
    let uploaded = 0;
    let completedBytes = 0;
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const updateBatchProgress = (fileNumber: number, currentBytes = 0) => {
      const percent = totalBytes > 0 ? Math.floor((completedBytes + currentBytes) / totalBytes * 100) : 0;
      setProgress(`Enviando ${fileNumber} de ${files.length}… ${percent}% do lote`);
    };
    try {
      const flow = uploadFlow();
      await flow.requireUser();
      for (const file of files) {
        updateBatchProgress(uploaded + 1);
        await flow.send(file, sent => updateBatchProgress(uploaded + 1, sent));
        uploaded += 1;
        completedBytes += file.size;
      }
      setProgress(`${uploaded} ${uploaded === 1 ? "imagem enviada" : "imagens enviadas"}.`);
      input.current.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir o envio.");
      setProgress(uploaded ? `${uploaded} ${uploaded === 1 ? "imagem enviada" : "imagens enviadas"} antes da interrupção.` : "");
    } finally {
      // Refresh even when the first file failed: its reservation may exist.
      startRefresh(() => router.refresh());
      setPending(false);
    }
  }

  async function resumeUpload(session: UploadSession, file?: File) {
    if (busy) return;
    setPending(true); setError(""); setProgress("");
    try {
      await uploadFlow().resume(session, file, (sent, size) => {
        const percent = size > 0 ? Math.floor(sent / size * 100) : 0;
        setProgress(`Enviando 1 de 1… ${percent}% deste arquivo`);
      });
      setProgress(`Envio de “${session.original_filename}” concluído.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uploadError(""));
    } finally {
      startRefresh(() => router.refresh());
      setPending(false);
    }
  }

  async function cancelUpload(session: UploadSession) {
    if (busy) return;
    if (session.state !== "canceling" && !window.confirm(`Descartar o envio de “${session.original_filename}”? O arquivo pendente será removido.`)) return;
    setPending(true); setError(""); setProgress("");
    try {
      await uploadFlow().cancel(session);
      setProgress(`Envio de “${session.original_filename}” descartado.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível descartar o envio.");
    } finally {
      startRefresh(() => router.refresh());
      setPending(false);
    }
  }

  async function deletePhotoRecoverably(photo: PhotoDeletionTarget, supabase: ReturnType<typeof createClient>): Promise<"deleted" | "pending"> {
    const scope = { p_tenant_id: tenantId, p_gallery_id: galleryId, p_photo_id: photo.id };
    const started = await supabase.rpc("begin_photo_deletion", scope);
    if (started.error) throw new Error("Não foi possível iniciar a exclusão. Verifique sua sessão e tente novamente.");
    if (started.data === null) return "deleted";
    if (typeof started.data !== "string") throw new Error("Não foi possível identificar a imagem para exclusão.");
    const derivedPath = `${tenantId}/${galleryId}/${photo.id}.webp`;
    for (const bucket of ["gallery-previews", "gallery-thumbnails"]) {
      const removedDerivative = await supabase.storage.from(bucket).remove([derivedPath]);
      if (removedDerivative.error) throw new Error("A exclusão ficou pendente. Use Concluir exclusão para tentar novamente.");
    }
    if (photo.storage_provider === "r2") return "pending";
    if (photo.storage_provider !== "supabase") throw new Error("O provedor deste original ainda não é compatível com exclusão.");
    const removedObject = await supabase.storage.from("gallery-originals").remove([started.data]);
    if (removedObject.error) throw new Error("A exclusão ficou pendente. Use Concluir exclusão para tentar novamente.");
    const finished = await supabase.rpc("finish_photo_deletion", scope);
    if (finished.error || finished.data !== true) {
      throw new Error("Não foi possível confirmar a exclusão. Use Concluir exclusão para tentar novamente.");
    }
    return "deleted";
  }

  async function removePhoto(photo: PhotoDeletionTarget) {
    if (busy) return;
    if (!photo.deletion_requested_at && !window.confirm(`Excluir permanentemente “${photo.original_filename}” desta galeria?`)) return;
    setRemovingPhotoId(photo.id); setError(""); setProgress("");
    try {
      const outcome = await deletePhotoRecoverably(photo, createClient());
      if (!photo.deletion_requested_at) {
        setLoadedPhotos(current => current.filter(item => item.id !== photo.id));
        setTotalPhotoCount(current => Math.max(0, current - 1));
        setSelectedPhotoIds(current => { const next = new Set(current); next.delete(photo.id); return next; });
      }
      setProgress(outcome === "pending"
        ? `Exclusão de “${photo.original_filename}” registrada; o original será removido após a janela de segurança.`
        : `Imagem “${photo.original_filename}” excluída.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível excluir a imagem. Tente novamente.");
    } finally {
      startRefresh(() => router.refresh());
      setRemovingPhotoId(null);
    }
  }
  async function loadPhotoIdPage(offset: number, limit?: number) {
    const query = new URLSearchParams({ ids: "1", offset: String(offset) });
    if (limit !== undefined) query.set("limit", String(limit));
    const response = await fetch(`/painel/${tenantId}/galerias/${galleryId}/fotos?${query}`, { cache: "no-store" });
    const body = await response.json().catch(() => null) as { ids?: unknown; totalCount?: unknown; error?: unknown } | null;
    if (!response.ok || !body || !Array.isArray(body.ids)
      || body.ids.some(id => typeof id !== "string")
      || (offset === 0 && typeof body.totalCount !== "number")) {
      const message = typeof body?.error === "string" ? body.error : "Não foi possível carregar a lista de fotos.";
      return { ids: null, totalCount: null, error: new Error(message) };
    }
    return {
      ids: body.ids as string[],
      totalCount: typeof body.totalCount === "number" ? body.totalCount : null,
      error: null,
    };
  }

  async function fetchAllPhotoIds() {
    return fetchAllGalleryPhotoIds(loadPhotoIdPage, photoIdPageSize);
  }

  async function fetchPhotoIdAt(position: number) {
    const page = await loadPhotoIdPage(position, 1);
    if (page.error) throw page.error;
    if (!page.ids?.[0]) throw new Error("A galeria mudou. Atualize a página e tente novamente.");
    return page.ids[0];
  }

  async function fetchSelectedPhotoTargets(ids: string[]): Promise<PhotoDeletionTarget[]> {
    const targets: PhotoDeletionTarget[] = [];
    for (let offset = 0; offset < ids.length; offset += selectedPhotoBatchSize) {
      const batch = ids.slice(offset, offset + selectedPhotoBatchSize);
      const response = await fetch(`/painel/${tenantId}/galerias/${galleryId}/fotos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: batch }),
      });
      const body = await response.json().catch(() => null) as { photos?: PhotoDeletionTarget[]; error?: unknown } | null;
      if (!response.ok || !body || !Array.isArray(body.photos) || body.photos.length !== batch.length) {
        throw new Error(typeof body?.error === "string" ? body.error : "Não foi possível preparar a exclusão das fotos.");
      }
      targets.push(...body.photos);
    }
    return targets;
  }

  async function toggleAllPhotoSelection() {
    if (busy) return;
    if (selectedPhotoCount === totalPhotoCount) {
      setSelectedPhotoIds(new Set());
      return;
    }
    setLoadingSelection(true); setError(""); setProgress("");
    try {
      const ids = await fetchAllPhotoIds();
      if (ids.length !== totalPhotoCount) throw new Error("A galeria mudou. Atualize a página e tente novamente.");
      setSelectedPhotoIds(new Set(ids));
      setProgress(`${ids.length} ${ids.length === 1 ? "foto selecionada" : "fotos selecionadas"}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível selecionar as fotos.");
    } finally {
      setLoadingSelection(false);
    }
  }

  async function removeSelectedPhotos() {
    const selectedIds = [...selectedPhotoIds];
    if (busy || selectedIds.length === 0) return;
    const count = selectedIds.length;
    if (!window.confirm(`Excluir permanentemente ${count} ${count === 1 ? "imagem selecionada" : "imagens selecionadas"} desta galeria?`)) return;
    setPending(true); setError(""); setProgress("");
    const supabase = createClient();
    const handledIds = new Set<string>();
    const pendingIds = new Set<string>();
    try {
      const targets = await fetchSelectedPhotoTargets(selectedIds);
      for (const photo of targets) {
        setRemovingPhotoId(photo.id);
        const outcome = await deletePhotoRecoverably(photo, supabase);
        handledIds.add(photo.id);
        if (outcome === "pending") pendingIds.add(photo.id);
      }
      const completedCount = handledIds.size - pendingIds.size;
      const completedText = completedCount ? `${completedCount} ${completedCount === 1 ? "imagem excluída" : "imagens excluídas"}` : "";
      const pendingText = pendingIds.size ? `${pendingIds.size} ${pendingIds.size === 1 ? "imagem aguardando remoção segura" : "imagens aguardando remoção segura"}` : "";
      setProgress([completedText, pendingText].filter(Boolean).join("; ") + ".");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a exclusão das imagens selecionadas.");
      if (handledIds.size > 0) setProgress(`${handledIds.size} de ${count} solicitações foram registradas. As demais continuam na galeria ou em Exclusões pendentes.`);
    } finally {
      if (handledIds.size > 0) {
        setLoadedPhotos(current => current.filter(photo => !handledIds.has(photo.id)));
        setTotalPhotoCount(current => Math.max(0, current - handledIds.size));
      }
      setSelectedPhotoIds(current => new Set([...current].filter(id => !handledIds.has(id))));
      startRefresh(() => router.refresh());
      setRemovingPhotoId(null);
      setPending(false);
    }
  }

  async function movePhotoRelative(photoId: string, targetPhotoId: string, afterTarget: boolean) {
    if (busy) return;
    if (photoId === targetPhotoId) { setReordering(false); return; }
    setReordering(true); setError(""); setProgress("");
    try {
      const result = await createClient().rpc("move_gallery_photo", {
        p_tenant_id: tenantId, p_gallery_id: galleryId, p_photo_id: photoId,
        p_target_photo_id: targetPhotoId, p_after_target: afterTarget,
      });
      if (result.error || result.data !== true) throw new Error("Não foi possível salvar a ordem das fotos. Atualize a galeria e tente novamente.");
      setLoadedPhotos(photos);
      setProgress("Ordem das fotos salva.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a ordem das fotos.");
    } finally {
      startRefresh(() => router.refresh());
      setReordering(false);
    }
  }

  async function loadMorePhotos() {
    if (busy || activePhotos.length >= totalPhotoCount) return;
    const offset = activePhotos.length;
    setLoadingMore(true); setError("");
    try {
      const response = await fetch(`/painel/${tenantId}/galerias/${galleryId}/fotos?offset=${offset}`, { cache: "no-store" });
      const body = await response.json().catch(() => null) as { photos?: Photo[]; totalCount?: number | null; error?: unknown } | null;
      if (!response.ok || !body || !Array.isArray(body.photos) || (!body.photos.length && offset < totalPhotoCount)) {
        throw new Error(typeof body?.error === "string" ? body.error : "Não foi possível carregar as próximas fotos.");
      }
      setLoadedPhotos(current => {
        const next = new Map(current.map(photo => [photo.id, photo]));
        for (const photo of body.photos!) next.set(photo.id, photo);
        return [...next.values()].sort((a, b) => a.position - b.position);
      });
      if (typeof body.totalCount === "number") setTotalPhotoCount(body.totalCount);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar as próximas fotos.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function movePhoto(photo: Photo, direction: -1 | 1) {
    if (busy) return;
    const targetPosition = photo.position + direction;
    if (targetPosition < 0 || targetPosition >= totalPhotoCount) return;
    setReordering(true); setError(""); setProgress("");
    try {
      const targetPhotoId = await fetchPhotoIdAt(targetPosition);
      await movePhotoRelative(photo.id, targetPhotoId, direction > 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a ordem das fotos.");
      setReordering(false);
    }
  }

  async function reorderPhoto(draggedId: string, targetId: string, afterTarget: boolean) {
    if (busy || draggedId === targetId) return;
    await movePhotoRelative(draggedId, targetId, afterTarget);
  }
  function handlePhotoDrop(photo: Photo, event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData("text/plain") || draggedPhotoId.current;
    draggedPhotoId.current = null;
    if (!draggedId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    void reorderPhoto(draggedId, photo.id, event.clientY >= bounds.top + bounds.height / 2);
  }

  async function setCoverPhoto(photoId: string | null) {
    if (busy) return;
    setSettingCover(true); setError(""); setProgress("");
    try {
      const result = await createClient().rpc("set_gallery_cover_photo", {
        p_tenant_id: tenantId, p_gallery_id: galleryId, p_photo_id: photoId,
      });
      if (result.error || result.data !== true) throw new Error("Não foi possível atualizar a capa. Atualize a galeria e tente novamente.");
      setProgress(photoId ? "Capa da galeria atualizada." : "A galeria usará a primeira foto pronta na ordem definida.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível atualizar a capa.");
    } finally {
      startRefresh(() => router.refresh());
      setSettingCover(false);
    }
  }

  async function retryPhotoProcessing(photo: Photo) {
    if (busy) return;
    setRetryingPhotoId(photo.id); setError(""); setProgress("");
    try {
      const result = await createClient().rpc("retry_failed_photo_processing", {
        p_tenant_id: tenantId, p_gallery_id: galleryId, p_photo_id: photo.id,
      });
      if (result.error || result.data !== true) throw new Error("Não foi possível reenfileirar o processamento. Atualize a galeria e tente novamente.");
      setProgress(`Novo processamento solicitado para “${photo.original_filename}”.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível reenfileirar o processamento.");
    } finally {
      startRefresh(() => router.refresh());
      setRetryingPhotoId(null);
    }
  }

  return <section aria-labelledby="photos-heading" className="space-y-8">
    <h2 id="photos-heading" className="text-xl font-semibold">Fotos da galeria</h2>
    <section className="panel" aria-label="Armazenamento do workspace">
      <h3 className="font-semibold">Armazenamento do workspace</h3>
      <p className="mt-2 text-sm text-stone-300">{formatStorageBytes(storageUsage.used_bytes)} em fotos · {formatStorageBytes(storageUsage.reserved_bytes)} reservados · {formatStorageBytes(availableBytes)} livres · limite de {formatStorageBytes(storageUsage.limit_bytes)}</p>
      <meter className="mt-3 w-full" aria-label="Espaço utilizado e reservado" min={0} max={Math.max(1, storageUsage.limit_bytes)} value={Math.min(storageUsage.limit_bytes, storageUsage.used_bytes + storageUsage.reserved_bytes)} />
      <p className="mt-2 text-sm text-stone-400">Cada novo arquivo precisa de 50 MiB livres para a reserva temporária de até quatro horas; ao concluir, apenas seu tamanho real ocupa espaço. Envios vencidos com arquivo aguardam limpeza.</p>
      {allowUpload && availableBytes < MAX_PHOTO_BYTES && <p className="mt-2 text-sm text-amber-200">Libere pelo menos 50 MiB para iniciar um envio.</p>}
    </section>
    {allowUpload ? <div className="panel">
      <p className="mb-6 text-sm text-stone-400">JPEG e PNG, até 50 MiB por imagem. Selecione até 20 imagens e 100 MiB por envio.</p>
      <form onSubmit={upload} className="space-y-4">
        <label className="field">Adicionar imagens<input ref={input} type="file" accept="image/jpeg,image/png" multiple required disabled={busy} onChange={() => { setError(""); setProgress(""); }} /></label>
        <p className="text-sm text-stone-500">Arquivos acima de 6 MiB são enviados em partes e podem ser retomados no mesmo navegador ao selecionar o arquivo novamente. RAW não é aceito.</p>
        <button className="button" type="submit" disabled={busy}>{pending ? "Aguarde…" : "Enviar imagens"}</button>
      </form>
    </div> : <p className="panel text-sm text-stone-400">A galeria está arquivada. As fotos existentes continuam disponíveis aos membros do workspace.</p>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {progress && <p role="status" className="text-sm text-stone-300">{progress}</p>}
    {uploads.length > 0 && <section className="panel" aria-labelledby="pending-uploads-heading">
      <h3 id="pending-uploads-heading" className="text-lg font-semibold">Envios pendentes</h3>
      <p className="mt-2 text-sm text-stone-400">Confirme um arquivo já recebido ou selecione-o novamente para reenviar. Se o prazo terminou, descarte o envio e comece outro.</p>
      <ul className="mt-4 space-y-6">{uploads.map(session => <li key={session.id}>
        <p className="break-words font-medium">{session.original_filename}</p>
        {session.state === "reserved" && allowUpload && <div className="mt-2 space-y-3">
          <button type="button" className="button" disabled={busy} onClick={() => resumeUpload(session)} aria-label={`Confirmar envio ${session.original_filename}`}>Confirmar envio</button>
          <label className="field">Reenviar {session.original_filename}<input type="file" accept={session.content_type} disabled={busy} onChange={event => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (file) void resumeUpload(session, file);
          }} /></label>
        </div>}
        <button type="button" className="mt-3 text-sm text-amber-300 underline" disabled={busy} onClick={() => cancelUpload(session)} aria-label={`Descartar envio ${session.original_filename}`}>{session.state === "canceling" ? "Concluir descarte" : "Descartar envio"}</button>
      </li>)}</ul>
    </section>}
    {pendingDeletions.length > 0 && <section className="panel" aria-labelledby="pending-deletions-heading">
      <h3 id="pending-deletions-heading" className="text-lg font-semibold">Exclusões pendentes</h3>
      <p className="mt-2 text-sm text-stone-400">Estas imagens aguardam a conclusão da exclusão. Você pode tentar novamente mesmo depois de fechar a página.</p>
      <ul className="mt-4 space-y-4">{pendingDeletions.map(photo => <li key={photo.id}>
        <p className="break-words text-sm">{photo.original_filename}</p>
        {photo.storage_provider === "r2" && <p className="mt-1 text-xs text-stone-500">O original será removido automaticamente depois que a autorização temporária de envio vencer e a ausência for confirmada.</p>}
        <button type="button" className="button mt-2" disabled={busy} onClick={() => removePhoto(photo)} aria-label={`Concluir exclusão ${photo.original_filename}`}>
          {removingPhotoId === photo.id ? "Excluindo…" : "Concluir exclusão"}
        </button>
      </li>)}</ul>
    </section>}
    {totalPhotoCount ? <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-xl font-semibold">{totalPhotoCount} {totalPhotoCount === 1 ? "imagem" : "imagens"}</h3><p className="text-xs text-stone-500">{readyPhotoCount} prontas</p></div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-stone-300"><input type="checkbox" className="accent-amber-300" checked={loadingSelection || totalPhotoCount > 0 && selectedPhotoCount === totalPhotoCount} disabled={busy} onChange={() => void toggleAllPhotoSelection()} />{loadingSelection ? "Selecionando..." : "Selecionar todas"}</label>
          {selectedPhotoCount > 0 && <button type="button" className="button-secondary" disabled={busy} onClick={removeSelectedPhotos}>Excluir {selectedPhotoCount} {selectedPhotoCount === 1 ? "selecionada" : "selecionadas"}</button>}
          {selectedPhotoCount > 0 && <button type="button" className="text-sm text-stone-400 underline" disabled={busy} onClick={() => setSelectedPhotoIds(new Set())}>Limpar seleção</button>}
          {coverPhotoId && <button type="button" className="text-sm text-amber-300 underline" disabled={busy} onClick={() => setCoverPhoto(null)}>Usar primeira foto automaticamente</button>}
        </div>
      </div>
      <p className="mb-3 text-xs text-stone-500">Arraste a alça para ordenar ou use Subir e Descer para mover uma foto por vez.</p>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{visiblePhotos.map(photo => <li key={photo.id} data-testid="gallery-photo-card" className="panel min-w-0 p-3" onDragOver={event => {
        if (draggedPhotoId.current) event.preventDefault();
      }} onDrop={event => handlePhotoDrop(photo, event)}>
        <span draggable={!busy} role="img" aria-label={`Alça para reordenar ${photo.original_filename}`} title="Arraste para ordenar" className="mb-2 inline-block cursor-grab select-none text-lg leading-none text-stone-500 active:cursor-grabbing" onDragStart={event => {
          draggedPhotoId.current = photo.id;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", photo.id);
        }} onDragEnd={() => { draggedPhotoId.current = null; }}>⋮⋮</span>
        <label className="mb-2 flex items-center gap-2 text-xs text-stone-400"><input type="checkbox" className="accent-amber-300" checked={selectedPhotoIds.has(photo.id)} disabled={busy} onChange={event => {
          const checked = event.currentTarget.checked;
          setSelectedPhotoIds(current => {
            const next = new Set(current);
            if (checked) next.add(photo.id); else next.delete(photo.id);
            return next;
          });
        }} aria-label={`Selecionar ${photo.original_filename} para exclusão`} />Selecionar</label>
        {photo.thumbnailUrl && photo.previewUrl ? <a href={photo.previewUrl} target="_blank" rel="noreferrer" aria-label={`Abrir ${photo.original_filename}`}><Image unoptimized width={400} height={400} src={photo.thumbnailUrl} alt={photo.original_filename} className="aspect-square w-full rounded-lg object-cover" /></a>
          : <p className="flex aspect-square items-center rounded-lg bg-white/5 p-3 text-sm text-stone-400">{photo.processing_status === "invalid" ? "Arquivo inválido. Exclua e envie outra imagem." : photo.processing_status === "failed" ? "Falha ao preparar a imagem após várias tentativas." : photo.processing_status === "ready" ? "Imagem indisponível. Tente recarregar a página." : "Preparando imagem. Esta galeria atualiza automaticamente."}</p>}
        <div className="mt-3 flex min-h-6 items-center justify-between gap-2">
          <p className="truncate text-sm" title={photo.original_filename}>{photo.original_filename}</p>
          {photo.id === activeCoverId && <span className="shrink-0 rounded-full bg-amber-300/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200">Capa</span>}
        </div>
        {photo.processing_status === "ready" && photo.id !== activeCoverId && <button type="button" className="mt-3 text-xs text-amber-300 underline" disabled={busy} onClick={() => setCoverPhoto(photo.id)} aria-label={`Definir ${photo.original_filename} como capa`}>{settingCover ? "Salvando capa…" : "Definir como capa"}</button>}
        {photo.processing_status === "failed" && <button type="button" className="button mt-3 w-full" disabled={busy} onClick={() => retryPhotoProcessing(photo)} aria-label={`Tentar processar ${photo.original_filename} novamente`}>{retryingPhotoId === photo.id ? "Solicitando…" : "Tentar processar novamente"}</button>}
        <p className="mt-1 text-xs text-stone-500">{(photo.byte_size / 1048576).toFixed(1)} MiB</p>
        <div className="mt-2 flex gap-3 text-xs text-amber-300">
          <button type="button" disabled={busy || photo.position === 0} onClick={() => movePhoto(photo, -1)} aria-label={`Mover ${photo.original_filename} para cima`}>Subir</button>
          <button type="button" disabled={busy || photo.position === totalPhotoCount - 1} onClick={() => movePhoto(photo, 1)} aria-label={`Mover ${photo.original_filename} para baixo`}>Descer</button>
        </div>
        {photo.originalUrl && <a href={photo.originalUrl} target="_blank" rel="noreferrer" className="mt-2 block text-sm text-amber-300 underline" aria-label={`Baixar original ${photo.original_filename}`}>Baixar original</a>}
        <button type="button" className="button mt-3 w-full" disabled={busy} onClick={() => removePhoto(photo)} aria-label={`Excluir ${photo.original_filename}`}>
          {removingPhotoId === photo.id ? "Excluindo…" : "Excluir imagem"}
        </button>
      </li>)}</ul>
      {activePhotos.length < totalPhotoCount && <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-stone-400">Exibindo {activePhotos.length} de {totalPhotoCount} fotos.</p>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => void loadMorePhotos()}>{loadingMore ? "Preparando fotos..." : "Carregar mais fotos"}</button>
      </div>}
    </div> : <p className="text-sm text-stone-400">Ainda não há imagens nesta galeria.</p>}
  </section>;
}

"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

type Photo = { id: string; name: string; selected: boolean; client_note?: string | null };
type PhotoPage = { photos: Photo[]; totalCount: number };
type ShareMode = "selection" | "delivery";
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

function selectionRateLimitMessage(retryAfter: number | undefined) {
  const waitSeconds = typeof retryAfter === "number" && Number.isInteger(retryAfter)
    && retryAfter > 0 && retryAfter <= 60 ? retryAfter : 60;
  return `Muitas altera\u00e7\u00f5es em pouco tempo. Aguarde ${waitSeconds} segundos antes de tentar novamente.`;
}

export function GallerySelection({ token, photos: initialPhotos, photoCount, selectedPhotoIds, submittedAt, revisionMessage, downloadsEnabled, selectionLimit, shareMode }: {
  token: string; photos: Photo[]; photoCount: number; selectedPhotoIds: string[]; submittedAt: string | null; revisionMessage: string | null; downloadsEnabled: boolean; selectionLimit: number; shareMode: ShareMode;
}) {
  const router = useRouter();
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [photos, setPhotos] = useState(initialPhotos);
  const [matchingPhotoCount, setMatchingPhotoCount] = useState(photoCount);
  const [pageOffset, setPageOffset] = useState(initialPhotos.length);
  const [hasMorePhotos, setHasMorePhotos] = useState(initialPhotos.length < photoCount);
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>(shareMode === "delivery" ? [] : selectedPhotoIds));
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [photoSearch, setPhotoSearch] = useState("");
  const [photoPageLoading, setPhotoPageLoading] = useState(false);
  const [photoPageLoadingMore, setPhotoPageLoadingMore] = useState(false);
  const [photoPageError, setPhotoPageError] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(Boolean(submittedAt));
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [noteFeedback, setNoteFeedback] = useState<{ photoId: string; message: string } | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const isDelivery = shareMode === "delivery";
  const searchTimer = useRef<number | null>(null);
  const photoRequestVersion = useRef(0);
  const navigatePhotoRef = useRef<(direction: -1 | 1) => void>(() => {});
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const viewerOpen = activeIndex !== null;
  const activePhoto = activeIndex === null ? null : photos[activeIndex];
  const noteDraft = activePhoto ? noteDrafts[activePhoto.id] ?? activePhoto.client_note ?? "" : "";
  const visiblePhotos = photos;
  const showSelectionDock = !isDelivery && !submitted && selectedIds.size > 0;

  const loadPhotoPage = useCallback(async (offset: number, search: string, selectedOnly: boolean, append: boolean): Promise<Photo[] | null> => {
    const requestVersion = ++photoRequestVersion.current;
    if (append) setPhotoPageLoadingMore(true);
    else setPhotoPageLoading(true);
    setPhotoPageError("");
    try {
      const query = new URLSearchParams({ offset: String(offset) });
      if (search.trim()) query.set("q", search.trim());
      if (selectedOnly) query.set("selected", "1");
      const response = await fetch(`/g/${token}/photos?${query}`, { cache: "no-store" });
      const result = await response.json() as Partial<PhotoPage> & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Não foi possível carregar as fotos.");
      if (!Array.isArray(result.photos) || typeof result.totalCount !== "number") {
        throw new Error("A resposta da galeria está incompleta. Atualize a página e tente novamente.");
      }
      if (requestVersion !== photoRequestVersion.current) return null;
      setPhotos(current => append ? [...current, ...result.photos!] : result.photos!);
      setMatchingPhotoCount(result.totalCount);
      setPageOffset(offset + result.photos.length);
      setHasMorePhotos(offset + result.photos.length < result.totalCount);
      return result.photos;
    } catch (cause) {
      if (requestVersion === photoRequestVersion.current) {
        setPhotoPageError(cause instanceof Error ? cause.message : "Não foi possível carregar as fotos.");
      }
      return null;
    } finally {
      if (requestVersion === photoRequestVersion.current) {
        setPhotoPageLoading(false);
        setPhotoPageLoadingMore(false);
      }
    }
  }, [token]);

  function changePhotoSearch(value: string) {
    setPhotoSearch(value);
    setActiveIndex(null);
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    photoRequestVersion.current += 1;
    setPhotos([]);
    setMatchingPhotoCount(0);
    setPageOffset(0);
    setHasMorePhotos(false);
    setPhotoPageError("");
    setPhotoPageLoading(true);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      void loadPhotoPage(0, value, showSelectedOnly, false);
    }, 250);
  }

  function changeSelectedFilter(selectedOnly: boolean) {
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    photoRequestVersion.current += 1;
    setShowSelectedOnly(selectedOnly);
    setActiveIndex(null);
    setPhotos([]);
    setMatchingPhotoCount(0);
    setPageOffset(0);
    setHasMorePhotos(false);
    setPhotoPageError("");
    setPhotoPageLoading(true);
    void loadPhotoPage(0, photoSearch, selectedOnly, false);
  }

  const loadMorePhotos = useCallback(async (): Promise<Photo[] | null> => {
    if (!hasMorePhotos || busy || photoPageLoading || photoPageLoadingMore) return null;
    return loadPhotoPage(pageOffset, photoSearch, showSelectedOnly, true);
  }, [busy, hasMorePhotos, loadPhotoPage, pageOffset, photoPageLoading, photoPageLoadingMore, photoSearch, showSelectedOnly]);

  const navigatePhoto = useCallback(async (direction: -1 | 1) => {
    if (activeIndex === null || photos.length === 0) return;
    if (direction < 0) {
      setActiveIndex(activeIndex === 0 ? photos.length - 1 : activeIndex - 1);
      return;
    }
    if (activeIndex < photos.length - 1) {
      setActiveIndex(activeIndex + 1);
      return;
    }
    if (hasMorePhotos) {
      const nextPage = await loadMorePhotos();
      if (nextPage?.length) setActiveIndex(photos.length);
      return;
    }
    setActiveIndex(0);
  }, [activeIndex, hasMorePhotos, loadMorePhotos, photos.length]);

  useEffect(() => {
    navigatePhotoRef.current = direction => { void navigatePhoto(direction); };
  }, [navigatePhoto]);

  useEffect(() => () => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    photoRequestVersion.current += 1;
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!viewerOpen || !dialog) return;
    if (!dialog.open) dialog.showModal();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        navigatePhotoRef.current(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigatePhotoRef.current(-1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (dialog.open) dialog.close();
    };
  }, [viewerOpen]);

  async function toggle(photo: Photo) {
    if (busy || submitted) return;
    setBusy(true); setError(""); setMessage("");
    const selected = !selectedIds.has(photo.id);
    try {
      const response = await fetch(`/g/${token}/selection`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", photoId: photo.id, selected }),
      });
      const result = await response.json() as { count?: number; error?: string; retryAfter?: number };
      if (response.status === 429) throw new Error(selectionRateLimitMessage(result.retryAfter));
      if (!response.ok) throw new Error(result.error?.includes("SELECTION_SUBMITTED")
        ? "Esta seleção já foi enviada. Atualize a página."
        : result.error?.includes("SELECTION_LIMIT") ? `Este link permite escolher até ${selectionLimit} ${selectionLimit === 1 ? "foto" : "fotos"}.`
          : result.error ?? "Não foi possível salvar a escolha. Atualize a página e tente novamente.");
      if (typeof result.count !== "number") throw new Error("Acesso negado. Reabra o link e informe o PIN.");
      setSelectedIds(current => {
        const next = new Set(current);
        if (selected) next.add(photo.id); else next.delete(photo.id);
        return next;
      });
      if (showSelectedOnly && !selected) {
        setPhotos(current => current.filter(item => item.id !== photo.id));
        setMatchingPhotoCount(current => Math.max(0, current - 1));
        setPageOffset(current => Math.max(0, current - 1));
        setHasMorePhotos(current => current || photos.length - 1 < matchingPhotoCount - 1);
      }
      setMessage("Escolha salva.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a escolha."); }
    finally { setBusy(false); }
  }

  async function submitSelection() {
    if (busy || submitted || selectedIds.size === 0) return;
    if (name.trim().length < 2 || name.trim().length > 80) { setError("Informe seu nome com 2 a 80 caracteres."); return; }
    if (!window.confirm(`Enviar a seleção de ${selectedIds.size} ${selectedIds.size === 1 ? "foto" : "fotos"}? Depois do envio, ela não poderá ser alterada por este link.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/g/${token}/selection`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit", clientName: name.trim() }),
      });
      const result = await response.json() as { submitted?: boolean; error?: string; retryAfter?: number };
      if (response.status === 429) throw new Error(selectionRateLimitMessage(result.retryAfter));
      if (!response.ok) throw new Error(result.error ?? "Não foi possível enviar a seleção.");
      if (result.submitted !== true) throw new Error("Uma foto escolhida deixou de estar disponível ou o acesso expirou. Atualize a página e revise a seleção.");
      setSubmitted(true);
      setMessage("Seleção enviada. O fotógrafo já pode conferir suas escolhas.");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível enviar a seleção."); }
    finally { setBusy(false); }
  }

  async function clearSelection() {
    if (busy || submitted || selectedIds.size === 0) return;
    const choiceCount = selectedIds.size;
    if (!window.confirm(`Limpar as ${choiceCount} ${choiceCount === 1 ? "foto escolhida" : "fotos escolhidas"} e suas observa\u00e7\u00f5es? Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/g/${token}/selection`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      const result = await response.json() as { removedCount?: number; error?: string; retryAfter?: number };
      if (response.status === 429) throw new Error(selectionRateLimitMessage(result.retryAfter));
      if (!response.ok) throw new Error(result.error ?? "N\u00e3o foi poss\u00edvel limpar a sele\u00e7\u00e3o.");
      if (typeof result.removedCount !== "number") throw new Error("Acesso negado. Reabra o link e informe o PIN.");

      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
      photoRequestVersion.current += 1;
      setSelectedIds(new Set());
      setNoteDrafts({});
      setNoteFeedback(null);
      setPhotos(current => current.map(photo => ({ ...photo, selected: false, client_note: null })));
      setMessage("Sele\u00e7\u00e3o limpa; as observa\u00e7\u00f5es tamb\u00e9m foram removidas.");
      if (showSelectedOnly) {
        setPhotos([]);
        setMatchingPhotoCount(0);
        setPageOffset(0);
        setHasMorePhotos(false);
      } else {
        void loadPhotoPage(0, photoSearch, false, false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "N\u00e3o foi poss\u00edvel limpar a sele\u00e7\u00e3o.");
    } finally { setBusy(false); }
  }

  async function savePhotoNote() {
    if (!activePhoto || isDelivery || submitted || !selectedIds.has(activePhoto.id) || noteSaving) return;
    const note = noteDraft.trim();
    if (Array.from(note).length > 500) {
      setNoteFeedback({ photoId: activePhoto.id, message: "A observação pode ter até 500 caracteres." });
      return;
    }
    setNoteSaving(true);
    setNoteFeedback(null);
    try {
      const response = await fetch(`/g/${token}/selection`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "note", photoId: activePhoto.id, note }),
      });
      const result = await response.json() as { note?: string | null; error?: string; retryAfter?: number };
      if (response.status === 429) throw new Error(selectionRateLimitMessage(result.retryAfter));
      if (!response.ok) throw new Error(result.error ?? "Não foi possível salvar a observação.");
      if (typeof result.note !== "string" && result.note !== null) throw new Error("Não foi possível confirmar a observação salva.");
      const savedNote = result.note;
      setPhotos(current => current.map(photo => photo.id === activePhoto.id ? { ...photo, client_note: savedNote } : photo));
      setNoteDrafts(current => ({ ...current, [activePhoto.id]: savedNote ?? "" }));
      setNoteFeedback({ photoId: activePhoto.id, message: "Observação salva." });
    } catch (cause) {
      setNoteFeedback({ photoId: activePhoto.id, message: cause instanceof Error ? cause.message : "Não foi possível salvar a observação." });
    } finally {
      setNoteSaving(false);
    }
  }

  return <section id="gallery-photos" aria-labelledby="selection-heading" className={`gallery-selection${isDelivery ? " is-delivery" : ""}${showSelectionDock ? " has-selection-dock" : ""}`}>
    <div className="gallery-selection-heading">
      <div>
        <h2 id="selection-heading">{isDelivery ? "Entrega completa" : "Escolha suas fotos"}</h2>
        {isDelivery && <p className="gallery-selection-intro delivery-intro">{downloadsEnabled ? "Todas as fotos prontas estão disponíveis para visualização e download dos originais." : "Todas as fotos prontas estão disponíveis para visualização. O fotógrafo desativou os downloads dos originais."}</p>}
        {!isDelivery && <p className="gallery-selection-intro">{submitted ? "Sua seleção foi enviada e está fechada para alterações." : `Marque até ${selectionLimit} ${selectionLimit === 1 ? "foto" : "fotos"}. Suas escolhas são salvas neste link e podem ser revisadas antes do envio.`}</p>}
      </div>
      <div className="flex flex-col items-end gap-3 text-right">
        <p className="gallery-selection-intro">{isDelivery ? photoSearch.trim() ? `${matchingPhotoCount} resultados` : `${photoCount} fotos prontas` : `${selectedIds.size} de ${selectionLimit} escolhidas`}</p>
        {downloadsEnabled && (isDelivery || submitted) && (isDelivery ? photoCount > 0 : selectedIds.size > 0) && <a
          className="button-secondary"
          href={`/g/${token}/download/zip`}
        >{isDelivery ? "Baixar todas em ZIP" : "Baixar seleção em ZIP"}</a>}
      </div>
    </div>
    {showSelectionDock && <nav className="gallery-selection-dock" aria-label="Atalho para finalizar a seleção" aria-live="polite" aria-atomic="true">
      <p><strong>{selectedIds.size}</strong> {selectedIds.size === 1 ? "foto selecionada" : "fotos selecionadas"}</p>
      <a className="button" href="#selection-submission">Ir para envio <span aria-hidden="true">↓</span></a>
    </nav>}
    {!submitted && revisionMessage && <div className="panel space-y-2 border-amber-300/30" aria-label="Solicitação de ajustes do fotógrafo">
      <p className="font-medium text-amber-200">O fotógrafo pediu ajustes na sua seleção</p>
      <p className="text-stone-200">{revisionMessage}</p>
      <p className="text-sm text-stone-400">Suas escolhas anteriores foram mantidas. Revise-as e envie a seleção novamente.</p>
    </div>}
    {photoCount > 0 && <div className="gallery-photo-toolbar">
      {!isDelivery && <div className="gallery-photo-filters" role="group" aria-label="Filtrar fotos">
        <button type="button" className="gallery-photo-filter" aria-pressed={!showSelectedOnly} disabled={!hydrated || photoPageLoading} onClick={() => changeSelectedFilter(false)}>Todas as fotos ({photoCount})</button>
        <button type="button" className="gallery-photo-filter" aria-pressed={showSelectedOnly} disabled={!hydrated || photoPageLoading} onClick={() => changeSelectedFilter(true)}>Selecionadas ({selectedIds.size})</button>
      </div>}
      <label className="field gallery-photo-search">Buscar pelo nome do arquivo
        <input type="search" value={photoSearch} onChange={event => changePhotoSearch(event.target.value)} placeholder="Ex.: IMG_2048" autoComplete="off" />
      </label>
    </div>}
    {photoPageLoading && photos.length === 0 && <p className="panel text-stone-300" role="status">Carregando fotos…</p>}
    {photoPageError && <p className="panel text-amber-200" role="alert">{photoPageError}</p>}
    {!photoPageLoading && !photoPageError && photos.length === 0 && matchingPhotoCount === 0 && <div className="gallery-photo-empty" role="status">
      <p>{photoSearch.trim()
        ? showSelectedOnly ? "Nenhuma foto selecionada corresponde à busca." : `Nenhuma foto encontrada para “${photoSearch.trim()}”.`
        : showSelectedOnly ? "Nenhuma foto selecionada ainda." : "As imagens desta galeria ainda estão sendo preparadas."}</p>
      <div className="flex flex-wrap justify-center gap-3">
        {photoSearch.trim() && <button type="button" className="button-secondary" onClick={() => changePhotoSearch("")}>Limpar busca</button>}
        {showSelectedOnly && <button type="button" className="button-secondary" onClick={() => changeSelectedFilter(false)}>Ver todas as fotos</button>}
      </div>
    </div>}
    {visiblePhotos.length > 0 && <ul className="gallery-photo-grid">
      {visiblePhotos.map(photo => {
        const selected = selectedIds.has(photo.id);
        return <li key={photo.id} className="gallery-photo-card">
          <button type="button" className="gallery-photo-open" disabled={!hydrated} onClick={() => setActiveIndex(photos.findIndex(item => item.id === photo.id))} aria-label={`Ampliar ${photo.name}`}>
            <Image unoptimized width={400} height={400} src={`/g/${token}/image/${photo.id}?size=thumb`} alt={photo.name} className="aspect-square w-full rounded-lg object-cover" />
          </button>
          <p className="gallery-photo-name" title={photo.name}>{photo.name}</p>
          {selected && photo.client_note && <p className="gallery-photo-client-note" title={photo.client_note}>Observação: {photo.client_note}</p>}
          {isDelivery ? downloadsEnabled ? <a className="button mt-3 block text-center" href={`/g/${token}/download/${photo.id}`}>Baixar original</a> : <p className="mt-3 text-sm text-stone-400">Download desativado</p> : submitted ? <>
            <p className="mt-3 text-sm text-amber-300">{selected ? "Selecionada" : "Não selecionada"}</p>
            {selected && downloadsEnabled && <a className="button mt-3 block text-center" href={`/g/${token}/download/${photo.id}`}>Baixar original</a>}
          </>
            : <button type="button" disabled={!hydrated || busy || (!selected && selectedIds.size >= selectionLimit)} onClick={() => toggle(photo)}
                className="gallery-photo-select"
                aria-label={`${selected ? "Remover seleção" : "Selecionar"} ${photo.name}`} aria-pressed={selected}>
                {selected ? "✓ Selecionada" : "＋ Selecionar foto"}
              </button>}
        </li>;
      })}
    </ul>}
    {hasMorePhotos && <div className="mt-6 flex flex-col items-center gap-3">
      <p className="text-sm text-stone-400">Mostrando {photos.length} de {matchingPhotoCount} fotos</p>
      <button type="button" className="button-secondary" disabled={photoPageLoadingMore || photoPageLoading || busy} onClick={() => void loadMorePhotos()}>{photoPageLoadingMore ? "Carregando fotos…" : photoPageError ? "Tentar novamente" : "Carregar mais fotos"}</button>
    </div>}
    {photoPageError && photos.length === 0 && <button type="button" className="button-secondary" disabled={photoPageLoading} onClick={() => void loadPhotoPage(0, photoSearch, showSelectedOnly, false)}>Tentar carregar novamente</button>}
    {!isDelivery && <div id="selection-submission" tabIndex={-1} className="panel gallery-submission-card">
      <p className="gallery-submission-count">{selectedIds.size} <span>{selectedIds.size === 1 ? "foto escolhida" : "fotos escolhidas"}</span></p>
      {!submitted && <>
        <label className="field">Seu nome<input value={name} onChange={event => setName(event.target.value)} maxLength={80} autoComplete="name" disabled={!hydrated || busy} /></label>
        <div className="gallery-submission-actions">
          <button type="button" className="button" disabled={!hydrated || busy || selectedIds.size === 0} onClick={submitSelection}>Revisar e enviar seleção</button>
          {selectedIds.size > 0 && <button type="button" className="button-secondary" disabled={!hydrated || busy} onClick={clearSelection}>{"Limpar sele\u00e7\u00e3o"}</button>}
        </div>
        <p className="text-sm text-stone-400">Confirme o envio na próxima etapa. Depois disso, este link não aceitará mudanças.</p>
      </>}
      {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </div>}
    {isDelivery && <div className="panel gallery-submission-card delivery-summary">
      <p className="gallery-submission-count">{photoCount} <span>{photoCount === 1 ? "foto na entrega" : "fotos na entrega"}</span></p>
      <p className="text-sm text-stone-400">{downloadsEnabled ? "Os originais podem ser baixados enquanto este link estiver ativo." : "A visualização permanece disponível, mas os downloads estão desativados."}</p>
      {downloadsEnabled && <p className="text-sm text-stone-400">O pacote ZIP aceita até 500 MiB e conta uma emissão para cada foto incluída.</p>}
    </div>}
    {activePhoto && activeIndex !== null && <dialog ref={dialogRef} className="photo-lightbox" aria-label="Visualizador de fotos" onCancel={event => { event.preventDefault(); setActiveIndex(null); }} onClose={() => setActiveIndex(null)} onClick={event => { if (event.target === event.currentTarget) setActiveIndex(null); }}>
      <div className="photo-lightbox-content">
        <header className="photo-lightbox-header">
          <div>
            <p className="photo-lightbox-count">{activeIndex + 1} / {matchingPhotoCount}</p>
            <h2>{activePhoto.name}</h2>
          </div>
          <button type="button" className="photo-lightbox-close" aria-label="Fechar visualizador" onClick={() => setActiveIndex(null)}>×</button>
        </header>
        <div className="photo-lightbox-stage" onPointerDown={event => {
          if (event.pointerType !== "touch" || !event.isPrimary || (event.target instanceof Element && event.target.closest("button"))) {
            swipeStartRef.current = null;
            return;
          }
          swipeStartRef.current = { x: event.clientX, y: event.clientY };
        }} onPointerUp={event => {
          const start = swipeStartRef.current;
          swipeStartRef.current = null;
          if (!start || event.pointerType !== "touch" || !event.isPrimary) return;
          const deltaX = event.clientX - start.x;
          const deltaY = event.clientY - start.y;
          if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
          navigatePhotoRef.current(deltaX < 0 ? 1 : -1);
        }} onPointerCancel={() => { swipeStartRef.current = null; }}>
          <button type="button" className="photo-lightbox-arrow photo-lightbox-previous" aria-label="Foto anterior" disabled={photos.length < 2} onClick={() => void navigatePhoto(-1)}>‹</button>
          <Image unoptimized width={1800} height={1200} src={`/g/${token}/image/${activePhoto.id}?size=preview`} alt={activePhoto.name} className="photo-lightbox-image" priority />
          <button type="button" className="photo-lightbox-arrow photo-lightbox-next" aria-label="Próxima foto" disabled={photos.length < 2 && !hasMorePhotos} onClick={() => void navigatePhoto(1)}>›</button>
        </div>
        {!isDelivery && selectedIds.has(activePhoto.id) && <div className="photo-lightbox-note">
          {submitted
            ? activePhoto.client_note && <p><strong>Observação enviada:</strong> {activePhoto.client_note}</p>
            : <>
              <label htmlFor="photo-client-note">Observação para o fotógrafo</label>
              <textarea id="photo-client-note" rows={2} maxLength={1000} value={noteDraft} disabled={!hydrated || noteSaving || busy}
                onChange={event => {
                  const value = Array.from(event.target.value).slice(0, 500).join("");
                  setNoteDrafts(current => ({ ...current, [activePhoto.id]: value }));
                  setNoteFeedback(current => current?.photoId === activePhoto.id ? null : current);
                }}
                placeholder="Ex.: prefiro esta foto em preto e branco." />
              <div className="photo-lightbox-note-actions">
                <span>{Array.from(noteDraft).length}/500</span>
                <button type="button" disabled={!hydrated || noteSaving || busy || noteDraft === (activePhoto.client_note ?? "")}
                  onClick={() => void savePhotoNote()}>{noteSaving ? "Salvando…" : "Salvar observação"}</button>
              </div>
              {noteFeedback?.photoId === activePhoto.id && <p role="status" className={noteFeedback.message === "Observação salva." ? "is-success" : "is-error"}>{noteFeedback.message}</p>}
            </>}
        </div>}
        {!isDelivery && !submitted && !selectedIds.has(activePhoto.id) && <p className="photo-lightbox-note-hint">Selecione esta foto para adicionar uma observação.</p>}
        <footer className="photo-lightbox-footer">
          {isDelivery ? <div className="photo-lightbox-state">{downloadsEnabled ? "Incluída na entrega" : "Download desativado"}</div> : submitted ? <div className="photo-lightbox-state">{selectedIds.has(activePhoto.id) ? "Selecionada" : "Não selecionada"}</div> : <button type="button" className={`photo-lightbox-select${selectedIds.has(activePhoto.id) ? " is-selected" : ""}`} aria-label={`${selectedIds.has(activePhoto.id) ? "Remover seleção" : "Selecionar"} ${activePhoto.name}`} disabled={!hydrated || busy || (!selectedIds.has(activePhoto.id) && selectedIds.size >= selectionLimit)} onClick={() => void toggle(activePhoto)}>
            {selectedIds.has(activePhoto.id) ? "✓ Selecionada" : "＋ Selecionar foto"}
          </button>}
          {isDelivery && <div className="photo-lightbox-state">{downloadsEnabled ? "Incluída na entrega" : "Download desativado"}</div>}
          <p>Use ← e → ou deslize para navegar · Esc para fechar</p>
          {downloadsEnabled && (isDelivery || (submitted && selectedIds.has(activePhoto.id))) && <a className="button" href={`/g/${token}/download/${activePhoto.id}`}>Baixar original</a>}
        </footer>
      </div>
    </dialog>}
  </section>;
}

"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { gallerySelectionRevisionWhatsAppUrl, whatsappMessageUrl } from "@/lib/gallery-sharing-message";
import { gallerySelectionCsv, gallerySelectionCsvFilename } from "@/lib/gallery-selection-csv";

type ShareMode = "selection" | "delivery";
type NotificationType = "selection_submitted" | "selection_revision_requested";
type NotificationStatus = {
  notification_type: NotificationType;
  delivery_state: "queued" | "sending" | "retry_wait" | "failed" | "sent";
  attempts: number;
  manual_retry_count: number;
};
type Share = {
  id: string; created_at: string; last_rotated_at: string | null; expires_at: string; revoked_at: string | null;
  share_mode: ShareMode; submitted_at: string | null; submitted_name: string | null;
  selection_reviewed_at: string | null;
  revision_requested_at: string | null; revision_message: string | null;
  downloads_enabled: boolean; selection_limit: number; pin_enabled: boolean;
  gallery_selection_items: { photo_id: string; original_filename: string; client_note?: string | null }[];
  gallery_download_counts: { photo_id: string; download_count: number }[];
  notification_statuses: NotificationStatus[];
  gallery_selection_revisions: {
    id: string; revision_number: number; submitted_at: string; submitted_name: string; revision_message: string;
    gallery_selection_revision_items: { photo_id: string; original_filename: string; client_note?: string | null }[];
  }[];
};

function notificationStatusLabel(state: NotificationStatus["delivery_state"], attempts: number) {
  switch (state) {
    case "queued": return "Aviso aguardando envio por e-mail.";
    case "sending": return "Aviso em processamento pelo serviço de e-mail.";
    case "retry_wait": return `Falha temporária; nova tentativa programada (${attempts}/5).`;
    case "failed": return "O envio automático falhou após 5 tentativas. Você pode tentar novamente por e-mail ou avisar pelo WhatsApp.";
    case "sent": return "O serviço de e-mail aceitou o aviso para envio.";
  }
}

function notificationStatusStyle(state: NotificationStatus["delivery_state"]) {
  if (state === "failed") return "text-red-300";
  if (state === "retry_wait") return "text-amber-200";
  if (state === "sent") return "text-emerald-300";
  return "text-stone-400";
}

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
const expiresInDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

export function GallerySharing({ tenantId, galleryId, galleryTitle, customerEmail, customerWhatsAppPhone, status, readyPhotoCount, shares }: {
  tenantId: string; galleryId: string; galleryTitle: string; customerEmail: string | null; customerWhatsAppPhone: string | null; status: string; readyPhotoCount: number; shares: Share[];
}) {
  const router = useRouter();
  const linkInput = useRef<HTMLInputElement>(null);
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [days, setDays] = useState(7);
  const [selectionLimit, setSelectionLimit] = useState(10);
  const [pin, setPin] = useState("");
  const [shareMode, setShareMode] = useState<ShareMode>("selection");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [linkHasPin, setLinkHasPin] = useState(false);
  const [copyingLink, setCopyingLink] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [revisionMessages, setRevisionMessages] = useState<Record<string, string>>({});
  const canCreate = status === "published";
  const hasReadyPhotos = readyPhotoCount > 0;

  async function createShare() {
    if (busy || !canCreate) return;
    if (!hasReadyPhotos) { setError("Processe pelo menos uma foto antes de criar um link."); return; }
    if (pin && !/^[0-9]{6,12}$/.test(pin)) { setError("O PIN deve ter de 6 a 12 números."); return; }
    if (shareMode === "delivery" && !window.confirm(
      "Este link permitirá baixar os originais de todas as fotos prontas da galeria sem exigir seleção do cliente. Cada foto tem limite de 3 emissões de download; o link expira na validade escolhida e pode ser revogado a qualquer momento. Continuar?",
    )) return;
    setBusy(true); setError(""); setMessage(""); setLink("");
    try {
      const { data, error: rpcError } = await createClient().rpc("create_gallery_share", {
        p_tenant_id: tenantId, p_gallery_id: galleryId,
        p_expires_at: expiresInDays(days),
        p_selection_limit: selectionLimit,
        p_share_mode: shareMode,
        p_pin: pin || null,
      });
      if (rpcError?.message.includes("SHARE_NO_READY_PHOTOS")) throw new Error("Processe pelo menos uma foto antes de criar um link.");
      if (rpcError || typeof data !== "string") throw new Error("Não foi possível criar o link. Atualize a galeria e tente novamente.");
      setLink(`${window.location.origin}/g/${data}`);
      setLinkHasPin(Boolean(pin));
      setMessage(pin ? "Link criado. Envie o PIN ao cliente por outro canal; ele não será mostrado novamente." : "Link criado. Copie-o agora; ele não será mostrado novamente.");
      setPin("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível criar o link.");
    } finally { setBusy(false); }
  }

  async function copyShareLink() {
    if (!link || copyingLink) return;
    setCopyingLink(true);
    setError(""); setMessage("");
    try {
      await navigator.clipboard.writeText(link);
      setMessage("Link copiado. Agora você pode enviá-lo ao cliente.");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setMessage("Não foi possível copiar automaticamente. O link está selecionado para você copiá-lo manualmente.");
    } finally { setCopyingLink(false); }
  }

  function whatsappShareUrl() {
    const note = linkHasPin ? " O PIN de acesso deve ser enviado por uma mensagem separada." : "";
    const text = `Olá! Sua galeria “${galleryTitle}” está pronta: ${link}${note}`;
    return whatsappMessageUrl(text, customerWhatsAppPhone);
  }

  function whatsappRevisionUrl(share: Share) {
    return gallerySelectionRevisionWhatsAppUrl(galleryTitle, share.revision_message ?? "", share.pin_enabled, customerWhatsAppPhone);
  }

  function downloadSelectionCsv(share: Share) {
    const csv = gallerySelectionCsv(share.gallery_selection_items);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = gallerySelectionCsvFilename(galleryTitle);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function rotateShare(share: Share) {
    if (busy || !canCreate || share.revoked_at) return;
    if (!hasReadyPhotos) { setError("Processe pelo menos uma foto antes de gerar um novo link."); return; }
    const pinReminder = share.pin_enabled ? " O PIN atual será mantido e deve ser enviado separadamente." : "";
    if (!window.confirm(`Gerar um novo link? O endereço atual será invalidado imediatamente. A seleção, o histórico e as permissões serão mantidos, e a validade começará novamente em ${days} dias.${pinReminder} Continuar?`)) return;
    setBusy(true); setError(""); setMessage(""); setLink("");
    try {
      const { data, error: rpcError } = await createClient().rpc("rotate_gallery_share", {
        p_tenant_id: tenantId,
        p_gallery_id: galleryId,
        p_share_id: share.id,
        p_expires_at: expiresInDays(days),
      });
      if (rpcError || typeof data !== "string" || !/^[0-9a-f]{64}$/.test(data)) {
        const databaseMessage = rpcError?.message ?? "";
        if (databaseMessage.includes("SHARE_NO_READY_PHOTOS")) throw new Error("Processe pelo menos uma foto antes de gerar um novo link.");
        if (databaseMessage.includes("SHARE_ROTATION_DENIED")) throw new Error("Este link foi revogado ou a galeria não está publicada. Atualize o painel e tente novamente.");
        throw new Error("Não foi possível gerar um novo link. Atualize a galeria e tente novamente.");
      }
      setLink(`${window.location.origin}/g/${data}`);
      setLinkHasPin(share.pin_enabled);
      setMessage(share.pin_enabled
        ? "Novo link gerado. O endereço anterior foi invalidado; o PIN existente foi mantido."
        : "Novo link gerado. O endereço anterior foi invalidado.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerar um novo link.");
    } finally { setBusy(false); }
  }

  async function revokeShare(share: Share) {
    if (busy || !window.confirm("Revogar este link? Quem o recebeu perderá o acesso imediatamente.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await createClient().rpc("revoke_gallery_share", {
        p_tenant_id: tenantId, p_gallery_id: galleryId, p_share_id: share.id,
      });
      if (result.error || result.data !== true) throw new Error("Não foi possível revogar o link. Tente novamente.");
      setLink("");
      setMessage("Link revogado.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível revogar o link.");
    } finally { setBusy(false); }
  }

  async function setDownloads(share: Share, enabled: boolean) {
    if (busy) return;
    if (enabled) {
      const scope = share.share_mode === "delivery" ? "todas as fotos prontas da galeria" : "as fotos selecionadas pelo cliente";
      if (!window.confirm(`Permitir que este link baixe os originais de ${scope}? O acesso permanece sujeito à validade e ao limite de downloads por foto.`)) return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await createClient().rpc("set_gallery_share_downloads", {
        p_tenant_id: tenantId, p_gallery_id: galleryId, p_share_id: share.id, p_enabled: enabled,
      });
      if (result.error || result.data !== true) throw new Error("Não foi possível alterar a permissão de download.");
      setMessage(enabled ? "Download dos originais liberado para este link." : "Download dos originais desativado.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível alterar a permissão de download.");
    } finally { setBusy(false); }
  }

  async function requestSelectionRevision(share: Share) {
    if (busy) return;
    const note = (revisionMessages[share.id] ?? "").trim();
    if (note.length < 2 || note.length > 500) { setError("Escreva uma orientação de 2 a 500 caracteres para o cliente."); return; }
    const emailNotice = customerEmail
      ? ` Um aviso será enviado para ${customerEmail}.`
      : " Esta galeria não tem e-mail de cliente cadastrado; você poderá avisá-lo pelo WhatsApp.";
    if (!window.confirm(`A seleção atual será guardada no histórico, o cliente poderá alterá-la pelo mesmo link e os downloads dos originais serão pausados até você liberar novamente.${emailNotice} Continuar?`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await createClient().rpc("request_gallery_selection_revision", {
        p_tenant_id: tenantId, p_gallery_id: galleryId, p_share_id: share.id, p_message: note,
      });
      if (result.error || result.data !== true) {
        const databaseMessage = result.error?.message ?? "";
        if (databaseMessage.includes("SELECTION_REVISION_DENIED")) throw new Error("Este link foi revogado ou venceu. Publique a galeria e crie um novo link para continuar.");
        if (databaseMessage.includes("SELECTION_NOT_SUBMITTED")) throw new Error("A seleção mudou desde que a página foi aberta. Atualize a galeria e confira o estado mais recente.");
        throw new Error("Não foi possível solicitar os ajustes. Atualize a galeria e tente novamente.");
      }
      setRevisionMessages(current => ({ ...current, [share.id]: "" }));
      setMessage(customerEmail
        ? `Ajustes solicitados. O aviso será enviado para ${customerEmail}; o WhatsApp também está disponível.`
        : "Ajustes solicitados. Este cliente não tem e-mail cadastrado; use a mensagem pronta no WhatsApp para avisá-lo.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível solicitar os ajustes.");
    } finally { setBusy(false); }
  }

  async function retryFailedNotification(share: Share, notificationType: NotificationType) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await createClient().rpc("retry_failed_gallery_notification", {
        p_tenant_id: tenantId,
        p_gallery_id: galleryId,
        p_share_id: share.id,
        p_notification_type: notificationType,
      });
      if (result.error?.message.includes("NOTIFICATION_RETRY_LIMIT")) {
        throw new Error("Este aviso já atingiu o limite de novas tentativas manuais.");
      }
      if (result.error?.message.includes("NOTIFICATION_RETRY_UNAVAILABLE")) {
        throw new Error("Este aviso não pode mais ser reenviado porque a seleção mudou ou o link não está ativo.");
      }
      if (result.error?.message.includes("NOTIFICATION_RECIPIENT_MISSING")) {
        throw new Error("Cadastre novamente o e-mail do destinatário antes de tentar enviar o aviso.");
      }
      if (result.error || result.data !== true) throw new Error("Não foi possível colocar o aviso novamente na fila.");
      setMessage("Novo envio de e-mail colocado na fila. O endereço atualizado do cadastro será usado.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível reenviar o aviso por e-mail.");
    } finally { setBusy(false); }
  }

  async function setSelectionReviewed(share: Share, reviewed: boolean) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await createClient().rpc("set_gallery_selection_reviewed", {
        p_tenant_id: tenantId, p_gallery_id: galleryId, p_share_id: share.id, p_reviewed: reviewed,
      });
      if (result.error || result.data !== true) {
        throw new Error(result.error?.message.includes("SELECTION_REVIEW_DENIED")
          ? "A seleção mudou desde que a página foi aberta. Atualize a galeria e confira o estado mais recente."
          : "Não foi possível atualizar o estado da seleção.");
      }
      setMessage(reviewed ? "Seleção marcada como conferida." : "Seleção voltou para as pendências.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível atualizar o estado da seleção.");
    } finally { setBusy(false); }
  }

  return <section className="panel space-y-4" aria-labelledby="sharing-heading">
    <h2 id="sharing-heading" className="text-xl font-semibold">Compartilhamento da galeria</h2>
    <p className="text-sm text-stone-300">Escolha se o cliente vai selecionar as fotos para entrega ou receber acesso aos originais de todas as fotos prontas.</p>
    {canCreate ? <div className="flex flex-wrap items-end gap-3">
      <label className="field min-w-52">Modo do link<select value={shareMode} disabled={!hydrated || busy} onChange={event => setShareMode(event.target.value as ShareMode)}>
        <option value="selection">Cliente escolhe fotos</option><option value="delivery">Entrega completa</option>
      </select></label>
      <label className="field min-w-40">Validade do link<select value={days} disabled={!hydrated || busy} onChange={event => setDays(Number(event.target.value))}>
        <option value={1}>1 dia</option><option value={7}>7 dias</option><option value={14}>14 dias</option>
      </select></label>
      <label className="field min-w-40">PIN opcional<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={pin} disabled={!hydrated || busy} onChange={event => setPin(event.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="Sem PIN" /></label>
      {shareMode === "selection" && <label className="field min-w-40">Limite de escolhas<select value={selectionLimit} disabled={!hydrated || busy} onChange={event => setSelectionLimit(Number(event.target.value))}>
        {[1, 5, 10, 20, 50, 100, 500].map(limit => <option key={limit} value={limit}>{limit === 500 ? "Até 500 fotos" : `${limit} ${limit === 1 ? "foto" : "fotos"}`}</option>)}
      </select></label>}
      <button type="button" className="button" disabled={!hydrated || busy || !hasReadyPhotos} onClick={createShare}>Criar link</button>
      {!hasReadyPhotos
        ? <p className="w-full text-sm text-amber-200">Processe pelo menos uma foto antes de criar um link para o cliente.</p>
        : <p className="w-full text-sm text-stone-400">{shareMode === "selection"
        ? "O cliente escolhe até o limite definido. Você libera os downloads dos originais depois que a seleção for enviada."
        : "O cliente vê e pode baixar os originais de todas as fotos prontas. Downloads já começam liberados e podem ser desativados."}</p>}
      <p className="w-full text-sm text-stone-400">O PIN é opcional, deve ter de 6 a 12 números e deve ser enviado ao cliente por outro canal.</p>
    </div> : <p className="text-sm text-stone-400">Publique a galeria para criar um link. Ao despublicar ou arquivar, os links existentes são revogados.</p>}
    {link && <div className="space-y-3">
      <label className="field">Novo link<input ref={linkInput} value={link} readOnly onFocus={event => event.currentTarget.select()} /></label>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="button" disabled={!hydrated || copyingLink} onClick={copyShareLink}>{copyingLink ? "Copiando…" : "Copiar link"}</button>
        <a className="button-secondary" href={whatsappShareUrl()} target="_blank" rel="noreferrer">Compartilhar pelo WhatsApp</a>
      </div>
    </div>}
    {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {shares.length > 0 && <ul className="space-y-3">{shares.map(share => {
      const revocable = !share.revoked_at && canCreate;
      const canRequestRevision = !share.revoked_at && canCreate && share.share_mode === "selection" && Boolean(share.submitted_at);
      const downloadCount = share.gallery_download_counts.reduce((total, item) => total + item.download_count, 0);
      const activeNotificationType = share.submitted_at
        ? "selection_submitted"
        : share.revision_requested_at ? "selection_revision_requested" : null;
      const activeNotification = activeNotificationType
        ? share.notification_statuses.find(item => item.notification_type === activeNotificationType)
        : undefined;
      return <li key={share.id} className="rounded-lg border border-white/10 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3"><span>Link criado em {new Date(share.created_at).toLocaleDateString("pt-BR")} {share.last_rotated_at && `· atualizado em ${new Date(share.last_rotated_at).toLocaleDateString("pt-BR")}`} · {share.revoked_at ? "revogado" : `validade: ${new Date(share.expires_at).toLocaleDateString("pt-BR")}`} · {share.pin_enabled ? "PIN protegido" : "sem PIN"}</span>
        {revocable && <div className="flex items-center gap-3">
          <button type="button" disabled={!hydrated || busy || !hasReadyPhotos} title={!hasReadyPhotos ? "Processe pelo menos uma foto para gerar outro link." : undefined} onClick={() => rotateShare(share)} className="text-amber-300 underline">Gerar novo link</button>
          <button type="button" disabled={!hydrated || busy} onClick={() => revokeShare(share)} className="text-amber-300 underline">Revogar link</button>
        </div>}
        </div>
        {share.share_mode === "delivery" ? <p className="mt-2 text-stone-300">Entrega completa · originais de todas as fotos prontas</p> : <>
          <p className="mt-2 text-stone-300">{share.submitted_at ? `Seleção enviada por ${share.submitted_name} em ${new Date(share.submitted_at).toLocaleDateString("pt-BR")}` : share.revision_requested_at ? `Aguardando ajustes do cliente desde ${new Date(share.revision_requested_at).toLocaleDateString("pt-BR")}` : "Seleção em andamento"} · {share.gallery_selection_items.length} de {share.selection_limit} fotos</p>
          {activeNotification && <p className={`mt-1 ${notificationStatusStyle(activeNotification.delivery_state)}`}>
            {activeNotificationType === "selection_submitted" ? "Aviso ao fotógrafo" : "Aviso ao cliente"}: {notificationStatusLabel(activeNotification.delivery_state, activeNotification.attempts)}
          </p>}
          {activeNotification?.delivery_state === "failed" && activeNotification.manual_retry_count < 2 && activeNotificationType && <button
            type="button" className="mt-1 text-amber-300 underline" disabled={!hydrated || busy}
            onClick={() => void retryFailedNotification(share, activeNotificationType)}
          >Tentar novamente por e-mail</button>}
          {activeNotification?.delivery_state === "failed" && activeNotification.manual_retry_count >= 2 && <p className="mt-1 text-sm text-stone-400">Limite de duas novas tentativas manuais atingido.</p>}
          {share.revision_requested_at && <p className="text-sm text-amber-200">Downloads suspensos até receber a nova seleção.</p>}
          {share.submitted_at && share.gallery_selection_items.length > 0 && <div className="mt-3 space-y-2"><button type="button" className="text-amber-300 underline" onClick={() => downloadSelectionCsv(share)}>Baixar lista CSV</button><ul className="list-inside list-disc text-stone-400">{share.gallery_selection_items.map(item => <li key={item.photo_id} className="break-words">{item.original_filename}{item.client_note && <p className="ml-5 mt-1 text-sm text-stone-300">Observação do cliente: {item.client_note}</p>}</li>)}</ul></div>}
          {share.submitted_at && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 p-3">
            <p className="text-sm text-stone-300">{share.selection_reviewed_at
              ? `Conferida em ${new Date(share.selection_reviewed_at).toLocaleDateString("pt-BR")}`
              : "Esta seleção ainda aguarda sua conferência."}</p>
            <button type="button" className="text-amber-300 underline" disabled={!hydrated || busy} onClick={() => setSelectionReviewed(share, !share.selection_reviewed_at)}>
              {share.selection_reviewed_at ? "Voltar para pendências" : "Marcar como conferida"}
            </button>
          </div>}
          {share.gallery_selection_revisions.length > 0 && <details className="mt-3 rounded-lg border border-white/10 p-3">
            <summary className="cursor-pointer text-stone-300">Histórico de revisões ({share.gallery_selection_revisions.length})</summary>
            <ol className="mt-3 space-y-4">{share.gallery_selection_revisions.map(revision => <li key={revision.id} className="border-l border-amber-300/40 pl-3">
              <p className="font-medium">Versão {revision.revision_number} · enviada por {revision.submitted_name} em {new Date(revision.submitted_at).toLocaleDateString("pt-BR")}</p>
              <p className="mt-1 text-stone-400">Orientação enviada: {revision.revision_message}</p>
              <ul className="mt-1 list-inside list-disc text-stone-400">{revision.gallery_selection_revision_items.map(item => <li key={item.photo_id} className="break-words">{item.original_filename}{item.client_note && <p className="ml-5 mt-1 text-sm text-stone-300">Observação do cliente: {item.client_note}</p>}</li>)}</ul>
            </li>)}</ol>
          </details>}
          {canRequestRevision && <div className="mt-3 space-y-2 rounded-lg border border-amber-300/20 p-3">
            <label className="field">Orientação para ajustes (visível ao cliente)<textarea rows={3} maxLength={500} value={revisionMessages[share.id] ?? ""} disabled={!hydrated || busy} onChange={event => setRevisionMessages(current => ({ ...current, [share.id]: event.target.value }))} placeholder="Ex.: escolha mais duas fotos da cerimônia." /></label>
            <button type="button" className="text-amber-300 underline" disabled={!hydrated || busy} onClick={() => requestSelectionRevision(share)}>Solicitar ajustes na seleção</button>
          </div>}
          {share.revision_requested_at && share.revision_message && <div className="mt-2 space-y-2">
            <p className="text-amber-200">Orientação enviada: {share.revision_message}</p>
            <a className="button-secondary inline-flex" href={whatsappRevisionUrl(share)} target="_blank" rel="noreferrer">Avisar cliente pelo WhatsApp</a>
            <p className="text-xs text-stone-400">A mensagem abre pronta para revisão; o Quadrics não a envia automaticamente.</p>
          </div>}
        </>}
        {(share.share_mode === "delivery" || share.submitted_at) && <div className="mt-3 space-y-2">
          {canCreate && !share.revoked_at && <button type="button" disabled={!hydrated || busy} onClick={() => setDownloads(share, !share.downloads_enabled)} className="text-amber-300 underline">
            {share.downloads_enabled ? "Desativar download dos originais" : "Liberar download dos originais"}
          </button>}
          <p className="text-stone-400">{share.downloads_enabled ? `Downloads liberados · até 3 emissões por foto${share.share_mode === "delivery" ? ` · ${downloadCount} ${downloadCount === 1 ? "emissão registrada" : "emissões registradas"}` : ""}` : "Downloads dos originais desativados"}</p>
          {share.share_mode === "selection" && share.gallery_selection_items.map(item => {
            const count = share.gallery_download_counts.find(event => event.photo_id === item.photo_id)?.download_count ?? 0;
            return <p key={item.photo_id} className="text-xs text-stone-400">{item.original_filename}: {count} {count === 1 ? "emissão de download" : "emissões de download"}</p>;
          })}
        </div>}
      </li>;
    })}</ul>}
  </section>;
}

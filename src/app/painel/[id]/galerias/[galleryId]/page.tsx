import { notFound } from "next/navigation";
import { requireWorkspace } from "@/lib/workspace";
import { isUuid } from "@/lib/gallery-validation";
import { GalleryForm } from "@/components/gallery-form";
import { PhotoUploader } from "@/components/photo-uploader";
import { GallerySharing } from "@/components/gallery-sharing";
import { duplicateGallery } from "@/app/painel/[id]/actions";
import type { StorageUsage, UploadSession } from "@/lib/upload-lifecycle";
import { createMediaReader } from "@/lib/media-storage";
import { panelOriginalUrl } from "@/lib/media-storage-policy";

const initialPhotoGridPageSize = 60;

type GalleryNotificationStatus = {
  share_id: string;
  notification_type: "selection_submitted" | "selection_revision_requested";
  delivery_state: "queued" | "sending" | "retry_wait" | "failed" | "sent";
  attempts: number;
  manual_retry_count: number;
  available_at: string;
};

export default async function EditGalleryPage({ params }: { params: Promise<{ id: string; galleryId: string }> }) {
  const { id, galleryId } = await params;
  const { supabase } = await requireWorkspace(id);
  if (!isUuid(galleryId)) notFound();
  const [gallery, photos, uploads, usage, shares] = await Promise.all([
    supabase.from("galleries").select("id, title, slug, description, customer_id, status, cover_photo_id").eq("tenant_id", id).eq("id", galleryId).maybeSingle(),
    supabase.from("photos").select("id, object_path, storage_provider, original_filename, byte_size, deletion_requested_at, processing_status, sort_order, created_at", { count: "exact" })
      .eq("tenant_id", id).eq("gallery_id", galleryId).is("deletion_requested_at", null)
      .order("sort_order", { ascending: true }).order("created_at", { ascending: false }).order("id", { ascending: true })
      .range(0, initialPhotoGridPageSize - 1),
    supabase.from("upload_sessions").select("id, object_path, storage_provider, original_filename, content_type, byte_size, state, expires_at").eq("tenant_id", id).eq("gallery_id", galleryId).in("state", ["reserved", "canceling"]).order("created_at"),
    supabase.rpc("workspace_storage_usage", { p_tenant_id: id }),
    supabase.from("gallery_shares").select("id, created_at, last_rotated_at, expires_at, revoked_at, submitted_at, submitted_name, selection_reviewed_at, downloads_enabled, selection_limit, share_mode, pin_enabled, revision_requested_at, revision_message").eq("tenant_id", id).eq("gallery_id", galleryId).order("created_at", { ascending: false }),
  ]);
  const [pendingDeletions, readyPhotoCount, processingPhotoCount, firstReadyPhoto] = await Promise.all([
    supabase.from("photos").select("id, object_path, storage_provider, original_filename, byte_size, deletion_requested_at, processing_status")
      .eq("tenant_id", id).eq("gallery_id", galleryId).not("deletion_requested_at", "is", null)
      .order("deletion_requested_at", { ascending: false }).order("id", { ascending: true }),
    supabase.from("photos").select("id", { count: "exact", head: true })
      .eq("tenant_id", id).eq("gallery_id", galleryId).eq("processing_status", "ready").is("deletion_requested_at", null),
    supabase.from("photos").select("id", { count: "exact", head: true })
      .eq("tenant_id", id).eq("gallery_id", galleryId).in("processing_status", ["pending", "processing"]).is("deletion_requested_at", null),
    supabase.from("photos").select("id").eq("tenant_id", id).eq("gallery_id", galleryId)
      .eq("processing_status", "ready").is("deletion_requested_at", null)
      .order("sort_order", { ascending: true }).order("created_at", { ascending: false }).order("id", { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (pendingDeletions.error || readyPhotoCount.error || processingPhotoCount.error || firstReadyPhoto.error) throw new Error("Unable to load gallery photo metadata.");
  if (gallery.error || photos.error || uploads.error || usage.error || shares.error || !usage.data) throw new Error("Não foi possível carregar a galeria.");
  if (!gallery.data) notFound();
  if (!photos.data) throw new Error("Unable to load gallery photos.");
  const selectedCustomerResult = gallery.data.customer_id
    ? await supabase.from("customers").select("id, name, email, whatsapp_phone")
      .eq("tenant_id", id).eq("id", gallery.data.customer_id).maybeSingle()
    : { data: null, error: null };
  if (selectedCustomerResult.error) throw new Error("Não foi possível carregar o cliente da galeria.");
  const customers = { data: selectedCustomerResult.data ? [selectedCustomerResult.data] : [] };
  const selectedCoverPhoto = gallery.data.cover_photo_id
    ? await supabase.from("photos").select("id").eq("tenant_id", id).eq("gallery_id", galleryId)
      .eq("id", gallery.data.cover_photo_id).eq("processing_status", "ready").is("deletion_requested_at", null).maybeSingle()
    : { data: null, error: null };
  if (selectedCoverPhoto.error) throw new Error("Unable to load the gallery cover photo.");
  const shareIds = shares.data.map(share => share.id);
  const [selectionItems, downloads, revisions, notificationStatuses] = await Promise.all([
    shareIds.length
      ? supabase.from("gallery_selection_items").select("share_id, photo_id, original_filename, client_note, selected_at").in("share_id", shareIds).order("selected_at").order("photo_id")
      : Promise.resolve({ data: [] as { share_id: string; photo_id: string; original_filename: string; client_note: string | null }[], error: null }),
    shareIds.length
      ? supabase.rpc("gallery_download_audit_counts", { p_tenant_id: id, p_gallery_id: galleryId })
      : Promise.resolve({ data: [] as { share_id: string; photo_id: string; download_count: number }[], error: null }),
    shareIds.length
      ? supabase.from("gallery_selection_revisions").select("id, share_id, revision_number, submitted_at, submitted_name, revision_message, requested_at").in("share_id", shareIds).order("revision_number", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; share_id: string; revision_number: number; submitted_at: string; submitted_name: string; revision_message: string; requested_at: string }[], error: null }),
    shareIds.length
      ? supabase.rpc("gallery_notification_status", { p_tenant_id: id, p_gallery_id: galleryId })
      : Promise.resolve({ data: [] as GalleryNotificationStatus[], error: null }),
  ]);
  if (selectionItems.error) throw new Error("Não foi possível carregar as seleções.");
  if (downloads.error) throw new Error("Não foi possível carregar o histórico de downloads.");
  if (revisions.error) throw new Error("Não foi possível carregar as revisões das seleções.");
  if (notificationStatuses.error) throw new Error("Não foi possível carregar o estado dos avisos por e-mail.");
  const downloadCounts = downloads.data as { share_id: string; photo_id: string; download_count: number }[];
  const revisionIds = revisions.data.map(revision => revision.id);
  const revisionItems = revisionIds.length
    ? await supabase.from("gallery_selection_revision_items").select("revision_id, photo_id, original_filename, client_note").in("revision_id", revisionIds)
    : { data: [] as { revision_id: string; photo_id: string; original_filename: string; client_note: string | null }[], error: null };
  if (revisionItems.error) throw new Error("Não foi possível carregar as fotos das revisões.");
  const sharesWithSelections = shares.data.map(share => ({
    ...share,
    gallery_selection_items: selectionItems.data.filter(item => item.share_id === share.id),
    gallery_download_counts: downloadCounts.filter(item => item.share_id === share.id)
      .map(({ photo_id, download_count }) => ({ photo_id, download_count })),
    notification_statuses: (notificationStatuses.data as GalleryNotificationStatus[])
      .filter(item => item.share_id === share.id)
      .map(({ notification_type, delivery_state, attempts, manual_retry_count }) => ({ notification_type, delivery_state, attempts, manual_retry_count })),
    gallery_selection_revisions: revisions.data.filter(revision => revision.share_id === share.id).map(revision => ({
      ...revision,
      gallery_selection_revision_items: revisionItems.data.filter(item => item.revision_id === revision.id),
    })),
  }));
  const initialReadyPhotos = photos.data.filter(photo => photo.processing_status === "ready");
  const derivedPaths = initialReadyPhotos.map(photo => `${id}/${galleryId}/${photo.id}.webp`);
  const media = createMediaReader(supabase);
  const [thumbnailUrls, previewUrls] = await Promise.all([
    media.signPaths("thumbnail", derivedPaths, 900),
    media.signPaths("preview", derivedPaths, 900),
  ]);
  const signedPhotos = photos.data.map(photo => {
    if (photo.deletion_requested_at || photo.processing_status !== "ready") {
      return { ...photo, thumbnailUrl: null, previewUrl: null, originalUrl: null };
    }
    const derivedPath = `${id}/${galleryId}/${photo.id}.webp`;
    return {
      ...photo,
      thumbnailUrl: thumbnailUrls.get(derivedPath) ?? null,
      previewUrl: previewUrls.get(derivedPath) ?? null,
      originalUrl: panelOriginalUrl(id, galleryId, photo.id),
    };
  });
  const galleryCustomerId = gallery.data.customer_id;
  const galleryCustomer = customers.data.find(customer => customer.id === galleryCustomerId);
  const customerEmail = galleryCustomer?.email ?? null;
  const customerWhatsAppPhone = galleryCustomer?.whatsapp_phone ?? null;
  const photoCount = photos.count ?? 0;
  const activeCoverPhotoId = selectedCoverPhoto.data?.id ?? firstReadyPhoto.data?.id ?? null;
  return <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]"><div className="space-y-6 xl:sticky xl:top-8"><section className="panel"><h1 className="mb-8 text-3xl font-semibold">Editar galeria</h1><GalleryForm tenantId={id} customers={customers.data} gallery={gallery.data} /></section><section className="panel"><h2 className="mb-2 text-lg font-semibold">Reutilizar como modelo</h2><p className="mb-5 text-sm text-stone-400">Crie outra galeria com o título e a descrição como ponto de partida. A cópia começa como rascunho e não inclui cliente, fotos nem links de compartilhamento.</p><form action={duplicateGallery.bind(null, id, galleryId)} className="space-y-5"><p className="text-sm text-stone-400">Você poderá editar os dados e enviar as fotos do novo trabalho.</p><button className="button w-full" type="submit">Criar cópia como rascunho</button></form></section><GallerySharing tenantId={id} galleryId={galleryId} galleryTitle={gallery.data.title} customerEmail={customerEmail} customerWhatsAppPhone={customerWhatsAppPhone} status={gallery.data.status} readyPhotoCount={readyPhotoCount.count ?? 0} shares={sharesWithSelections} /></div><PhotoUploader key={galleryId} tenantId={id} galleryId={galleryId} photos={signedPhotos.map((photo, index) => ({ ...photo, position: index }))} photoCount={photoCount} pendingDeletions={pendingDeletions.data} readyPhotoCount={readyPhotoCount.count ?? 0} hasPhotosProcessing={(processingPhotoCount.count ?? 0) > 0} activeCoverPhotoId={activeCoverPhotoId} uploads={uploads.data as UploadSession[]} storageUsage={usage.data as StorageUsage} coverPhotoId={gallery.data.cover_photo_id} allowUpload={gallery.data.status !== "archived"} /></div>;
}

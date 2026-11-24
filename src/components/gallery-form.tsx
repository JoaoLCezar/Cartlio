"use client";

import { useState } from "react";
import { ActionForm } from "./action-form";
import { saveGallery } from "@/app/painel/[id]/actions";
import { galleryStatuses, type GalleryStatus } from "@/lib/gallery-validation";
import { CustomerPicker } from "@/components/customer-picker";

type Gallery = { id: string; title: string; slug: string; description: string; customer_id: string | null; status: GalleryStatus };

function slugFromTitle(title: string) {
  return title.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function GalleryForm({ tenantId, customer, customers, gallery }: { tenantId: string; customer?: { id: string; name: string } | null; customers?: { id: string; name: string }[]; gallery?: Gallery }) {
  const [title, setTitle] = useState(gallery?.title ?? "");
  const [slug, setSlug] = useState(gallery?.slug ?? "");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(Boolean(gallery));

  return <ActionForm action={saveGallery.bind(null, tenantId, gallery?.id ?? null)} label={gallery ? "Salvar alterações" : "Criar galeria"}>
    <label className="field">Título<input name="title" required maxLength={120} value={title} onChange={event => {
      const value = event.currentTarget.value;
      setTitle(value);
      if (!slugManuallyEdited) setSlug(slugFromTitle(value));
    }} placeholder="Ensaio de família" /></label>
    <label className="field">Identificador da galeria<input name="slug" required minLength={3} maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={event => {
      setSlug(event.currentTarget.value);
      setSlugManuallyEdited(true);
    }} placeholder="ensaio-de-familia" aria-describedby="gallery-slug-hint" /></label>
    <p id="gallery-slug-hint" className="text-sm text-stone-400">Identificador interno e exclusivo neste workspace. O link para o cliente é criado na seção Compartilhar.</p>
    <button type="button" className="text-sm text-amber-300 underline" onClick={() => {
      setSlug(slugFromTitle(title));
      setSlugManuallyEdited(false);
    }}>Gerar identificador pelo título</button>
    <div className="field"><label htmlFor="gallery-customer">Cliente principal</label><CustomerPicker tenantId={tenantId} name="customer_id" inputId="gallery-customer" initialValue={gallery?.customer_id} initialName={customer?.name ?? customers?.[0]?.name} quickChoices={[{ value: "", label: "Sem cliente vinculado" }]} /></div>
    <label className="field">Descrição<textarea name="description" rows={4} maxLength={2000} defaultValue={gallery?.description} /></label>
    <label className="field">Status<select name="status" defaultValue={gallery?.status ?? "draft"}>{Object.entries(galleryStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <p className="text-sm text-stone-400">Publique a galeria para criar links temporários de visualização. Apenas previews prontos aparecem; os originais continuam privados.</p>
  </ActionForm>;
}

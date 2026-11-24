"use client";

import Image from "next/image";
import { useActionState, useEffect, useState, type CSSProperties } from "react";
import type { FormState } from "@/components/action-form";
import { contrastTextColor } from "@/lib/brand-color";

type BrandAction = (state: FormState, data: FormData) => Promise<FormState>;

export function WorkspaceBrandEditor({
  action,
  logoAction,
  brandName,
  brandColor,
  brandLogoPath,
  tenantId,
  workspaceName,
  canEdit,
}: {
  action: BrandAction;
  logoAction: BrandAction;
  brandName: string;
  brandColor: string;
  brandLogoPath: string | null;
  tenantId: string;
  workspaceName: string;
  canEdit: boolean;
}) {
  const [formState, formAction, pending] = useActionState(action, {});
  const [logoFormState, logoFormAction, logoPending] = useActionState(logoAction, {});
  const [previewName, setPreviewName] = useState(brandName);
  const [previewColor, setPreviewColor] = useState(brandColor);
  const [selectedLogo, setSelectedLogo] = useState<string | null>(null);
  const previewStyle = { "--brand-preview-color": previewColor } as CSSProperties;
  const logoSource = selectedLogo ?? (brandLogoPath ? "/painel/" + tenantId + "/marca/logo" : null);

  useEffect(() => {
    if (!selectedLogo?.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(selectedLogo);
  }, [selectedLogo]);

  return <>
    <section className="gallery-brand-preview" aria-label="Prévia da galeria compartilhada" style={previewStyle}>
      <div className="gallery-brand-preview-topline">
        {logoSource
          ? <Image className="gallery-brand-mark" src={logoSource} alt={"Logo de " + (previewName.trim() || workspaceName)} width={160} height={80} unoptimized />
          : <span className="gallery-public-studio" style={{ backgroundColor: previewColor, color: contrastTextColor(previewColor) }}>{previewName.trim() || "Quadrics"}</span>}
        <span className="gallery-public-brand-note">Uma galeria preparada para você</span>
      </div>
      <div className="gallery-brand-preview-cover">
        <p>GALERIA DE FOTOGRAFIA</p>
        <h2>Um dia para guardar</h2>
        <span>Reviva cada detalhe deste momento especial.</span>
        <span className="gallery-brand-preview-cta">Explorar galeria <span aria-hidden="true">→</span></span>
      </div>
      <p className="gallery-brand-preview-note">Prévia aproximada da experiência do cliente</p>
    </section>

    {canEdit ? <form action={formAction} className="space-y-5">
      <fieldset disabled={pending} className="space-y-5 disabled:opacity-60">
        <label className="field">Nome público do estúdio
          <input name="brand_name" maxLength={120} value={previewName} onChange={event => setPreviewName(event.target.value)} placeholder={workspaceName} />
        </label>
        <p className="-mt-3 text-sm text-stone-400">Este nome fica visível para quem tiver um link ativo de galeria. Se deixar em branco, a prévia usará Quadrics.</p>
        <label className="field">Cor de destaque
          <input name="brand_color" type="color" required value={previewColor} onChange={event => setPreviewColor(event.target.value)} />
        </label>
      </fieldset>
      {formState.error && <p role="alert" className="text-sm text-red-300">{formState.error}</p>}
      {formState.success && <p role="status" className="text-sm text-emerald-300">{formState.success}</p>}
      <button disabled={pending} className="button w-full" type="submit">{pending ? "Aguarde…" : "Salvar identidade"}</button>
    </form> : <p className="rounded-xl border border-stone-700 p-4 text-sm text-stone-400">Somente o proprietário do workspace pode alterar a marca do estúdio.</p>}

    {canEdit && <form action={logoFormAction} className="space-y-4 rounded-2xl border border-stone-700 p-5">
      <div>
        <h2 className="text-lg font-medium">Logo do estúdio</h2>
        <p className="mt-1 text-sm text-stone-400">PNG, JPG ou WebP de até 2 MiB. O arquivo é convertido e otimizado antes de ser salvo.</p>
      </div>
      <label className="field">Escolha uma imagem
        <input
          name="brand_logo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={logoPending}
          onChange={event => {
            const file = event.target.files?.[0];
            setSelectedLogo(file ? URL.createObjectURL(file) : null);
          }}
        />
      </label>
      {logoFormState.error && <p role="alert" className="text-sm text-red-300">{logoFormState.error}</p>}
      {logoFormState.success && <p role="status" className="text-sm text-emerald-300">{logoFormState.success}</p>}
      <div className="flex flex-wrap gap-3">
        <button disabled={logoPending} className="button" type="submit" name="logo_action" value="upload">
          {logoPending ? "Aguarde…" : "Enviar logo"}
        </button>
        {brandLogoPath && <button disabled={logoPending} className="button-secondary" type="submit" name="logo_action" value="remove" onClick={() => setSelectedLogo(null)}>
          Remover logo
        </button>}
      </div>
    </form>}
  </>;
}

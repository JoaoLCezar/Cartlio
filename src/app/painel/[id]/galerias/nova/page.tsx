import { requireWorkspace } from "@/lib/workspace";
import { GalleryForm } from "@/components/gallery-form";

export default async function NewGalleryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireWorkspace(id);
  return <section className="panel max-w-2xl"><h1 className="mb-8 text-3xl font-semibold">Nova galeria</h1><GalleryForm tenantId={id} customers={[]} /></section>;
}

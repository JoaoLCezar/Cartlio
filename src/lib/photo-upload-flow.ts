import { validPhotoSignature } from "./photo-validation";
import { normalizedPhotoFilename, uploadError, type UploadSession } from "./upload-lifecycle";
import type { createClient } from "./supabase/client";
import { createPhotoUploadTransport } from "./supabase/photo-upload-transport";

function matchesReservation(session: UploadSession, file: File) {
  return file.size === session.byte_size && file.type === session.content_type &&
    normalizedPhotoFilename(file.name) === session.original_filename;
}

async function hasPhotoSignature(file: File) {
  return validPhotoSignature(file.type, new Uint8Array(await file.slice(0, 8).arrayBuffer()));
}

export function createPhotoUploadFlow(supabase: ReturnType<typeof createClient>) {
  const transport = createPhotoUploadTransport(supabase);

  return (tenantId: string, galleryId: string) => {
    const scope = (uploadId: string) => ({ p_tenant_id: tenantId, p_gallery_id: galleryId, p_upload_id: uploadId });

    function requireSupportedProvider(session: UploadSession) {
      if (session.storage_provider !== "supabase") throw new Error(uploadError("UPLOAD_PROVIDER_UNSUPPORTED"));
    }

    async function complete(session: UploadSession) {
      const result = await supabase.rpc("complete_photo_upload", scope(session.id));
      if (result.error || result.data !== session.id) throw new Error(uploadError(result.error?.message ?? ""));
    }

    return {
      async requireUser() {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) throw new Error("Sua sessão expirou. Entre novamente e tente enviar as imagens.");
      },

      async send(file: File, onProgress?: (sent: number) => void) {
        if (!await hasPhotoSignature(file)) {
          throw new Error(`O conteúdo de “${file.name}” não corresponde a uma imagem JPEG ou PNG.`);
        }
        const reserved = await supabase.rpc("reserve_photo_upload", {
          ...scope(crypto.randomUUID()), p_filename: normalizedPhotoFilename(file.name),
          p_content_type: file.type, p_byte_size: file.size,
        });
        if (reserved.error || !reserved.data) throw new Error(uploadError(reserved.error?.message ?? ""));
        const session = reserved.data as UploadSession;
        requireSupportedProvider(session);
        if (!matchesReservation(session, file)) throw new Error("O arquivo não corresponde à reserva deste envio.");
        await transport.send(session, file, onProgress);
        await complete(session);
      },

      async resume(session: UploadSession, file?: File, onProgress?: (sent: number, size: number) => void) {
        requireSupportedProvider(session);
        if (file) {
          if (!matchesReservation(session, file)) {
            throw new Error("Selecione um arquivo com o mesmo nome, tamanho e tipo do envio pendente.");
          }
          if (!await hasPhotoSignature(file)) {
            throw new Error("O conteúdo do arquivo não corresponde a uma imagem JPEG ou PNG.");
          }
          await transport.send(session, file, onProgress);
        }
        // A transfer may already have succeeded despite a lost browser response.
        await complete(session);
      },

      async cancel(session: UploadSession) {
        requireSupportedProvider(session);
        const started = await supabase.rpc("begin_upload_cancellation", scope(session.id));
        if (started.error) throw new Error("Não foi possível descartar o envio. Tente novamente.");
        if (started.data === null) return;
        await transport.discard(session, started.data);
        const finished = await supabase.rpc("finish_upload_cancellation", scope(session.id));
        if (finished.error || finished.data !== true) {
          throw new Error("A limpeza ficou pendente. Tente descartar o envio novamente.");
        }
      },
    };
  };
}

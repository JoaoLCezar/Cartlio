import { Upload, defaultOptions } from "tus-js-client";
import { RESUMABLE_UPLOAD_THRESHOLD_BYTES } from "@/lib/photo-validation";
import { uploadError, type UploadSession } from "@/lib/upload-lifecycle";
import type { createClient } from "./client";
import { supabaseConfig } from "./config";

const originals = "gallery-originals";
const tusChunkSize = 6 * 1024 * 1024;

function resumableConfig(path: string) {
  const config = supabaseConfig();
  if (!config) throw new Error("O armazenamento não está configurado.");
  const endpoint = `${config.storageUrl.replace(/\/$/, "")}/storage/v1/upload/resumable`;
  return { endpoint, key: config.key, fingerprint: `cartlio:${endpoint}:${originals}:${path}` };
}

export function createPhotoUploadTransport(supabase: ReturnType<typeof createClient>) {
  const activeTransfers = new Map<string, Upload>();

  async function sessionToken(errorMessage: string) {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new Error(errorMessage);
    return data.session.access_token;
  }

  async function sendResumable(session: UploadSession, file: File, onProgress?: (sent: number, size: number) => void) {
    const { endpoint, key, fingerprint } = resumableConfig(session.object_path);
    await sessionToken("Sua sessão expirou. Entre novamente e tente enviar as imagens.");

    const interruptedMessage = "A conexão foi interrompida. O envio ficou pendente; selecione o mesmo arquivo novamente para continuar.";
    let resolveTransfer!: () => void;
    let rejectTransfer!: (reason: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveTransfer = resolve;
      rejectTransfer = reject;
    });
    const transfer = new Upload(file, {
      endpoint,
      chunkSize: tusChunkSize,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      fingerprint: async () => fingerprint,
      onBeforeRequest: async request => {
        const token = await sessionToken("Sua sessão expirou. Entre novamente para continuar o envio.");
        request.setHeader("apikey", key);
        request.setHeader("authorization", `Bearer ${token}`);
      },
      metadata: {
        bucketName: originals,
        objectName: session.object_path,
        contentType: file.type,
        cacheControl: "0",
      },
      onProgress,
      onError: () => rejectTransfer(new Error(interruptedMessage)),
      onSuccess: resolveTransfer,
    });
    activeTransfers.set(session.id, transfer);
    try {
      const previousUploads = await transfer.findPreviousUploads();
      const previous = previousUploads.find(item => item.size === file.size && item.metadata.objectName === session.object_path);
      if (previous) transfer.resumeFromPreviousUpload(previous);
      transfer.start();
      await completed;
      activeTransfers.delete(session.id);
    } catch (cause) {
      if (cause instanceof Error && cause.message === interruptedMessage) throw cause;
      throw new Error("Não foi possível iniciar ou retomar o envio. Confira sua conexão e tente novamente.");
    }
  }

  return {
    async send(session: UploadSession, file: File, onProgress?: (sent: number, size: number) => void) {
      if (file.size > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
        await sendResumable(session, file, onProgress);
        return;
      }
      const { error } = await supabase.storage.from(originals).upload(session.object_path, file, {
        contentType: file.type, cacheControl: "0", upsert: false,
      });
      if (error) throw new Error(uploadError(error.message));
    },

    async discard(session: UploadSession, authorizedPath: string) {
      const { key, fingerprint } = resumableConfig(session.object_path);
      const token = await sessionToken("Sua sessão expirou. Entre novamente para concluir o descarte.");
      const headers = { apikey: key, authorization: `Bearer ${token}` };
      const active = activeTransfers.get(session.id);
      if (active) {
        try { await active.abort(true); }
        finally { activeTransfers.delete(session.id); }
      }
      const previousUploads = await defaultOptions.urlStorage.findUploadsByFingerprint(fingerprint);
      for (const previous of previousUploads) {
        if (previous.uploadUrl) await Upload.terminate(previous.uploadUrl, { headers, retryDelays: [0, 1000, 3000] });
        await defaultOptions.urlStorage.removeUpload(previous.urlStorageKey);
      }
      const { error } = await supabase.storage.from(originals).remove([authorizedPath]);
      if (error) throw new Error("A limpeza ficou pendente. Tente descartar o envio novamente.");
    },
  };
}

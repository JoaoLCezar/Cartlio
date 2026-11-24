import { maintenanceClient } from "./lib/maintenance-client.mjs";
import { inputLimit, InvalidPhotoError, renderWatermarkedImages } from "./lib/image-processing.mjs";

const args = process.argv.slice(2);
if (!["--local", "--remote"].includes(args[0]) || ![1, 3].includes(args.length) || (args.length === 3 && args[1] !== "--tenant")) {
  throw new Error("Uso: node scripts/process-images.mjs --local|--remote [--tenant UUID]");
}
const mode = args[0];
const tenantId = args[2];
if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error("Workspace inválido.");

const workerLimit = 100;
let r2Access;

function derivativePath(photo) {
  return `${photo.tenant_id}/${photo.gallery_id}/${photo.id}.webp`;
}

async function removeDerivatives(client, path) {
  for (const bucket of ["gallery-previews", "gallery-thumbnails"]) {
    const result = await client.storage.from(bucket).remove([path]);
    if (result.error) throw new Error("Falha ao limpar imagem derivada.");
  }
}

async function readOriginalBytes(client, photo) {
  if (photo.storage_provider === "r2") {
    const { createR2OriginalAccess } = await import("./lib/r2-originals.mjs");
    r2Access ??= createR2OriginalAccess();
    try {
      return await r2Access.readVerifiedOriginal(photo);
    } catch (error) {
      if (error.message === "R2_ORIGINAL_CHANGED" || error.message === "UPLOAD_MISMATCH") {
        throw new InvalidPhotoError("Original diferente da foto confirmada.");
      }
      throw error;
    }
  }
  if (photo.storage_provider !== undefined && photo.storage_provider !== "supabase") {
    throw new Error("Provedor do original não disponível.");
  }
  const downloaded = await client.storage.from("gallery-originals").download(photo.object_path);
  if (downloaded.error || !downloaded.data) throw new Error("Original indisponível.");
  return Buffer.from(await downloaded.data.arrayBuffer());
}

try {
  const client = maintenanceClient(mode);
  const counts = { examined: 0, ready: 0, invalid: 0, retry: 0, failed: 0 };
  let stopping = false;
  const requestStop = () => { stopping = true; };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  for (let i = 0; i < workerLimit && !stopping; i += 1) {
    const claimed = await client.rpc("claim_photo_processing", { p_tenant_id: tenantId ?? null });
    if (claimed.error) throw new Error("Falha ao obter foto para processamento.");
    const photo = claimed.data;
    if (!photo?.id) break;
    counts.examined += 1;
    const path = derivativePath(photo);
    let result = "retry";
    let width;
    let height;
    try {
      const bytes = await readOriginalBytes(client, photo);
      if (bytes.length !== photo.byte_size || bytes.length > inputLimit) throw new InvalidPhotoError("Tamanho inválido.");
      const workspace = await client.from("tenants").select("name").eq("id", photo.tenant_id).maybeSingle();
      if (workspace.error || !workspace.data?.name) throw new Error("Workspace unavailable.");
      const rendered = await renderWatermarkedImages(bytes, photo.content_type, workspace.data.name);
      for (const [bucket, body] of [["gallery-previews", rendered.preview], ["gallery-thumbnails", rendered.thumbnail]]) {
        const uploaded = await client.storage.from(bucket).upload(path, body, {
          contentType: "image/webp", cacheControl: "3600", upsert: true,
        });
        if (uploaded.error) throw new Error("Falha ao gravar imagem derivada.");
      }
      width = rendered.width;
      height = rendered.height;
      result = "ready";
    } catch (error) {
      if (error instanceof InvalidPhotoError) {
        try { await removeDerivatives(client, path); result = "invalid"; }
        catch { result = "retry"; }
      }
    }
    const finished = await client.rpc("finish_photo_processing", {
      p_photo_id: photo.id, p_token: photo.processing_token, p_result: result,
      p_width: width ?? null, p_height: height ?? null,
    });
    if (finished.error) { counts.failed += 1; continue; }
    if (finished.data !== true) {
      const current = await client.from("photos").select("deletion_requested_at").eq("id", photo.id).maybeSingle();
      if (!current.error && (!current.data || current.data.deletion_requested_at)) {
        try { await removeDerivatives(client, path); } catch { counts.failed += 1; }
      }
      continue;
    }
    counts[result] += 1;
  }
  console.log(JSON.stringify(counts));
  if (stopping) process.exitCode = 130;
  if (counts.failed || counts.retry) process.exitCode = 1;
} catch {
  console.error("Processamento não concluído. Confira credenciais, migrações, buckets e disponibilidade do Supabase.");
  process.exitCode = 1;
}

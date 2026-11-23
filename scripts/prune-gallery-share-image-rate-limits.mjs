import { maintenanceClient } from "./lib/maintenance-client.mjs";

const mode = process.argv[2];
if (!["--local", "--remote"].includes(mode) || process.argv.length !== 3) {
  throw new Error("Uso: node scripts/prune-gallery-share-image-rate-limits.mjs --local|--remote");
}

try {
  const client = maintenanceClient(mode);
  const batchSize = 1000;
  const result = await client.rpc("prune_gallery_share_image_rate_limits", { p_batch_size: batchSize });
  if (result.error || typeof result.data !== "number") throw new Error("Falha ao limpar limites antigos.");
  console.log(JSON.stringify({ removed: result.data, batch_size: batchSize, may_have_more: result.data === batchSize }));
} catch {
  console.error("Limpeza dos limites de imagem não concluída. Confira credenciais, migrações e disponibilidade do Supabase.");
  process.exitCode = 1;
}

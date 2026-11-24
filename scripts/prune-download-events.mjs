import { maintenanceClient } from "./lib/maintenance-client.mjs";

const args = process.argv.slice(2);
if (!["--local", "--remote"].includes(args[0]) || ![1, 3].includes(args.length) || (args.length === 3 && args[1] !== "--retention-days")) {
  throw new Error("Uso: node scripts/prune-download-events.mjs --local|--remote [--retention-days 30..365]");
}
const mode = args[0];

const retentionDays = args.length === 1 ? 90 : Number(args[2]);
if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 365) {
  throw new Error("A retenção deve estar entre 30 e 365 dias.");
}

try {
  const client = maintenanceClient(mode);
  const result = await client.rpc("prune_gallery_download_events", { p_retention_days: retentionDays });
  if (result.error || typeof result.data !== "number") throw new Error("Falha ao limpar eventos antigos.");
  console.log(JSON.stringify({ retention_days: retentionDays, removed: result.data }));
} catch {
  console.error("Limpeza de downloads não concluída. Confira credenciais, migrações e disponibilidade do Supabase.");
  process.exitCode = 1;
}

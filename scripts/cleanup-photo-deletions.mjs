import { maintenanceClient } from "./lib/maintenance-client.mjs";
import { cleanupPendingPhotoDeletions } from "./lib/photo-deletion-cleanup.mjs";

const args = process.argv.slice(2);
if (![1, 3].includes(args.length) || !["--local", "--remote"].includes(args[0]) || (args.length === 3 && args[1] !== "--tenant")) {
  throw new Error("Uso: node scripts/cleanup-photo-deletions.mjs --local|--remote [--tenant UUID]");
}
const mode = args[0];
const tenantId = args[2];
if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
  throw new Error("Workspace inválido.");
}

try {
  const client = maintenanceClient(mode);
  let query = client.from("photos").select("id, tenant_id, gallery_id, object_path")
    .not("deletion_requested_at", "is", null)
    .order("deletion_requested_at").order("id").limit(100);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data: photos, error } = await query;
  if (error) throw new Error("Não foi possível consultar exclusões pendentes.");

  const counts = await cleanupPendingPhotoDeletions(client, photos);
  console.log(JSON.stringify(counts));
  if (counts.failed) process.exitCode = 1;
} catch {
  console.error("Limpeza de exclusões não concluída. Confira credenciais, migrações e disponibilidade do Supabase.");
  process.exitCode = 1;
}

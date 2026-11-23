import { maintenanceClient } from "./lib/maintenance-client.mjs";

const args = process.argv.slice(2);
if (!["--local", "--remote"].includes(args[0]) || ![1, 3].includes(args.length) || (args.length === 3 && args[1] !== "--tenant")) {
  throw new Error("Uso: node scripts/reconcile-uploads.mjs --local|--remote [--tenant UUID]");
}
const mode = args[0];
const tenantId = args[2];
if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error("Workspace inválido.");

try {
  const client = maintenanceClient(mode);
  let query = client.from("upload_sessions").select("id, tenant_id, gallery_id")
    .eq("storage_provider", "supabase")
    .or(`state.eq.canceling,and(state.eq.reserved,expires_at.lte.${new Date().toISOString()})`)
    .order("created_at").order("id").limit(100);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data: sessions, error } = await query;
  if (error) throw new Error("Não foi possível consultar os envios pendentes.");
  let cleaned = 0;
  let failed = 0;
  for (const session of sessions) {
    const scope = { p_tenant_id: session.tenant_id, p_gallery_id: session.gallery_id, p_upload_id: session.id };
    try {
      const started = await client.rpc("begin_upload_cancellation", scope);
      if (started.error) throw new Error("Falha ao iniciar limpeza.");
      if (started.data !== null) {
        const removed = await client.storage.from("gallery-originals").remove([started.data]);
        if (removed.error) throw new Error("Falha ao remover arquivo.");
        const finished = await client.rpc("finish_upload_cancellation", scope);
        if (finished.error || finished.data !== true) throw new Error("Falha ao confirmar limpeza.");
      }
      cleaned += 1;
    } catch {
      failed += 1; // Keep durable state for the next attempt; do not log credentials.
    }
  }
  const r2 = await client.rpc("reconcile_r2_upload_reservations", { p_tenant_id: tenantId ?? null });
  if (r2.error) failed += 1;
  const summary = { examined: sessions.length, cleaned, failed };
  if (!r2.error && (r2.data?.examined || r2.data?.held)) summary.r2 = r2.data;
  console.log(JSON.stringify(summary));
  if (failed) process.exitCode = 1;
} catch {
  console.error("Reconciliação não concluída. Confira o Supabase local e as migrações.");
  process.exitCode = 1;
}

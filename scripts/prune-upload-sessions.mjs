import { maintenanceClient } from "./lib/maintenance-client.mjs";
import { parseUploadSessionPruneArguments } from "./lib/upload-session-retention.mjs";

try {
  const options = parseUploadSessionPruneArguments(process.argv.slice(2));
  const { data, error } = await maintenanceClient(options.mode).rpc("prune_upload_sessions", {
    p_retention_days: options.retentionDays,
    p_tenant_id: options.tenantId,
  });
  if (error || typeof data !== "number") throw new Error("Upload-session pruning failed.");
  process.stdout.write(`${JSON.stringify({
    retention_days: options.retentionDays,
    scope: options.tenantId ? "workspace" : "all_workspaces",
    removed: data,
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Limpeza das sessões não concluída."}\n`);
  process.exitCode = 1;
}

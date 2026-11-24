import { maintenanceClient } from "./lib/maintenance-client.mjs";
import { cleanupStorageOrphans, parseStorageCleanupArguments } from "./lib/storage-orphan-cleanup.mjs";

try {
  const options = parseStorageCleanupArguments(process.argv.slice(2));
  const summary = await cleanupStorageOrphans(maintenanceClient(options.mode), options.tenantId, {
    olderThanHours: options.olderThanHours,
    apply: options.apply,
    includePaths: options.includePaths,
  });
  process.stdout.write(`${JSON.stringify({ mode: options.mode, ...summary })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Limpeza de órfãos não concluída."}\n`);
  process.exitCode = 1;
}

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditStorage, compareStorageUsage, parseStorageAuditArguments } from "./lib/storage-audit.mjs";
import { maintenanceClient } from "./lib/maintenance-client.mjs";

try {
  const options = parseStorageAuditArguments(process.argv.slice(2));
  const summary = await auditStorage(maintenanceClient(options.mode), options.tenantId, {
    includePaths: options.includePaths,
    includeUsage: options.includeUsage,
    includeR2: options.includeR2,
  });
  const report = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    mode: options.mode,
    read_only: true,
    scope: options.tenantId ? "workspace" : "all_workspaces",
    tenant_id: options.tenantId ?? null,
    include_usage: options.includeUsage,
    ...summary,
  };
  let comparison;
  if (options.comparePath) {
    let baseline;
    try {
      baseline = JSON.parse(await readFile(resolve(options.comparePath), "utf8"));
    } catch {
      throw new Error("Não foi possível ler o snapshot de referência como JSON.");
    }
    comparison = compareStorageUsage(report, baseline);
  }
  if (options.snapshotPath) {
    try {
      await writeFile(resolve(options.snapshotPath), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      throw new Error("Não foi possível criar o snapshot; confirme que o diretório existe e o arquivo ainda não existe.");
    }
  }
  process.stdout.write(`${JSON.stringify(comparison ? { ...report, comparison } : report)}\n`);
  if (summary.findings.total || !summary.audit_complete) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Auditoria do Storage não concluída."}\n`);
  process.exitCode = 1;
}

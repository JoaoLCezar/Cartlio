import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { safeErrorMessage } from "./lib/safe-error-message.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));

export function parseMaintenanceArguments(argv) {
  const options = { mode: null, tenantId: null, retentionDays: 90, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if ((argument === "--local" || argument === "--remote") && options.mode === null) {
      options.mode = argument;
    } else if (argument === "--tenant" && argv[index + 1]) {
      options.tenantId = argv[++index];
    } else if (argument === "--retention-days" && argv[index + 1]) {
      options.retentionDays = Number(argv[++index]);
    } else if (argument === "--dry-run" && !options.dryRun) {
      options.dryRun = true;
    } else {
      throw new Error("Uso: npm run maintenance -- --local|--remote [--tenant UUID] [--retention-days 30..365] [--dry-run]");
    }
  }
  if (!options.mode) throw new Error("Escolha explicitamente --local ou --remote.");
  if (options.tenantId && !uuidPattern.test(options.tenantId)) throw new Error("Workspace inválido.");
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 30 || options.retentionDays > 365) {
    throw new Error("A retenção deve estar entre 30 e 365 dias.");
  }
  return options;
}

export function maintenanceTasks(options) {
  const scope = options.tenantId ? ["--tenant", options.tenantId] : [];
  return [
    { name: "uploads", script: "reconcile-uploads.mjs", args: [options.mode, ...scope] },
    { name: "upload-session-retention", script: "prune-upload-sessions.mjs", args: [options.mode, ...scope] },
    { name: "photo-deletions", script: "cleanup-photo-deletions.mjs", args: [options.mode, ...scope] },
    { name: "images", script: "process-images.mjs", args: [options.mode, ...scope] },
    { name: "notifications", script: "deliver-gallery-notifications.mjs", args: [options.mode] },
    { name: "downloads", script: "prune-download-events.mjs", args: [options.mode, "--retention-days", String(options.retentionDays)] },
    { name: "gallery-rate-limits", script: "prune-gallery-share-image-rate-limits.mjs", args: [options.mode] },
  ];
}

export async function runMaintenance(options, runTask = runChildTask) {
  const results = [];
  for (const task of maintenanceTasks(options)) {
    let result;
    try {
      result = await runTask(task);
    } catch (error) {
      result = { status: 1, stdout: "", stderr: error instanceof Error ? error.message : "" };
    }
    let summary = null;
    if (result.status === 0) {
      try { summary = JSON.parse(result.stdout.trim()); } catch { /* exit status still records task success */ }
    }
    const taskResult = { task: task.name, status: result.status === 0 ? "ok" : "failed", summary };
    if (result.status !== 0) taskResult.error = safeErrorMessage(result.stderr);
    results.push(taskResult);
  }
  return { mode: options.mode, results, ok: results.every(result => result.status === "ok") };
}

function runChildTask(task) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(task.script, pathToFileURL(scriptDirectory))), ...task.args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45 * 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return { status: 1, stdout: "", stderr: result.error.message };
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseMaintenanceArguments(process.argv.slice(2));
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify({ mode: options.mode, dry_run: true, tasks: maintenanceTasks(options).map(({ name }) => name) })}\n`);
    } else {
      const result = await runMaintenance(options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Manutenção não concluída."}\n`);
    process.exitCode = 1;
  }
}

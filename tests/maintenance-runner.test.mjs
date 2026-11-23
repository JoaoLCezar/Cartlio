import assert from "node:assert/strict";
import test from "node:test";
import { maintenanceTasks, parseMaintenanceArguments, runMaintenance } from "../scripts/run-maintenance.mjs";
import { safeErrorMessage } from "../scripts/lib/safe-error-message.mjs";

test("maintenance requires an explicit target and valid options", () => {
  assert.throws(() => parseMaintenanceArguments([]), /explicitamente/);
  assert.throws(() => parseMaintenanceArguments(["--local", "--remote"]), /Uso:/);
  assert.throws(() => parseMaintenanceArguments(["--local", "--tenant", "not-a-uuid"]), /Workspace inválido/);
  assert.throws(() => parseMaintenanceArguments(["--local", "--retention-days", "29"]), /entre 30 e 365/);
});

test("maintenance plans cleanup, workers, and retention tasks in order", () => {
  const options = parseMaintenanceArguments([
    "--remote", "--tenant", "123e4567-e89b-12d3-a456-426614174000", "--retention-days", "180", "--dry-run",
  ]);
  assert.equal(options.dryRun, true);
  assert.deepEqual(maintenanceTasks(options), [
    { name: "uploads", script: "reconcile-uploads.mjs", args: ["--remote", "--tenant", "123e4567-e89b-12d3-a456-426614174000"] },
    { name: "upload-session-retention", script: "prune-upload-sessions.mjs", args: ["--remote", "--tenant", "123e4567-e89b-12d3-a456-426614174000"] },
    { name: "photo-deletions", script: "cleanup-photo-deletions.mjs", args: ["--remote", "--tenant", "123e4567-e89b-12d3-a456-426614174000"] },
    { name: "images", script: "process-images.mjs", args: ["--remote", "--tenant", "123e4567-e89b-12d3-a456-426614174000"] },
    { name: "notifications", script: "deliver-gallery-notifications.mjs", args: ["--remote"] },
    { name: "downloads", script: "prune-download-events.mjs", args: ["--remote", "--retention-days", "180"] },
    { name: "gallery-rate-limits", script: "prune-gallery-share-image-rate-limits.mjs", args: ["--remote"] },
  ]);
});

test("maintenance runs sequentially and continues after a task failure", async () => {
  const order = [];
  const result = await runMaintenance(parseMaintenanceArguments(["--local"]), async task => {
    order.push(task.name);
    if (task.name === "images") return { status: 1, stdout: "", stderr: "Error: image worker unavailable\nSensitive details omitted" };
    return { status: 0, stdout: JSON.stringify({ completed: task.name }) };
  });
  assert.deepEqual(order, ["uploads", "upload-session-retention", "photo-deletions", "images", "notifications", "downloads", "gallery-rate-limits"]);
  assert.deepEqual(result, {
    mode: "--local",
    results: [
      { task: "uploads", status: "ok", summary: { completed: "uploads" } },
      { task: "upload-session-retention", status: "ok", summary: { completed: "upload-session-retention" } },
      { task: "photo-deletions", status: "ok", summary: { completed: "photo-deletions" } },
      { task: "images", status: "failed", summary: null, error: "Error: image worker unavailable" },
      { task: "notifications", status: "ok", summary: { completed: "notifications" } },
      { task: "downloads", status: "ok", summary: { completed: "downloads" } },
      { task: "gallery-rate-limits", status: "ok", summary: { completed: "gallery-rate-limits" } },
    ],
    ok: false,
  });
});

test("maintenance error summaries redact credentials and cap diagnostic length", async () => {
  const previousSecret = process.env.SUPABASE_SERVER_SECRET_KEY;
  const previousSmtpPassword = process.env.CARTLIO_SMTP_PASSWORD;
  process.env.SUPABASE_SERVER_SECRET_KEY = "server-secret-value";
  process.env.CARTLIO_SMTP_PASSWORD = "smtp-secret-value";
  try {
    const result = await runMaintenance(parseMaintenanceArguments(["--local"]), async () => ({
      status: 1,
      stdout: "",
      stderr: "Error: Authorization: Bearer token-value https://user:pass@example.test/path?key=query-secret server-secret-value smtp-secret-value " + "x".repeat(400),
    }));
    const diagnostic = result.results[0].error;
    assert.ok(diagnostic.startsWith("Error: Authorization: Bearer [redacted]"));
    assert.doesNotMatch(diagnostic, /token-value|user:pass|query-secret|server-secret-value|smtp-secret-value/);
    assert.equal(diagnostic.length, 300);
  } finally {
    if (previousSecret === undefined) delete process.env.SUPABASE_SERVER_SECRET_KEY;
    else process.env.SUPABASE_SERVER_SECRET_KEY = previousSecret;
    if (previousSmtpPassword === undefined) delete process.env.CARTLIO_SMTP_PASSWORD;
    else process.env.CARTLIO_SMTP_PASSWORD = previousSmtpPassword;
  }
});

test("worker diagnostics use a redacted first line and a safe fallback", () => {
  assert.equal(safeErrorMessage("\nError: Worker unavailable\nmore details"), "Error: Worker unavailable");
  assert.equal(safeErrorMessage("\n\n"), "A tarefa falhou sem informar detalhes.");
});

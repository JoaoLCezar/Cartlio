import { quadricsEnv } from "./lib/quadrics-env.mjs";
import { spawn } from "node:child_process";
import { access, cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const distDirectory = quadricsEnv("NEXT_DIST_DIR") || ".next";
const serverFile = resolve(process.cwd(), distDirectory, "standalone", "server.js");

try {
  await access(serverFile);
  const staticDirectory = resolve(process.cwd(), distDirectory, "static");
  // Keep the configured distDir name so the E2E standalone server can find assets.
  const standaloneStaticDirectory = resolve(process.cwd(), distDirectory, "standalone", distDirectory, "static");
  await access(staticDirectory);
  await mkdir(dirname(standaloneStaticDirectory), { recursive: true });
  await cp(staticDirectory, standaloneStaticDirectory, { recursive: true, force: true });

  const publicDirectory = resolve(process.cwd(), "public");
  try {
    await access(publicDirectory);
    await cp(publicDirectory, resolve(process.cwd(), distDirectory, "standalone", "public"), {
      recursive: true,
      force: true,
    });
  } catch {
    // The project does not require a public directory unless one is added later.
  }
} catch {
  process.stderr.write("Build standalone ausente. Execute npm run build antes de iniciar o servidor.\n");
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const server = spawn(process.execPath, [serverFile], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: "inherit",
  });

  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    server.kill(signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  server.once("error", error => {
    process.stderr.write(`Não foi possível iniciar o servidor standalone: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.once("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

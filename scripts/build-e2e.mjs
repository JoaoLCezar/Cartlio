import { quadricsEnv } from "./lib/quadrics-env.mjs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preserveNextTypeFiles } from "./lib/preserve-next-type-files.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const environment = {
  ...process.env,
  QUADRICS_NEXT_DIST_DIR: quadricsEnv("NEXT_DIST_DIR") ?? "node_modules/.cache/quadrics-next-e2e",
  QUADRICS_NEXT_TSCONFIG: "tsconfig.e2e.json",
};

function build() {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [nextBin, "build"], {
      cwd: projectRoot,
      env: environment,
      windowsHide: true,
      stdio: "inherit",
    });
    const forwardInterrupt = signal => child.kill(signal);
    process.once("SIGINT", forwardInterrupt);
    process.once("SIGTERM", forwardInterrupt);
    child.once("error", error => {
      process.removeListener("SIGINT", forwardInterrupt);
      process.removeListener("SIGTERM", forwardInterrupt);
      rejectBuild(error);
    });
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", forwardInterrupt);
      process.removeListener("SIGTERM", forwardInterrupt);
      resolveBuild(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}

try {
  process.exitCode = await preserveNextTypeFiles(projectRoot, build);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Build E2E não concluído."}\n`);
  process.exitCode = 1;
}

import { spawn } from "node:child_process";

export function startWorkerProcess(workerPath, args, {
  cwd = process.cwd(),
  maxOutputLength = 16 * 1024,
  spawnChild = spawn,
} = {}) {
  const child = spawnChild(process.execPath, [workerPath, ...args], {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const result = new Promise(resolve => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout = (stdout + chunk).slice(-maxOutputLength);
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk).slice(-maxOutputLength);
    });
    child.once("error", error => resolve({ status: 1, stdout: "", stderr: error.message }));
    child.once("close", code => resolve({ status: code ?? 1, stdout, stderr }));
  });

  return { child, result };
}

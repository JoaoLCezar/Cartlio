import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextPath = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const next = spawn(process.execPath, [nextPath, "dev", "--hostname", "0.0.0.0", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: "inherit",
});
const worker = spawn(process.execPath, [fileURLToPath(new URL("./watch-images.mjs", import.meta.url))], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: "inherit",
});
const notificationWorker = spawn(process.execPath, [fileURLToPath(new URL("./watch-gallery-notifications.mjs", import.meta.url))], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: "inherit",
});

let stopping = false;
let forcedStopTimer;
function stopChildren(signal = "SIGINT") {
  if (stopping) return;
  stopping = true;
  next.kill(signal);
  worker.kill(signal);
  notificationWorker.kill(signal);
  forcedStopTimer = setTimeout(() => {
    next.kill("SIGKILL");
    worker.kill("SIGKILL");
    notificationWorker.kill("SIGKILL");
  }, 10_000);
  forcedStopTimer.unref();
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

const results = await Promise.all([next, worker, notificationWorker].map(child => new Promise(resolve => {
  child.once("error", () => {
    if (!stopping) stopChildren();
    resolve(1);
  });
  child.once("close", (code, signal) => {
    if (!stopping) stopChildren();
    resolve(code ?? (signal ? 1 : 0));
  });
})));
clearTimeout(forcedStopTimer);
process.exitCode = results.every(code => code === 0) ? 0 : (stopping ? 130 : 1);

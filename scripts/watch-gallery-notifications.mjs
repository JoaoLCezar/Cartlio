import { fileURLToPath } from "node:url";
import { safeErrorMessage } from "./lib/safe-error-message.mjs";
import { startWorkerProcess } from "./lib/worker-process.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--local" && args[0] !== "--remote")) {
  throw new Error("Uso: node scripts/watch-gallery-notifications.mjs [--local|--remote]");
}
const mode = args[0] ?? "--local";
const workerPath = fileURLToPath(new URL("./deliver-gallery-notifications.mjs", import.meta.url));
let stopping = false;
let activeWorker = null;
let sleepTimer = null;
let sleepResolve = null;

function requestStop() {
  stopping = true;
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepResolve?.();
  sleepResolve = null;
  activeWorker?.kill("SIGINT");
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

function runWorkerOnce() {
  const worker = startWorkerProcess(workerPath, [mode]);
  activeWorker = worker.child;
  if (stopping) worker.child.kill("SIGINT");
  return worker.result.finally(() => {
    if (activeWorker === worker.child) activeWorker = null;
  });
}

function wait(ms) {
  return new Promise(resolve => {
    sleepResolve = resolve;
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      sleepResolve = null;
      resolve();
    }, ms);
  });
}

console.log("Worker local de notificações ativo; verificando a fila a cada 10 segundos.");
while (!stopping) {
  const result = await runWorkerOnce();
  if (stopping) break;
  let summary;
  try { summary = JSON.parse(result.stdout.trim()); } catch { summary = null; }
  if (result.status === 0 && summary) {
    if (summary.examined > 0) console.log(JSON.stringify(summary));
    await wait(summary.examined > 0 ? 250 : 10_000);
  } else {
    console.error(`Worker de notificações falhou; nova tentativa em 30 segundos. ${safeErrorMessage(result.stderr)}`);
    await wait(30_000);
  }
}

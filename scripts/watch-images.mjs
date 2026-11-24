import { fileURLToPath } from "node:url";
import { safeErrorMessage } from "./lib/safe-error-message.mjs";
import { startWorkerProcess } from "./lib/worker-process.mjs";

const workerPath = fileURLToPath(new URL("./process-images.mjs", import.meta.url));
const idlePollMs = 10_000;
const errorPollMs = 30_000;
const outputLimit = 64 * 1024;
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
  const worker = startWorkerProcess(workerPath, ["--local"], { maxOutputLength: outputLimit });
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

console.log("Worker local de imagens ativo; verificando a fila a cada 10 segundos.");
while (!stopping) {
  const result = await runWorkerOnce();
  if (stopping) break;
  let summary;
  try { summary = JSON.parse(result.stdout.trim()); } catch { summary = null; }
  if (result.status === 0 && summary) {
    if (summary.examined > 0) console.log(JSON.stringify(summary));
    await wait(summary.examined > 0 ? 500 : idlePollMs);
  } else {
    console.error(`Worker local de imagens falhou; nova tentativa em 30 segundos. ${safeErrorMessage(result.stderr)}`);
    await wait(errorPollMs);
  }
}

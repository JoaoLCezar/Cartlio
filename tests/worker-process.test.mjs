import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startWorkerProcess } from "../scripts/lib/worker-process.mjs";

function createStream() {
  const stream = new EventEmitter();
  stream.setEncoding = () => {};
  return stream;
}

function createChild() {
  const child = new EventEmitter();
  child.stdout = createStream();
  child.stderr = createStream();
  return child;
}

test("worker process pipes and bounds stdout and stderr", async () => {
  const child = createChild();
  let invocation;
  const worker = startWorkerProcess("worker.mjs", ["--local"], {
    cwd: "C:/Cartlio",
    maxOutputLength: 8,
    spawnChild: (...args) => {
      invocation = args;
      return child;
    },
  });

  assert.equal(worker.child, child);
  assert.equal(invocation[1][0], "worker.mjs");
  assert.deepEqual(invocation[1].slice(1), ["--local"]);
  assert.deepEqual(invocation[2].stdio, ["ignore", "pipe", "pipe"]);
  child.stdout.emit("data", "output-too-long");
  child.stderr.emit("data", "diagnostic-too-long");
  child.emit("close", 1);

  assert.deepEqual(await worker.result, {
    status: 1,
    stdout: "too-long",
    stderr: "too-long",
  });
});

test("worker process reports spawn failures", async () => {
  const child = createChild();
  const worker = startWorkerProcess("worker.mjs", [], { spawnChild: () => child });
  child.emit("error", new Error("spawn unavailable"));

  assert.deepEqual(await worker.result, {
    status: 1,
    stdout: "",
    stderr: "spawn unavailable",
  });
});

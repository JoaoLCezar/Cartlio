import assert from "node:assert/strict";
import test from "node:test";
import { createZipStream } from "../src/lib/zip-stream.ts";

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("creates a streamed ZIP with safe unique names, stored bodies, and valid directory entries", async () => {
  const incompleteCounts = [];
  const entries = (async function* () {
    yield {
      name: "../same.txt",
      size: 5,
      open: async function* () { yield Buffer.from("hello"); },
    };
    yield {
      name: "folder\\same.txt",
      size: 6,
      open: async function* () {
        yield Buffer.from("wor");
        yield Buffer.from("ld!");
      },
    };
  })();

  const zip = await collect(createZipStream(entries, (count) => incompleteCounts.push(count)));
  const endOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(endOffset), 0x06054b50);
  assert.equal(zip.readUInt16LE(endOffset + 8), 2);

  const centralOffset = zip.readUInt32LE(endOffset + 16);
  const centralNames = [];
  let cursor = centralOffset;
  for (let index = 0; index < 2; index++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 10), 0);
    assert.equal(zip.readUInt32LE(cursor + 24), index === 0 ? 5 : 6);
    centralNames.push(zip.toString("utf8", cursor + 46, cursor + 46 + zip.readUInt16LE(cursor + 28)));

    const localOffset = zip.readUInt32LE(cursor + 42);
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const bodyOffset = localOffset + 30 + localNameLength;
    const size = zip.readUInt32LE(cursor + 24);
    assert.equal(zip.subarray(bodyOffset, bodyOffset + size).toString(), index === 0 ? "hello" : "world!");
    assert.equal(zip.readUInt32LE(cursor + 16), index === 0 ? 0x3610a686 : 0x718498e8);

    cursor += 46 + zip.readUInt16LE(cursor + 28) + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }

  assert.deepEqual(centralNames, ["001-same.txt", "002-same.txt"]);
  assert.deepEqual(incompleteCounts, []);
});

test("rejects an entry whose bytes differ from the authorized size", async () => {
  const entries = (async function* () {
    yield { name: "photo.jpg", size: 2, open: async function* () { yield Buffer.from("too long"); } };
  })();

  await assert.rejects(collect(createZipStream(entries)), /tamanho do arquivo mudou/);
});

test("reports completed files when a later ZIP entry fails", async () => {
  const incompleteCounts = [];
  const entries = (async function* () {
    yield { name: "complete.txt", size: 4, open: async function* () { yield Buffer.from("done"); } };
    yield { name: "unavailable.txt", size: 1, open: async function* () { throw new Error("Storage unavailable"); } };
  })();

  await assert.rejects(collect(createZipStream(entries, (count) => incompleteCounts.push(count))), /Storage unavailable/);
  assert.deepEqual(incompleteCounts, [1]);
});

test("reports progress when a ZIP stream is cancelled", async () => {
  const incompleteCounts = [];
  const entries = (async function* () {
    yield { name: "first.txt", size: 5, open: async function* () { yield Buffer.from("first"); } };
    yield { name: "second.txt", size: 6, open: async function* () { yield Buffer.from("second"); } };
  })();
  const reader = createZipStream(entries, (count) => incompleteCounts.push(count)).getReader();

  await reader.read();
  await reader.cancel();

  assert.deepEqual(incompleteCounts, [0]);
});

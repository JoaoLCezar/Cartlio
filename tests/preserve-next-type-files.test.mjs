import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preserveNextTypeFiles } from "../scripts/lib/preserve-next-type-files.mjs";

async function withProjectFiles(operation) {
  const projectRoot = await mkdtemp(join(tmpdir(), "cartlio-next-types-"));
  const original = new Map([
    ["next-env.d.ts", "generated next env\n"],
    ["tsconfig.json", "main config\n"],
    ["tsconfig.e2e.json", "temporary config\n"],
  ]);
  try {
    for (const [name, contents] of original) await writeFile(join(projectRoot, name), contents);
    await operation(projectRoot, original);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("preserves Next type files when a temporary build succeeds", async () => {
  await withProjectFiles(async (projectRoot, original) => {
    const result = await preserveNextTypeFiles(projectRoot, async () => {
      await writeFile(join(projectRoot, "next-env.d.ts"), "temporary route types\n");
      await writeFile(join(projectRoot, "tsconfig.json"), "temporary main config\n");
      await writeFile(join(projectRoot, "tsconfig.e2e.json"), "temporary build config\n");
      return 7;
    });

    assert.equal(result, 7);
    for (const [name, contents] of original) {
      assert.equal(await readFile(join(projectRoot, name), "utf8"), contents);
    }
  });
});

test("restores Next type files and keeps a temporary build failure", async () => {
  await withProjectFiles(async (projectRoot, original) => {
    const failure = new Error("build failed");
    await assert.rejects(preserveNextTypeFiles(projectRoot, async () => {
      await writeFile(join(projectRoot, "next-env.d.ts"), "temporary route types\n");
      await writeFile(join(projectRoot, "tsconfig.json"), "temporary main config\n");
      await writeFile(join(projectRoot, "tsconfig.e2e.json"), "temporary build config\n");
      throw failure;
    }), error => error === failure);

    for (const [name, contents] of original) {
      assert.equal(await readFile(join(projectRoot, name), "utf8"), contents);
    }
  });
});

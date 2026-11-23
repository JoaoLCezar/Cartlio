import assert from "node:assert/strict";
import test from "node:test";
import { parseUploadSessionPruneArguments } from "../scripts/lib/upload-session-retention.mjs";

test("upload-session retention requires an explicit target and bounded retention", () => {
  assert.throws(() => parseUploadSessionPruneArguments([]), /explicitamente/);
  assert.throws(() => parseUploadSessionPruneArguments(["--local", "--remote"]), /Uso:/);
  assert.throws(() => parseUploadSessionPruneArguments(["--local", "--tenant", "invalid"]), /Workspace inválido/);
  assert.throws(() => parseUploadSessionPruneArguments(["--local", "--retention-days", "29"]), /entre 30 e 365/);
  assert.throws(() => parseUploadSessionPruneArguments(["--remote", "--retention-days", "366"]), /entre 30 e 365/);
  assert.deepEqual(parseUploadSessionPruneArguments([
    "--local", "--tenant", "123E4567-E89B-12D3-A456-426614174000", "--retention-days", "180",
  ]), {
    mode: "--local", tenantId: "123e4567-e89b-12d3-a456-426614174000", retentionDays: 180,
  });
});

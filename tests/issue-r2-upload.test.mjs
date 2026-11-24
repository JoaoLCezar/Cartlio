import assert from "node:assert/strict";
import { test } from "node:test";
import { issueR2Upload } from "../scripts/lib/issue-r2-upload.mjs";

const scope = {
  tenantId: "96240000-0000-4000-8000-000000000001",
  galleryId: "96240000-0000-4000-8000-000000000002",
  uploadId: "96240000-0000-4000-8000-000000000003",
};
const actor = "96240000-0000-4000-8000-000000000004";
const reservation = { id: scope.uploadId, r2_put_authorized_at: "2026-11-23T12:00:00Z" };

function setup({ user = { id: actor }, rpcError = null } = {}) {
  const calls = [];
  return {
    calls,
    userClient: { auth: { async getUser() { calls.push("auth"); return { data: { user } }; } } },
    serviceClient: { async rpc(name, args) { calls.push([name, args]); return { data: reservation, error: rpcError }; } },
    async signUpload(received) {
      calls.push("signed");
      assert.equal(received, reservation);
      return { url: "https://example.test", method: "PUT" };
    },
  };
}

test("R2 capability is recorded with the authenticated actor before the URL can be signed", async () => {
  const api = setup();
  assert.deepEqual(await issueR2Upload(scope, api), { url: "https://example.test", method: "PUT" });
  assert.deepEqual(api.calls, ["auth", ["prepare_r2_upload_put", {
    p_actor_id: actor, p_tenant_id: scope.tenantId, p_gallery_id: scope.galleryId, p_upload_id: scope.uploadId,
  }], "signed"]);
});

test("R2 URL delivery fails closed for unauthenticated, unauthorized and ambiguous reservations", async () => {
  for (const [fixture, expected, count] of [
    [{ user: null }, "UPLOAD_CONFIRMATION_DENIED", 1],
    [{ rpcError: { message: "UPLOAD_CLOSED" } }, "UPLOAD_CLOSED", 2],
    [{ rpcError: { message: "internal database error" } }, "UPLOAD_AUTHORIZATION_UNAVAILABLE", 2],
  ]) {
    const api = setup(fixture);
    await assert.rejects(issueR2Upload(scope, api), { message: expected });
    assert.equal(api.calls.includes("signed"), false);
    assert.equal(api.calls.length, count);
  }
});
